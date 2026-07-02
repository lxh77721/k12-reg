import {createHash, randomInt, randomUUID} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdir, readFile, stat, writeFile} from "node:fs/promises";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {fetch as undiciFetch, ProxyAgent} from "undici";

type K12Route = "request" | "accept";
type TaskStatus = "queued" | "running" | "success" | "failed" | "canceled";
type LogLevel = "info" | "ok" | "warn" | "error";
type TaskKind = "k12" | "at-repair";
type JsonOutFormat = "sub2api" | "cpa";

interface AppConfig {
  port: number;
  referenceBundlePath: string;
  defaultPassword: string;
  defaultProxyUrl: string;
  openaiFetchTimeoutMs: number;
  mailApiBaseUrl: string;
  workspaceIds: string[];
  route: K12Route;
  joinIntervalMs: number;
  joinMaxRetries: number;
  taskConcurrency: number;
  runWorkspaceJoin: boolean;
  runSub2Api: boolean;
  sub2apiNoRtMode: boolean;
  sub2apiUrl: string;
  sub2apiEmail: string;
  sub2apiPassword: string;
  sub2apiGroupName: string;
  sub2apiProxyName: string;
  sub2apiAccountPriority: number;
  sub2apiConcurrency: number;
  requireChatgptAccountId: boolean;
  tokenOut: string;
  jsonOutDir: string;
  jsonOutFormat: JsonOutFormat;
}

type EmailStatus = "free" | "running" | "success" | "failed" | "banned";

interface EmailRecord {
  id: string;
  email: string;
  parentEmail?: string;
  password: string;
  mailboxUrl: string;
  clientId?: string;
  refreshToken?: string;
  raw: string;
  status: EmailStatus;
  importedAt: string;
  updatedAt: string;
  lastTaskId?: string;
  lastError?: string;
  lastAccessTokenHash?: string;
  sub2apiAccount?: string;
}

interface K12WorkspaceResult {
  workspaceId: string;
  route: K12Route;
  ok: boolean;
  status: number;
  body: string;
  attempt: number;
}

interface TaskLog {
  at: string;
  level: LogLevel;
  message: string;
}

interface K12Task {
  id: string;
  kind?: TaskKind;
  emailId: string;
  email: string;
  status: TaskStatus;
  route: K12Route;
  workspaceIds: string[];
  runWorkspaceJoin: boolean;
  runSub2Api: boolean;
  sub2apiNoRtMode?: boolean;
  sub2apiGroupName: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequested?: boolean;
  error?: string;
  accessToken?: string;
  accessTokenHash?: string;
  accessTokenPreview?: string;
  accessTokenEmail?: string;
  accessTokenExpiresAt?: string;
  accessTokenLiveness?: "unknown" | "alive" | "inactive" | "banned" | "error";
  accessTokenLivenessStatus?: number;
  accessTokenLivenessMessage?: string;
  accessTokenLivenessCheckedAt?: string;
  workspaceResults: K12WorkspaceResult[];
  sub2apiAccount?: string;
  jsonOutFile?: string;
  jsonOutFormat?: JsonOutFormat;
  logs: TaskLog[];
}

interface ParsedEmailLine {
  email: string;
  password: string;
  mailboxUrl: string;
  clientId?: string;
  refreshToken?: string;
  raw: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const configFile = path.join(dataDir, "config.json");
const emailsFile = path.join(dataDir, "emails.json");
const tasksFile = path.join(dataDir, "tasks.json");
const compatConfigFile = path.join(rootDir, "config.json");
const defaultJsonOutDir = path.join(rootDir, "json");

const DEFAULT_REFERENCE_BUNDLE = rootDir;
const DEFAULT_WORKSPACE_ID = "631e1603-06cf-4f0b-b79b-d09fbfcfe98d";
const CHATGPT_BASE_URL = "https://chatgpt.com";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTH_EMAIL_OTP_SEND_URL = `${AUTH_BASE_URL}/api/accounts/email-otp/send`;
const AUTH_PASSWORDLESS_SEND_OTP_URL = `${AUTH_BASE_URL}/api/accounts/passwordless/send-otp`;
const AUTH_CREATE_ACCOUNT_PASSWORD_URL = `${AUTH_BASE_URL}/create-account/password`;
const AUTH_ABOUT_YOU_URL = `${AUTH_BASE_URL}/about-you`;
const AUTH_WORKSPACE_URL = `${AUTH_BASE_URL}/workspace`;
const AUTH_WORKSPACE_SELECT_URL = `${AUTH_BASE_URL}/api/accounts/workspace/select`;
const AUTH_CHOOSE_ACCOUNT_URL = `${AUTH_BASE_URL}/choose-an-account`;
const CODEX_CONSENT_URL = `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`;
const DEFAULT_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CHATGPT_ACCOUNTS_CHECK_PATH = "/backend-api/accounts/check/v4-2023-04-27";
const CHATGPT_CODEX_RESPONSES_URL = `${CHATGPT_BASE_URL}/backend-api/codex/responses`;
const DEFAULT_AT_LIVENESS_MODEL = "gpt-5.5";
const SENTINEL_SDK_URL = "https://sentinel.openai.com/sentinel/20260219f9f6/sdk.js";
const SENTINEL_SDK_PATCH_HOOK = "t.init=we,t.sessionObserverToken=async function(t){";
const sentinelSdkFile = path.join(rootDir, "sdk.js");

let appConfig: AppConfig;
let emails: EmailRecord[] = [];
let tasks: K12Task[] = [];
let activeWorkers = 0;

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
  }
  return fallback;
}

function asNumber(value: unknown, fallback: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value ?? "")
    .split(/[\r\n,;，；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStringList(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

function normalizeJsonOutFormat(value: unknown): JsonOutFormat {
  return String(value || "").trim().toLowerCase() === "cpa" ? "cpa" : "sub2api";
}

function randomItem<T>(items: T[]): T | undefined {
  if (!items.length) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}

function maskSecret(value: string, head = 4, tail = 4): string {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= head + tail + 3) return `${text.slice(0, Math.min(2, text.length))}***`;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenPreview(token: string): string {
  if (!token) return "";
  return token.length <= 24 ? maskSecret(token, 8, 6) : `${token.slice(0, 18)}...${token.slice(-10)}`;
}

function stableId(value: string): string {
  return createHash("sha1").update(value.toLowerCase()).digest("hex").slice(0, 16);
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] || "";
  if (!part) return {};
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function decodeBase64UrlJson(value: string): unknown {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
}

function summarizeToken(token: string): {hash: string; preview: string; email: string; expiresAt: string; accountId: string; planType: string} {
  const payload = decodeJwtPayload(token);
  const profile = (payload["https://api.openai.com/profile"] || {}) as Record<string, unknown>;
  const auth = (payload["https://api.openai.com/auth"] || {}) as Record<string, unknown>;
  const exp = Number(payload.exp || 0);
  return {
    hash: tokenHash(token),
    preview: tokenPreview(token),
    email: asString(profile.email || payload.email),
    expiresAt: exp > 0 ? new Date(exp * 1000).toISOString() : "",
    accountId: asString(auth.chatgpt_account_id),
    planType: asString(auth.chatgpt_plan_type),
  };
}

function oauthBrowserHeaders(client: any, extra: Record<string, string> = {}): Record<string, string> {
  const profile = client?.deviceProfile || {};
  const hints = client?.clientHints || {};
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": profile.acceptLanguage || "zh-CN,zh;q=0.9,en;q=0.8",
    "user-agent": client?.userAgent || "Mozilla/5.0 K12SpaceConsole/0.1",
    ...(hints.secChUa ? {"sec-ch-ua": hints.secChUa} : {}),
    ...(hints.secChUaFullVersionList ? {"sec-ch-ua-full-version-list": hints.secChUaFullVersionList} : {}),
    ...(hints.secChUaMobile ? {"sec-ch-ua-mobile": hints.secChUaMobile} : {}),
    ...(hints.secChUaPlatform ? {"sec-ch-ua-platform": hints.secChUaPlatform} : {}),
    ...(hints.secChUaPlatformVersion ? {"sec-ch-ua-platform-version": hints.secChUaPlatformVersion} : {}),
    ...(hints.secChViewportWidth ? {"sec-ch-viewport-width": hints.secChViewportWidth} : {}),
    ...extra,
  };
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildDownloadFetchOptions(): {dispatcher?: ProxyAgent} {
  const proxyUrl = appConfig?.defaultProxyUrl || process.env.DEFAULT_PROXY_URL || process.env.OPENAI_PROXY_URL || "";
  if (!proxyUrl || proxyUrl === "direct") return {};
  return {dispatcher: new ProxyAgent(proxyUrl)};
}

async function ensureSentinelSdk(): Promise<void> {
  try {
    const existing = await readFile(sentinelSdkFile, "utf8");
    if (existing.includes(SENTINEL_SDK_PATCH_HOOK)) return;
    console.warn("本地 sdk.js 存在但版本不匹配，准备重新下载 Sentinel SDK");
  } catch {
    // Missing sdk.js is expected on first start.
  }

  console.log(`下载 Sentinel SDK: ${SENTINEL_SDK_URL}`);
  const response = await undiciFetch(SENTINEL_SDK_URL, {
    ...buildDownloadFetchOptions(),
    headers: {
      accept: "application/javascript,*/*;q=0.8",
      "user-agent": "Mozilla/5.0 K12SpaceConsole/0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`下载 Sentinel SDK 失败: HTTP ${response.status}`);
  }
  const source = await response.text();
  if (!source.includes(SENTINEL_SDK_PATCH_HOOK)) {
    throw new Error("下载的 Sentinel SDK 不含预期 patch hook，可能版本已更新");
  }
  await writeFile(sentinelSdkFile, source, "utf8");
  console.log(`Sentinel SDK 已缓存: ${sentinelSdkFile}`);
}

async function readReferenceConfig(referenceBundlePath: string): Promise<Record<string, unknown>> {
  const refConfigPath = path.join(referenceBundlePath, "codex_register", "config.json");
  return readJson<Record<string, unknown>>(refConfigPath, {});
}

async function defaultConfig(): Promise<AppConfig> {
  const referenceBundlePath = DEFAULT_REFERENCE_BUNDLE;
  const ref = await readReferenceConfig(referenceBundlePath);
  const tokenOut = path.join(rootDir, "pool_tokens.txt");
  return {
    port: asNumber(process.env.PORT, 8796, 1, 65535),
    referenceBundlePath,
    defaultPassword: asString(ref.defaultPassword, "ChangeMe123!"),
    defaultProxyUrl: asString(ref.defaultProxyUrl, ""),
    openaiFetchTimeoutMs: 45000,
    mailApiBaseUrl: asString(ref.mailApiBaseUrl, ""),
    workspaceIds: [DEFAULT_WORKSPACE_ID],
    route: "request",
    joinIntervalMs: 1500,
    joinMaxRetries: 2,
    taskConcurrency: 1,
    runWorkspaceJoin: true,
    runSub2Api: true,
    sub2apiNoRtMode: false,
    sub2apiUrl: asString(ref.sub2apiUrl, ""),
    sub2apiEmail: asString(ref.sub2apiEmail, ""),
    sub2apiPassword: asString(ref.sub2apiPassword, ""),
    sub2apiGroupName: "k12",
    sub2apiProxyName: asString(ref.sub2apiProxyName, ""),
    sub2apiAccountPriority: asNumber(ref.sub2apiAccountPriority, 1, 1),
    sub2apiConcurrency: asNumber(ref.sub2apiConcurrency, 10, 1),
    requireChatgptAccountId: true,
    tokenOut,
    jsonOutDir: defaultJsonOutDir,
    jsonOutFormat: "sub2api",
  };
}

async function loadConfig(): Promise<AppConfig> {
  const base = await defaultConfig();
  const saved = await readJson<Partial<AppConfig>>(configFile, {});
  return normalizeConfig({...base, ...saved});
}

function normalizeConfig(raw: Partial<AppConfig>): AppConfig {
  const workspaceIds = parseStringList(raw.workspaceIds).length
    ? parseStringList(raw.workspaceIds)
    : [DEFAULT_WORKSPACE_ID];
  const route = raw.route === "accept" ? "accept" : "request";
  return {
    port: asNumber(raw.port, 8796, 1, 65535),
    referenceBundlePath: DEFAULT_REFERENCE_BUNDLE,
    defaultPassword: String(raw.defaultPassword || "ChangeMe123!"),
    defaultProxyUrl: asString(raw.defaultProxyUrl),
    openaiFetchTimeoutMs: asNumber(raw.openaiFetchTimeoutMs, 45000, 5000, 300000),
    mailApiBaseUrl: asString(raw.mailApiBaseUrl),
    workspaceIds,
    route,
    joinIntervalMs: asNumber(raw.joinIntervalMs, 1500, 0, 600000),
    joinMaxRetries: asNumber(raw.joinMaxRetries, 2, 0, 10),
    taskConcurrency: asNumber(raw.taskConcurrency, 1, 1, 10),
    runWorkspaceJoin: asBoolean(raw.runWorkspaceJoin, true),
    runSub2Api: asBoolean(raw.runSub2Api, true),
    sub2apiNoRtMode: asBoolean(raw.sub2apiNoRtMode, false),
    sub2apiUrl: asString(raw.sub2apiUrl),
    sub2apiEmail: asString(raw.sub2apiEmail),
    sub2apiPassword: String(raw.sub2apiPassword || ""),
    sub2apiGroupName: asString(raw.sub2apiGroupName, "k12") || "k12",
    sub2apiProxyName: asString(raw.sub2apiProxyName),
    sub2apiAccountPriority: asNumber(raw.sub2apiAccountPriority, 1, 1),
    sub2apiConcurrency: asNumber(raw.sub2apiConcurrency, 10, 1),
    requireChatgptAccountId: asBoolean(raw.requireChatgptAccountId, true),
    tokenOut: asString(raw.tokenOut) || path.join(rootDir, "pool_tokens.txt"),
    jsonOutDir: asString(raw.jsonOutDir) || defaultJsonOutDir,
    jsonOutFormat: normalizeJsonOutFormat(raw.jsonOutFormat),
  };
}

async function saveConfig(next: AppConfig): Promise<void> {
  appConfig = normalizeConfig(next);
  await writeJson(configFile, appConfig);
  await ensureCompatBundleConfig();
}

async function ensureCompatBundleConfig(): Promise<void> {
  const existing = await readJson<Record<string, unknown>>(compatConfigFile, {});
  await writeJson(compatConfigFile, {
    ...existing,
    provider: asString(existing.provider, "hotmail"),
    defaultPassword: appConfig.defaultPassword,
    defaultProxyUrl: appConfig.defaultProxyUrl,
    mailApiBaseUrl: appConfig.mailApiBaseUrl,
    sub2apiNoRtMode: appConfig.sub2apiNoRtMode,
    sub2apiUrl: appConfig.sub2apiUrl,
    sub2apiEmail: appConfig.sub2apiEmail,
    sub2apiPassword: appConfig.sub2apiPassword,
    sub2apiGroupName: appConfig.sub2apiGroupName,
    sub2apiGroupNames: [appConfig.sub2apiGroupName],
    sub2apiProxyName: appConfig.sub2apiProxyName,
    sub2apiAccountPriority: appConfig.sub2apiAccountPriority,
    sub2apiConcurrency: appConfig.sub2apiConcurrency,
    jsonOutDir: appConfig.jsonOutDir,
    jsonOutFormat: appConfig.jsonOutFormat,
  });
}

function publicConfig(config = appConfig): Record<string, unknown> {
  return {
    ...config,
    defaultPassword: "",
    defaultPasswordPresent: Boolean(config.defaultPassword),
    defaultPasswordMasked: maskSecret(config.defaultPassword, 3, 3),
    sub2apiPassword: "",
    sub2apiPasswordPresent: Boolean(config.sub2apiPassword),
    sub2apiPasswordMasked: maskSecret(config.sub2apiPassword, 3, 3),
  };
}

function buildMicrosoftMailboxUrl(baseUrl: string, email: string, clientId: string, refreshToken: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error("mailApiBaseUrl 为空，无法为四段邮箱生成接码 URL");
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withProtocol);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/api/GetLastEmails";
  } else if (!url.pathname.endsWith("/api/GetLastEmails")) {
    url.pathname = `${url.pathname.replace(/\/+$/g, "")}/api/GetLastEmails`;
  }
  url.searchParams.set("email", email);
  url.searchParams.set("clientId", clientId);
  url.searchParams.set("refreshToken", refreshToken);
  url.searchParams.set("num", "2");
  url.searchParams.set("boxType", "1");
  return url.toString();
}

function parseEmailLine(line: string, config = appConfig): ParsedEmailLine | null {
  const raw = line.trim();
  if (!raw || raw.startsWith("#")) return null;
  const parts = raw.split(/\s*-{4,}\s*|\t|,/).map((item) => item.trim()).filter(Boolean);
  const email = parts.find((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)) || "";
  if (!email) return null;
  const emailIndex = parts.findIndex((item) => item.toLowerCase() === email.toLowerCase());
  const tail = emailIndex >= 0 ? parts.slice(emailIndex + 1) : parts.slice(1);
  const directMailboxUrl = parts.find((item) => /^https?:\/\//i.test(item)) || "";
  let password = tail.find((item) => item && !/^https?:\/\//i.test(item)) || config.defaultPassword;
  let mailboxUrl = directMailboxUrl;
  let clientId = "";
  let refreshToken = "";

  if (!mailboxUrl && tail.length >= 3) {
    password = tail[0] || password;
    clientId = tail[1] || "";
    refreshToken = tail.slice(2).join("----");
    if (clientId && refreshToken) {
      mailboxUrl = buildMicrosoftMailboxUrl(config.mailApiBaseUrl, email, clientId, refreshToken);
    }
  }

  if (!mailboxUrl) return null;
  return {email, password, mailboxUrl, clientId, refreshToken, raw};
}

function publicEmail(record: EmailRecord): Record<string, unknown> {
  return {
    id: record.id,
    email: record.email,
    parentEmail: record.parentEmail,
    passwordPresent: Boolean(record.password),
    passwordMasked: maskSecret(record.password, 3, 3),
    mailboxUrlMasked: maskMailboxUrl(record.mailboxUrl),
    status: record.status,
    importedAt: record.importedAt,
    updatedAt: record.updatedAt,
    lastTaskId: record.lastTaskId,
    lastError: record.lastError,
    lastAccessTokenHash: record.lastAccessTokenHash ? record.lastAccessTokenHash.slice(0, 12) : "",
    sub2apiAccount: record.sub2apiAccount,
  };
}

function maskMailboxUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|password|secret|key|client/i.test(key)) {
        url.searchParams.set(key, maskSecret(url.searchParams.get(key) || "", 8, 6));
      }
    }
    return url.toString();
  } catch {
    return maskSecret(value, 36, 18);
  }
}

function appendLog(task: K12Task, level: LogLevel, message: string): void {
  task.logs.push({at: nowIso(), level, message});
  if (task.logs.length > 500) task.logs.splice(0, task.logs.length - 500);
  task.updatedAt = nowIso();
  void persistTasks();
}

async function persistEmails(): Promise<void> {
  await writeJson(emailsFile, emails);
}

async function persistTasks(): Promise<void> {
  await writeJson(tasksFile, tasks);
}

function hasRunningOrQueuedTasks(items = tasks): boolean {
  return items.some((task) => task.status === "queued" || task.status === "running");
}

function normalizeImportedEmail(value: unknown): EmailRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const email = asString(record.email);
  if (!email) return null;
  const statusText = asString(record.status);
  const allowedStatuses = new Set<EmailStatus>(["free", "running", "success", "failed", "banned"]);
  const status = allowedStatuses.has(statusText as EmailStatus) ? statusText as EmailStatus : "free";
  return {
    id: asString(record.id) || stableId(email),
    email,
    parentEmail: asString(record.parentEmail) || undefined,
    password: String(record.password || ""),
    mailboxUrl: String(record.mailboxUrl || ""),
    clientId: asString(record.clientId) || undefined,
    refreshToken: asString(record.refreshToken) || undefined,
    raw: String(record.raw || email),
    status,
    importedAt: asString(record.importedAt) || nowIso(),
    updatedAt: asString(record.updatedAt) || nowIso(),
    lastTaskId: asString(record.lastTaskId) || undefined,
    lastError: asString(record.lastError) || undefined,
    lastAccessTokenHash: asString(record.lastAccessTokenHash) || undefined,
    sub2apiAccount: asString(record.sub2apiAccount) || undefined,
  };
}

function normalizeImportedTask(value: unknown): K12Task | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const emailId = asString(record.emailId);
  const email = asString(record.email);
  if (!id || !emailId || !email) return null;
  const statusText = asString(record.status);
  const allowedStatuses = new Set<TaskStatus>(["queued", "running", "success", "failed", "canceled"]);
  const route = record.route === "accept" ? "accept" : "request";
  const kind = record.kind === "at-repair" ? "at-repair" : "k12";
  const logs = Array.isArray(record.logs)
    ? record.logs
      .filter((item) => item && typeof item === "object")
      .map((item) => item as Record<string, unknown>)
      .map((item) => ({
        at: asString(item.at) || nowIso(),
        level: (["info", "ok", "warn", "error"].includes(asString(item.level)) ? asString(item.level) : "info") as LogLevel,
        message: String(item.message || ""),
      }))
    : [];
  const workspaceResults = Array.isArray(record.workspaceResults)
    ? record.workspaceResults
      .filter((item) => item && typeof item === "object")
      .map((item) => item as Record<string, unknown>)
      .map((item) => ({
        workspaceId: asString(item.workspaceId),
        route: (item.route === "accept" ? "accept" : "request") as K12Route,
        ok: asBoolean(item.ok, false),
        status: asNumber(item.status, 0),
        body: String(item.body || ""),
        attempt: asNumber(item.attempt, 0),
      }))
    : [];
  const liveness = asString(record.accessTokenLiveness);
  const allowedLiveness = new Set(["unknown", "alive", "inactive", "banned", "error"]);
  return {
    id,
    kind,
    emailId,
    email,
    status: allowedStatuses.has(statusText as TaskStatus) ? statusText as TaskStatus : "failed",
    route,
    workspaceIds: parseStringList(record.workspaceIds),
    runWorkspaceJoin: asBoolean(record.runWorkspaceJoin, true),
    runSub2Api: asBoolean(record.runSub2Api, true),
    sub2apiNoRtMode: asBoolean(record.sub2apiNoRtMode, false),
    sub2apiGroupName: asString(record.sub2apiGroupName, appConfig.sub2apiGroupName) || "k12",
    createdAt: asString(record.createdAt) || nowIso(),
    updatedAt: asString(record.updatedAt) || nowIso(),
    startedAt: asString(record.startedAt) || undefined,
    finishedAt: asString(record.finishedAt) || undefined,
    cancelRequested: asBoolean(record.cancelRequested, false) || undefined,
    error: asString(record.error) || undefined,
    accessToken: String(record.accessToken || ""),
    accessTokenHash: asString(record.accessTokenHash) || undefined,
    accessTokenPreview: asString(record.accessTokenPreview) || undefined,
    accessTokenEmail: asString(record.accessTokenEmail) || undefined,
    accessTokenExpiresAt: asString(record.accessTokenExpiresAt) || undefined,
    accessTokenLiveness: allowedLiveness.has(liveness) ? liveness as K12Task["accessTokenLiveness"] : undefined,
    accessTokenLivenessStatus: record.accessTokenLivenessStatus === undefined ? undefined : asNumber(record.accessTokenLivenessStatus, 0),
    accessTokenLivenessMessage: asString(record.accessTokenLivenessMessage) || undefined,
    accessTokenLivenessCheckedAt: asString(record.accessTokenLivenessCheckedAt) || undefined,
    workspaceResults,
    sub2apiAccount: asString(record.sub2apiAccount) || undefined,
    jsonOutFile: asString(record.jsonOutFile) || undefined,
    jsonOutFormat: record.jsonOutFormat ? normalizeJsonOutFormat(record.jsonOutFormat) : undefined,
    logs,
  };
}

async function buildDataExport(): Promise<Record<string, unknown>> {
  return {
    app: "gpt-k12",
    version: 1,
    exportedAt: nowIso(),
    config: appConfig,
    emails,
    tasks,
    tokenOutFileName: path.basename(appConfig.tokenOut || "pool_tokens.txt"),
    tokenOut: await readFile(appConfig.tokenOut, "utf8").catch(() => ""),
    summary: summary(),
  };
}

async function backupCurrentDataBeforeImport(): Promise<string> {
  const backupDir = path.join(dataDir, "backups");
  await mkdir(backupDir, {recursive: true});
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(backupDir, `before-import-${stamp}.json`);
  await writeJson(backupFile, await buildDataExport());
  return backupFile;
}

async function importDataBundle(bundle: Record<string, unknown>): Promise<{emails: number; tasks: number; tokenOut: boolean; backupFile: string}> {
  if (hasRunningOrQueuedTasks()) throw new Error("当前还有运行中或队列任务，不能导入数据");

  const importedEmails = Array.isArray(bundle.emails) ? bundle.emails.map(normalizeImportedEmail).filter(Boolean) as EmailRecord[] : [];
  const importedTasks = Array.isArray(bundle.tasks) ? bundle.tasks.map(normalizeImportedTask).filter(Boolean) as K12Task[] : [];
  if (hasRunningOrQueuedTasks(importedTasks)) throw new Error("导入包里包含运行中或队列任务，请先清理后再导入");

  const importedConfig = bundle.config && typeof bundle.config === "object"
    ? normalizeConfig({...appConfig, ...bundle.config as Partial<AppConfig>, tokenOut: appConfig.tokenOut})
    : appConfig;
  const backupFile = await backupCurrentDataBeforeImport();

  appConfig = importedConfig;
  emails = importedEmails;
  tasks = importedTasks;
  activeWorkers = 0;

  await Promise.all([
    saveConfig(appConfig),
    persistEmails(),
    persistTasks(),
  ]);

  const tokenText = typeof bundle.tokenOut === "string" ? bundle.tokenOut : "";
  if (tokenText) {
    await mkdir(path.dirname(appConfig.tokenOut), {recursive: true});
    await writeFile(appConfig.tokenOut, tokenText, "utf8");
  }

  return {emails: emails.length, tasks: tasks.length, tokenOut: Boolean(tokenText), backupFile};
}

async function importEmails(text: string, config = appConfig): Promise<{added: number; updated: number; skipped: number; invalid: number; inputLines: number; total: number; invalidSamples: string[]}> {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let invalid = 0;
  const invalidSamples: string[] = [];
  const byEmail = new Map(emails.map((item) => [item.email.toLowerCase(), item]));
  const seenInBatch = new Set<string>();

  for (const line of lines) {
    let parsed: ParsedEmailLine | null = null;
    try {
      parsed = parseEmailLine(line, config);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      invalid += 1;
      if (invalidSamples.length < 5) invalidSamples.push(line.slice(0, 180));
      continue;
    }

    const key = parsed.email.toLowerCase();
    if (seenInBatch.has(key)) {
      skipped += 1;
      continue;
    }
    seenInBatch.add(key);

    const existing = byEmail.get(key);
    if (existing) {
      existing.password = parsed.password;
      existing.mailboxUrl = parsed.mailboxUrl;
      existing.clientId = parsed.clientId;
      existing.refreshToken = parsed.refreshToken;
      existing.raw = parsed.raw;
      existing.updatedAt = nowIso();
      if (existing.status === "free") existing.lastError = "";
      updated += 1;
    } else {
      const record: EmailRecord = {
        id: stableId(parsed.email),
        email: parsed.email,
        password: parsed.password,
        mailboxUrl: parsed.mailboxUrl,
        clientId: parsed.clientId,
        refreshToken: parsed.refreshToken,
        raw: parsed.raw,
        status: "free",
        importedAt: nowIso(),
        updatedAt: nowIso(),
      };
      emails.push(record);
      byEmail.set(key, record);
      added += 1;
    }
  }
  await persistEmails();
  return {added, updated, skipped, invalid, inputLines: lines.length, total: emails.length, invalidSamples};
}

function hasActiveTask(emailId: string): boolean {
  return tasks.some((task) => task.emailId === emailId && (task.status === "queued" || task.status === "running"));
}

function removeEmails(ids: string[]): {removed: number; skippedRunning: number; missing: number} {
  const requested = new Set(ids.filter(Boolean));
  if (!requested.size) return {removed: 0, skippedRunning: 0, missing: 0};

  let removed = 0;
  let skippedRunning = 0;
  let missing = 0;
  const existingIds = new Set(emails.map((item) => item.id));
  for (const id of requested) {
    if (!existingIds.has(id)) missing += 1;
  }

  emails = emails.filter((email) => {
    if (!requested.has(email.id)) return true;
    if (email.status === "running" || hasActiveTask(email.id)) {
      skippedRunning += 1;
      return true;
    }
    removed += 1;
    return false;
  });

  return {removed, skippedRunning, missing};
}

function rootMailboxIdentity(email: EmailRecord): string {
  return (email.parentEmail || email.email).toLowerCase();
}

function rootMailboxIdentityByEmailId(emailId: string): string {
  const email = emails.find((item) => item.id === emailId);
  return email ? rootMailboxIdentity(email) : emailId;
}

function randomAliasSuffix(length = 6): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}

function buildPlusAlias(email: string, suffix: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) throw new Error(`邮箱格式不正确，不能分裂: ${email}`);
  const baseLocal = local.split("+")[0];
  return `${baseLocal}+${suffix}@${domain}`;
}

function splitEmails(ids: string[], perParent: number): {created: number; skipped: number; items: Array<{parentEmail: string; email: string}>} {
  const requested = new Set(ids.filter(Boolean));
  const byEmail = new Set(emails.map((item) => item.email.toLowerCase()));
  const processedParents = new Set<string>();
  const createdItems: Array<{parentEmail: string; email: string}> = [];
  let skipped = 0;

  for (const parent of emails.filter((item) => requested.has(item.id))) {
    const parentEmail = rootMailboxIdentity(parent);
    if (processedParents.has(parentEmail)) {
      skipped += 1;
      continue;
    }
    processedParents.add(parentEmail);
    if (parent.status === "running" || hasActiveTask(parent.id)) {
      skipped += 1;
      continue;
    }
    for (let i = 0; i < perParent; i += 1) {
      let alias = "";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        alias = buildPlusAlias(parentEmail, randomAliasSuffix(6));
        if (!byEmail.has(alias.toLowerCase())) break;
        alias = "";
      }
      if (!alias) {
        skipped += 1;
        continue;
      }
      const record: EmailRecord = {
        id: stableId(alias),
        email: alias,
        parentEmail,
        password: parent.password,
        mailboxUrl: parent.mailboxUrl,
        clientId: parent.clientId,
        refreshToken: parent.refreshToken,
        raw: `${alias}----alias-of----${parentEmail}`,
        status: "free",
        importedAt: nowIso(),
        updatedAt: nowIso(),
      };
      emails.push(record);
      byEmail.add(alias.toLowerCase());
      createdItems.push({parentEmail, email: alias});
    }
  }

  return {created: createdItems.length, skipped, items: createdItems.slice(0, 40)};
}

async function loadBundleModules() {
  await ensureCompatBundleConfig();
  const srcDir = path.join(appConfig.referenceBundlePath, "codex_register", "src");
  const openaiPath = pathToFileURL(path.join(srcDir, "openai.ts")).href;
  const devicePath = pathToFileURL(path.join(srcDir, "device-profile.ts")).href;
  const sub2ApiPath = pathToFileURL(path.join(srcDir, "sub2api.ts")).href;
  const mailboxPath = pathToFileURL(path.join(srcDir, "mailbox-url.ts")).href;
  const [openai, device, sub2api, mailbox] = await Promise.all([
    import(openaiPath),
    import(devicePath),
    import(sub2ApiPath),
    import(mailboxPath),
  ]);
  return {
    OpenAIClient: openai.OpenAIClient,
    generateRandomDeviceProfile: device.generateRandomDeviceProfile,
    Sub2ApiClient: sub2api.Sub2ApiClient,
    MailboxUrlCodeProvider: mailbox.MailboxUrlCodeProvider,
  };
}

function assertNotCanceled(task: K12Task): void {
  if (task.cancelRequested) {
    throw new Error("任务已取消");
  }
}

function isAddPhoneUrl(value: string): boolean {
  return value.startsWith(`${AUTH_BASE_URL}/add-phone`);
}

function isAddPhoneFlowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\/add-phone|add-phone/i.test(message);
}

function isInvalidPasswordError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String((error as {message?: unknown}).message || "")
      : String(error);
  return /invalid_username_or_password|Login failed|PasswordVerify/i.test(message);
}

function isInvalidAuthStateError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String((error as {message?: unknown}).message || "")
      : String(error);
  return /invalid_state|invalid_auth_step|Invalid authorization step|sign-in session is no longer valid/i.test(message);
}

function isOpenAiAccountBannedMessage(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value || "");
  return /account_deactivated|account disabled|account has been (?:deleted|deactivated|disabled|suspended)|account.*(?:suspended|banned|terminated|deactivated|disabled)|user.*(?:suspended|banned|deactivated|disabled)|账号已停用|账户已停用|账号已被删除|账户已被删除|账号已封|账号被封|封号|被封禁|停用/i.test(message);
}

function isEmailOtpSendStepError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String((error as {message?: unknown}).message || "")
      : String(error);
  return message.includes(AUTH_EMAIL_OTP_SEND_URL) || /email-otp\/send/i.test(message);
}

function authStepFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const knownSteps = [
    `${AUTH_BASE_URL}/log-in/password`,
    AUTH_CREATE_ACCOUNT_PASSWORD_URL,
    AUTH_EMAIL_OTP_SEND_URL,
    `${AUTH_BASE_URL}/email-verification`,
    AUTH_ABOUT_YOU_URL,
    `${AUTH_BASE_URL}/add-phone`,
    `${AUTH_BASE_URL}/add-email`,
    CODEX_CONSENT_URL,
  ];
  return knownSteps.find((step) => message.includes(step)) || "";
}

function normalizeFlowError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isOpenAiAccountBannedMessage(message)) return "GPT 账号已被 OpenAI 停用/封禁";
  if (isAddPhoneFlowError(error)) {
    return "登录后触发 add-phone 手机接码页面，按 K12 规则判定失败";
  }
  return message;
}

async function sleep(ms: number): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendK12Invite(task: K12Task, client: any, accessToken: string, workspaceId: string, route: K12Route): Promise<K12WorkspaceResult> {
  let last: K12WorkspaceResult | null = null;
  for (let attempt = 1; attempt <= appConfig.joinMaxRetries + 1; attempt += 1) {
    assertNotCanceled(task);
    const url = `https://chatgpt.com/backend-api/accounts/${encodeURIComponent(workspaceId)}/invites/${route}`;
    appendLog(task, "info", `K12 ${route}: POST ${workspaceId.slice(0, 8)}... 第 ${attempt} 次`);
    try {
      const response = await client.fetch(url, {
        method: "POST",
        headers: {
          accept: "*/*",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          origin: CHATGPT_BASE_URL,
          referer: `${CHATGPT_BASE_URL}/`,
          "oai-device-id": randomUUID(),
          "oai-language": "zh-CN",
          "user-agent": "Mozilla/5.0 K12SpaceConsole/0.1",
        },
        body: "",
      });
      const body = await response.text();
      last = {
        workspaceId,
        route,
        ok: response.ok,
        status: response.status,
        body: body.slice(0, 500),
        attempt,
      };
      if (response.ok) {
        appendLog(task, "ok", `K12 ${workspaceId.slice(0, 8)}... HTTP ${response.status}`);
        return last;
      }
      appendLog(task, "warn", `K12 ${workspaceId.slice(0, 8)}... HTTP ${response.status}: ${body.slice(0, 180)}`);
    } catch (error) {
      last = {workspaceId, route, ok: false, status: 0, body: error instanceof Error ? error.message : String(error), attempt};
      appendLog(task, "warn", `K12 ${workspaceId.slice(0, 8)}... 网络错误: ${last.body}`);
    }
    if (attempt <= appConfig.joinMaxRetries) await sleep(appConfig.joinIntervalMs * attempt);
  }
  return last || {workspaceId, route, ok: false, status: 0, body: "未执行", attempt: 0};
}

async function appendTokenOut(token: string): Promise<void> {
  const filePath = appConfig.tokenOut;
  if (!filePath || !token) return;
  await mkdir(path.dirname(filePath), {recursive: true});
  const existing = await readFile(filePath, "utf8").catch(() => "");
  if (existing.includes(token)) return;
  await writeFile(filePath, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${token}\n`, "utf8");
}

async function hydrateTaskAccessTokensFromTokenOut(): Promise<boolean> {
  const filePath = appConfig.tokenOut;
  if (!filePath) return false;
  const raw = await readFile(filePath, "utf8").catch(() => "");
  const tokens = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!tokens.length) return false;

  let changed = false;
  for (const token of tokens) {
    const info = summarizeToken(token);
    if (!info.hash) continue;
    for (const task of tasks) {
      if (task.accessToken) continue;
      if (task.accessTokenHash && task.accessTokenHash === info.hash) {
        task.accessToken = token;
        changed = true;
        continue;
      }
      if (task.accessTokenPreview && task.accessTokenPreview === info.preview) {
        task.accessToken = token;
        task.accessTokenHash ||= info.hash;
        changed = true;
      }
    }
  }
  return changed;
}

async function ensureChatGptCsrfCookie(client: any): Promise<void> {
  if (typeof client.readCookie !== "function") return;
  const existing = await client.readCookie(CHATGPT_BASE_URL, "__Host-next-auth.csrf-token").catch(() => "");
  if (existing) return;

  await client.fetch(`${CHATGPT_BASE_URL}/api/auth/csrf`, {
    method: "GET",
    headers: oauthBrowserHeaders(client, {
      accept: "application/json",
      referer: `${CHATGPT_BASE_URL}/`,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    }),
  }).catch(() => undefined);
}

async function sendEmailOtpForLogin(client: any, referer = `${AUTH_BASE_URL}/log-in/password`): Promise<string> {
  const response = await client.fetch(AUTH_PASSWORDLESS_SEND_OTP_URL, {
    method: "POST",
    headers: oauthBrowserHeaders(client, {
      accept: "application/json",
      "content-type": "application/json",
      origin: AUTH_BASE_URL,
      referer,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`PasswordlessSendOtp 请求失败: HTTP ${response.status} ${body.slice(0, 500)}`);
  }
  const payload = (await response.json()) as {continue_url?: string; page?: {payload?: {url?: string}}};
  const nextUrl = String(payload.page?.payload?.url || payload.continue_url || `${AUTH_BASE_URL}/email-verification`);
  return new URL(nextUrl, AUTH_BASE_URL).toString();
}

async function sendEmailOtpForSignup(client: any, referer = AUTH_CREATE_ACCOUNT_PASSWORD_URL): Promise<string> {
  const response = await client.fetch(AUTH_EMAIL_OTP_SEND_URL, {
    method: "GET",
    headers: oauthBrowserHeaders(client, {
      accept: "application/json",
      referer,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`EmailOtpSendSignup 请求失败: HTTP ${response.status} ${body.slice(0, 500)}`);
  }
  const payload = (await response.json()) as {continue_url?: string};
  return String(payload.continue_url || "");
}

function randomProfile(): {name: string; birthdate: string} {
  const firstNames = [
    "Ethan",
    "Noah",
    "Liam",
    "Mason",
    "Lucas",
    "Logan",
    "Owen",
    "Ryan",
    "Leo",
    "Adam",
    "Ella",
    "Ava",
    "Mia",
    "Luna",
    "Chloe",
    "Grace",
    "Ruby",
    "Nora",
    "Ivy",
    "Sofia",
  ];
  const lastNames = [
    "Smith",
    "Brown",
    "Taylor",
    "Walker",
    "Wilson",
    "Clark",
    "Hall",
    "Young",
    "Allen",
    "King",
    "Scott",
    "Green",
    "Baker",
    "Adams",
    "Turner",
  ];
  const pick = (items: string[]) => items[Math.floor(Math.random() * items.length)];
  const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
  const age = randomInt(25, 34);
  const today = new Date();
  const birthYear = today.getFullYear() - age;
  const birthMonth = randomInt(1, 12);
  const maxDay = new Date(birthYear, birthMonth, 0).getDate();
  const birthDay = randomInt(1, maxDay);
  return {
    name: `${pick(firstNames)} ${pick(lastNames)}`,
    birthdate: [
      birthYear,
      `${birthMonth}`.padStart(2, "0"),
      `${birthDay}`.padStart(2, "0"),
    ].join("-"),
  };
}

async function readAuthJsonResponse(response: Response): Promise<{continue_url?: string; page?: {payload?: {url?: string}}}> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`CreateAccount 请求失败: HTTP ${response.status} ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as {continue_url?: string; page?: {payload?: {url?: string}}};
  } catch {
    throw new Error(`CreateAccount 响应不是 JSON: ${text.slice(0, 300)}`);
  }
}

async function completeAboutYou(client: any, task?: K12Task): Promise<string> {
  const profile = randomProfile();
  if (task) appendLog(task, "info", `about-you 创建资料: ${profile.name}, ${profile.birthdate}`);
  const sentinelToken = typeof client.fetchSentinelToken === "function"
    ? await client.fetchSentinelToken("oauth_create_account")
    : "";
  const response = await client.fetch(`${AUTH_BASE_URL}/api/accounts/create_account`, {
    method: "POST",
    headers: oauthBrowserHeaders(client, {
      accept: "application/json",
      "content-type": "application/json",
      origin: AUTH_BASE_URL,
      referer: AUTH_ABOUT_YOU_URL,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      ...(sentinelToken ? {"openai-sentinel-token": sentinelToken} : {}),
    }),
    body: JSON.stringify(profile),
  });
  const payload = await readAuthJsonResponse(response);
  return String(payload.page?.payload?.url || payload.continue_url || "");
}

async function selectAuthWorkspace(client: any, task?: K12Task, referer = AUTH_WORKSPACE_URL): Promise<string> {
  const workspaceIds = task ? targetK12WorkspaceIds(task) : appConfig.workspaceIds;
  const candidates = Array.from(new Set([...workspaceIds, "default", "personal"].filter(Boolean)));
  let lastError = "";

  for (const workspaceId of candidates) {
    if (task) appendLog(task, "info", `auth workspace/select: ${workspaceId}`);
    const response = await client.fetch(AUTH_WORKSPACE_SELECT_URL, {
      method: "POST",
      headers: oauthBrowserHeaders(client, {
        accept: "application/json",
        "content-type": "application/json",
        origin: AUTH_BASE_URL,
        referer,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      }),
      body: JSON.stringify({workspace_id: workspaceId}),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      lastError = `workspace_id=${workspaceId} HTTP ${response.status}: ${text.slice(0, 240)}`;
      if (task) appendLog(task, "warn", lastError);
      continue;
    }
    try {
      const data = JSON.parse(text) as {continue_url?: string; page?: {payload?: {url?: string}}};
      const nextUrl = String(data.page?.payload?.url || data.continue_url || "");
      if (nextUrl) return new URL(nextUrl, AUTH_BASE_URL).toString();
      lastError = `workspace_id=${workspaceId} 响应缺少 continue_url: ${text.slice(0, 240)}`;
    } catch {
      lastError = `workspace_id=${workspaceId} 非 JSON 响应: ${text.slice(0, 240)}`;
    }
    if (task) appendLog(task, "warn", lastError);
  }

  throw new Error(`auth workspace/select 失败: ${lastError || "unknown"}`);
}

async function finishChatGptCallback(client: any, callbackUrl: string, task?: K12Task, referer = AUTH_BASE_URL): Promise<void> {
  const log = (level: LogLevel, message: string) => {
    if (task) appendLog(task, level, message);
  };
  log("info", "完成 ChatGPT callback，建立 Web session");
  const response = await client.fetch(callbackUrl, {
    method: "GET",
    redirect: "follow",
    headers: oauthBrowserHeaders(client, {
      referer,
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-site",
    }),
  });
  if (!response.ok) {
    throw new Error(`完成 ChatGPT callback 失败: HTTP ${response.status}`);
  }
}

async function continueAuthSteps(
  client: any,
  startUrl: string,
  task: K12Task | undefined,
  options: {finishChatGptCallback?: boolean; allowConsent?: boolean} = {},
): Promise<string> {
  const log = (level: LogLevel, message: string) => {
    if (task) appendLog(task, level, message);
  };
  let continueUrl = startUrl;

  for (let step = 0; step < 12; step += 1) {
    log("info", `OpenAI auth step: ${continueUrl}`);

    if (continueUrl === `${AUTH_BASE_URL}/log-in/password`) {
      log("warn", "当前账号进入密码页；按配置不提交密码，尝试改走邮箱验证码登录");
      try {
        continueUrl = await sendEmailOtpForLogin(client, `${AUTH_BASE_URL}/log-in/password`);
      } catch (error) {
        throw new Error(
          `账号当前被 OpenAI 判定为密码登录步骤，已按配置尝试邮箱验证码登录，但 OpenAI 未允许发送邮箱验证码；该账号无法仅凭邮箱接码登录。原始错误：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!continueUrl) {
        throw new Error("账号当前被 OpenAI 判定为密码登录步骤，已按配置尝试邮箱验证码登录，但 OpenAI 未返回下一步 continue_url");
      }
      continue;
    }

    if (continueUrl === AUTH_CREATE_ACCOUNT_PASSWORD_URL) {
      log("info", "新增邮箱账号要求创建密码，提交默认密码后继续");
      if (typeof client.registerPassword !== "function") {
        throw new Error("新增账号需要创建密码，但参考 OpenAIClient 未暴露 registerPassword()");
      }
      continueUrl = await client.registerPassword();
      continue;
    }

    if (continueUrl === AUTH_EMAIL_OTP_SEND_URL) {
      log("info", "OpenAI 要求发送邮箱验证码");
      continueUrl = await sendEmailOtpForSignup(client, AUTH_CREATE_ACCOUNT_PASSWORD_URL);
      continue;
    }

    if (continueUrl === `${AUTH_BASE_URL}/email-verification`) {
      log("info", "等待邮箱验证码并提交");
      continueUrl = await client.emailOtpValidate();
      continue;
    }

    if (continueUrl === AUTH_ABOUT_YOU_URL) {
      log("info", "首次登录要求填写基础资料");
      continueUrl = await completeAboutYou(client, task);
      continue;
    }

    if (continueUrl === AUTH_WORKSPACE_URL || continueUrl.startsWith(`${AUTH_WORKSPACE_URL}?`)) {
      log("info", "登录要求选择 workspace，优先选择配置的 K12 空间");
      continueUrl = await selectAuthWorkspace(client, task, continueUrl);
      continue;
    }

    if (continueUrl === `${AUTH_BASE_URL}/add-phone`) {
      throw new Error("登录后触发 add-phone 手机接码页面，按 K12 规则判定失败");
    }

    if (continueUrl === `${AUTH_BASE_URL}/add-email`) {
      throw new Error("登录触发 add-email；K12 当前流程使用邮箱账号登录，未配置额外绑定邮箱");
    }

    if (options.allowConsent && continueUrl.startsWith(CODEX_CONSENT_URL)) {
      continueUrl = await continueCodexConsent(client, continueUrl, task);
      continue;
    }

    if (options.finishChatGptCallback && continueUrl.startsWith(`${CHATGPT_BASE_URL}/api/auth/callback/openai`)) {
      await finishChatGptCallback(client, continueUrl, task, AUTH_ABOUT_YOU_URL);
      return continueUrl;
    }

    return continueUrl;
  }

  throw new Error(`OpenAI auth step 处理次数过多，最后停在 ${continueUrl}`);
}

async function loginAuthFlowWithEmailOtp(
  client: any,
  task: K12Task | undefined,
  options: {finishChatGptCallback?: boolean; allowConsent?: boolean} = {},
): Promise<string> {
  let continueUrl = await client.authorizeContinue();
  return continueAuthSteps(client, continueUrl, task, options);
}

async function loginChatGptWebAndGetAccessToken(client: any, task: K12Task, emailAddress: string): Promise<string> {
  assertNotCanceled(task);
  appendLog(task, "info", `登录 ChatGPT Web session: ${emailAddress}`);
  await ensureChatGptCsrfCookie(client);
  try {
    await client.authLoginChatGPTWeb();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isInvalidAuthStateError(error)) {
      appendLog(task, "warn", "登录 auth session 已失效，重新打开 ChatGPT auth 入口后接管流程");
      const nextUrl = await openChatGptAuthEntryForWorkspaceSwitch(client, task);
      await continueAuthSteps(client, nextUrl, task, {finishChatGptCallback: true});
    } else if (isInvalidPasswordError(error)) {
      appendLog(task, "warn", "登录流程进入密码验证失败；按配置改走邮箱验证码登录");
      await continueAuthSteps(client, `${AUTH_BASE_URL}/log-in/password`, task, {finishChatGptCallback: true});
    } else if (isEmailOtpSendStepError(error)) {
      appendLog(task, "warn", "登录流程要求邮箱验证码，开始邮件接码");
      await continueAuthSteps(client, authStepFromError(error) || AUTH_EMAIL_OTP_SEND_URL, task, {finishChatGptCallback: true});
    } else if (message.includes(AUTH_WORKSPACE_URL)) {
      appendLog(task, "warn", "登录流程停在 workspace 选择页，自动选择 K12 空间");
      await continueAuthSteps(client, AUTH_WORKSPACE_URL, task, {finishChatGptCallback: true});
    } else if (authStepFromError(error)) {
      appendLog(task, "warn", `接管 OpenAI auth step: ${authStepFromError(error)}`);
      await continueAuthSteps(client, authStepFromError(error), task, {finishChatGptCallback: true});
    } else if (!/__Host-next-auth\.csrf-token|csrf-token/i.test(message)) {
      throw error;
    } else {
      appendLog(task, "warn", "首次未拿到 ChatGPT csrf cookie，刷新 /api/auth/csrf 后重试一次");
      await client.fetch(`${CHATGPT_BASE_URL}/api/auth/csrf`, {
        method: "GET",
        headers: oauthBrowserHeaders(client, {
          accept: "application/json",
          referer: `${CHATGPT_BASE_URL}/`,
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        }),
      });
      try {
        await client.authLoginChatGPTWeb();
      } catch (retryError) {
        if (isInvalidAuthStateError(retryError)) {
          appendLog(task, "warn", "重试后 auth session 仍失效，重新打开 ChatGPT auth 入口后接管流程");
          const nextUrl = await openChatGptAuthEntryForWorkspaceSwitch(client, task);
          await continueAuthSteps(client, nextUrl, task, {finishChatGptCallback: true});
          return String(await client.getChatGPTAccessToken());
        }
        if (isEmailOtpSendStepError(retryError)) {
          appendLog(task, "warn", "重试后进入邮箱验证码流程，开始邮件接码");
          await continueAuthSteps(client, authStepFromError(retryError) || AUTH_EMAIL_OTP_SEND_URL, task, {finishChatGptCallback: true});
          return String(await client.getChatGPTAccessToken());
        }
        if (String(retryError instanceof Error ? retryError.message : retryError).includes(AUTH_WORKSPACE_URL)) {
          appendLog(task, "warn", "重试后停在 workspace 选择页，自动选择 K12 空间");
          await continueAuthSteps(client, AUTH_WORKSPACE_URL, task, {finishChatGptCallback: true});
          return String(await client.getChatGPTAccessToken());
        }
        if (authStepFromError(retryError)) {
          appendLog(task, "warn", `重试后接管 OpenAI auth step: ${authStepFromError(retryError)}`);
          await continueAuthSteps(client, authStepFromError(retryError), task, {finishChatGptCallback: true});
          return String(await client.getChatGPTAccessToken());
        }
        if (!isInvalidPasswordError(retryError)) throw retryError;
        appendLog(task, "warn", "重试后仍进入密码验证失败；按配置改走邮箱验证码登录");
        await continueAuthSteps(client, `${AUTH_BASE_URL}/log-in/password`, task, {finishChatGptCallback: true});
        return String(await client.getChatGPTAccessToken());
      }
    }
  }
  appendLog(task, "info", "读取 https://chatgpt.com/api/auth/session accessToken");
  return String(await client.getChatGPTAccessToken());
}

function extractAccessTokenFromCredentials(credentials: Record<string, unknown>): string {
  return String(credentials.access_token || credentials.accessToken || "").trim();
}

function recordAccessToken(task: K12Task, email: EmailRecord, accessToken: string): void {
  const tokenInfo = summarizeToken(accessToken);
  task.accessToken = accessToken;
  task.accessTokenHash = tokenInfo.hash;
  task.accessTokenPreview = tokenInfo.preview;
  task.accessTokenEmail = tokenInfo.email || email.email;
  task.accessTokenExpiresAt = tokenInfo.expiresAt;
  email.lastAccessTokenHash = tokenInfo.hash;
  appendLog(task, "ok", `AT 获取成功: ${tokenInfo.preview} plan=${tokenInfo.planType || "?"} account=${tokenInfo.accountId ? tokenInfo.accountId.slice(0, 8) : "?"}`);
}

function markEmailBanned(email: EmailRecord, reason: string, task?: K12Task): void {
  email.status = "banned";
  email.lastError = reason;
  email.updatedAt = nowIso();
  for (const queuedTask of tasks) {
    if (queuedTask.emailId !== email.id || queuedTask.id === task?.id || queuedTask.status !== "queued") continue;
    queuedTask.status = "failed";
    queuedTask.error = reason;
    queuedTask.finishedAt = nowIso();
    queuedTask.updatedAt = nowIso();
    appendLog(queuedTask, "error", `当前邮箱记录已标记 GPT 封号，队列任务跳过: ${reason}`);
  }
  if (task) {
    task.error = reason;
    task.updatedAt = nowIso();
    appendLog(task, "error", `当前邮箱记录已标记 GPT 封号: ${reason}`);
  }
}

function normalizeChatGptUserId(auth: Record<string, unknown>): string {
  const direct = asString(auth.chatgpt_user_id || auth.user_id);
  if (direct) return direct;
  const accountUserId = asString(auth.chatgpt_account_user_id);
  return accountUserId.includes("__") ? accountUserId.split("__")[0] : accountUserId;
}

function targetK12WorkspaceIds(task: K12Task): string[] {
  return Array.from(new Set((task.workspaceIds.length ? task.workspaceIds : appConfig.workspaceIds)
    .map((item) => item.trim())
    .filter(Boolean)));
}

function isK12AccessToken(accessToken: string, task: K12Task): boolean {
  const tokenInfo = summarizeToken(accessToken);
  const plan = tokenInfo.planType.toLowerCase();
  const targetIds = new Set(targetK12WorkspaceIds(task).map((item) => item.toLowerCase()));
  return plan === "k12" || (!!tokenInfo.accountId && targetIds.has(tokenInfo.accountId.toLowerCase()));
}

function describeAccessTokenContext(accessToken: string): string {
  const tokenInfo = summarizeToken(accessToken);
  return `plan=${tokenInfo.planType || "?"} account=${tokenInfo.accountId || "?"} email=${tokenInfo.email || "?"}`;
}

function safeUrlForLog(value: string): string {
  try {
    const url = new URL(value, AUTH_BASE_URL);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.length > 120 ? `${value.slice(0, 120)}...` : value;
  }
}

async function readChatGptSessionAccessToken(client: any, task: K12Task, reason: string): Promise<string> {
  appendLog(task, "info", `重新读取 ChatGPT Web AT: ${reason}`);
  const token = String(await client.getChatGPTAccessToken());
  appendLog(task, "info", `当前 Web AT 上下文: ${describeAccessTokenContext(token)}`);
  return token;
}

function findWorkspaceInAccountsCheck(payload: unknown, workspaceId: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  const accounts = data.accounts;
  if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
    const direct = (accounts as Record<string, unknown>)[workspaceId];
    if (direct && typeof direct === "object") return direct as Record<string, unknown>;
  }
  if (Array.isArray(accounts)) {
    for (const item of accounts) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const account = (record.account && typeof record.account === "object" ? record.account : record) as Record<string, unknown>;
      const id = asString(account.account_id || account.id || record.id);
      if (id === workspaceId) return record;
    }
  }
  return null;
}

async function checkK12WorkspaceMembership(client: any, task: K12Task, accessToken: string, workspaceId: string): Promise<boolean> {
  const tokenInfo = summarizeToken(accessToken);
  const payload = decodeJwtPayload(accessToken);
  const sessionId = asString(payload.session_id, randomUUID());
  const response = await client.fetch(`${CHATGPT_BASE_URL}${CHATGPT_ACCOUNTS_CHECK_PATH}`, {
    method: "GET",
    headers: oauthBrowserHeaders(client, {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      ...(tokenInfo.accountId ? {"chatgpt-account-id": tokenInfo.accountId} : {}),
      "oai-device-id": client?.deviceID || randomUUID(),
      "oai-language": "zh-CN",
      "oai-session-id": sessionId,
      "x-openai-target-path": CHATGPT_ACCOUNTS_CHECK_PATH,
      "x-openai-target-route": "/backend-api/accounts/check/{version}",
      referer: `${CHATGPT_BASE_URL}/`,
      origin: CHATGPT_BASE_URL,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    }),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    appendLog(task, "warn", `K12 accounts/check 验证失败 HTTP ${response.status}: ${text.slice(0, 180)}`);
    return false;
  }
  try {
    const data = JSON.parse(text) as unknown;
    const workspace = findWorkspaceInAccountsCheck(data, workspaceId);
    if (workspace) {
      appendLog(task, "ok", `K12 accounts/check 已确认 workspace ${workspaceId.slice(0, 8)}... 可见`);
      return true;
    }
    appendLog(task, "warn", `K12 accounts/check 未看到 workspace ${workspaceId.slice(0, 8)}...，可能只是 request 成功但尚未成为成员`);
    return false;
  } catch {
    appendLog(task, "warn", `K12 accounts/check 响应不是 JSON: ${text.slice(0, 180)}`);
    return false;
  }
}

async function selectK12AuthWorkspace(client: any, task: K12Task, workspaceId: string, referer = AUTH_WORKSPACE_URL): Promise<string> {
  appendLog(task, "info", `auth workspace/select(K12): ${workspaceId}`);
  await client.fetch(AUTH_WORKSPACE_URL, {
    method: "GET",
    redirect: "manual",
    headers: oauthBrowserHeaders(client, {
      referer: AUTH_BASE_URL,
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
    }),
  }).catch(() => undefined);

  const response = await client.fetch(AUTH_WORKSPACE_SELECT_URL, {
    method: "POST",
    headers: oauthBrowserHeaders(client, {
      accept: "application/json",
      "content-type": "application/json",
      origin: AUTH_BASE_URL,
      referer,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    }),
    body: JSON.stringify({workspace_id: workspaceId}),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`auth workspace/select(K12) workspace_id=${workspaceId} HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  try {
    const data = JSON.parse(text) as {continue_url?: string; page?: {payload?: {url?: string}}};
    const nextUrl = String(data.page?.payload?.url || data.continue_url || "");
    if (!nextUrl) throw new Error(`响应缺少 continue_url: ${text.slice(0, 240)}`);
    const resolved = new URL(nextUrl, AUTH_BASE_URL).toString();
    appendLog(task, "info", `auth workspace/select(K12) -> ${safeUrlForLog(resolved)}`);
    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("响应缺少")) throw error;
    throw new Error(`auth workspace/select(K12) 非 JSON 响应: ${text.slice(0, 240)}`);
  }
}

async function followK12WorkspaceSelection(client: any, task: K12Task, nextUrl: string): Promise<void> {
  if (nextUrl.startsWith(`${CHATGPT_BASE_URL}/api/auth/callback/openai`)) {
    await finishChatGptCallback(client, nextUrl, task, AUTH_WORKSPACE_URL);
    return;
  }
  if (nextUrl.startsWith(`${CHATGPT_BASE_URL}/`)) {
    const response = await client.fetch(nextUrl, {
      method: "GET",
      redirect: "follow",
      headers: oauthBrowserHeaders(client, {
        referer: AUTH_WORKSPACE_URL,
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-site",
      }),
    });
    if (!response.ok) throw new Error(`进入 K12 workspace 跳转失败: HTTP ${response.status}`);
    return;
  }
  await continueAuthSteps(client, nextUrl, task, {finishChatGptCallback: true, allowConsent: true});
}

async function openChatGptAuthEntryForWorkspaceSwitch(client: any, task: K12Task): Promise<string> {
  appendLog(task, "info", "复用当前 ChatGPT cookie 打开 auth 入口，刷新 workspace/select 会话");
  await client.fetch(`${CHATGPT_BASE_URL}/`, {
    method: "GET",
    redirect: "follow",
    headers: oauthBrowserHeaders(client, {
      "accept-encoding": "gzip, deflate, br",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
    }),
  });
  await ensureChatGptCsrfCookie(client);

  const csrfCookie = typeof client.readCookie === "function"
    ? await client.readCookie(CHATGPT_BASE_URL, "__Host-next-auth.csrf-token").catch(() => "")
    : "";
  const csrfToken = decodeURIComponent(csrfCookie).split("|")[0] || "";
  if (!csrfToken) throw new Error("刷新 auth 入口失败：缺少 ChatGPT CSRF cookie");

  const deviceId = client?.deviceID
    || (typeof client.readCookie === "function" ? await client.readCookie(CHATGPT_BASE_URL, "oai-did").catch(() => "") : "")
    || (typeof client.readCookie === "function" ? await client.readCookie("https://openai.com", "oai-did").catch(() => "") : "")
    || randomUUID();
  client.deviceID = deviceId;

  const query = new URLSearchParams({
    prompt: "login",
    "ext-oai-did": deviceId,
    auth_session_logging_id: randomUUID(),
    "ext-passkey-client-capabilities": "0111",
    screen_hint: "login_or_signup",
    login_hint: task.email,
  });
  const body = new URLSearchParams({
    callbackUrl: `${CHATGPT_BASE_URL}/`,
    csrfToken,
    json: "true",
  });

  const signInResponse = await client.fetch(`${CHATGPT_BASE_URL}/api/auth/signin/openai?${query.toString()}`, {
    method: "POST",
    redirect: "follow",
    headers: oauthBrowserHeaders(client, {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      origin: CHATGPT_BASE_URL,
      referer: `${CHATGPT_BASE_URL}/`,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    }),
    body,
  });
  if (!signInResponse.ok) {
    throw new Error(`刷新 auth 入口失败: HTTP ${signInResponse.status}`);
  }
  const payload = (await signInResponse.json()) as {url?: string};
  const authorizeUrl = String(payload.url || "");
  if (!authorizeUrl) throw new Error(`刷新 auth 入口响应缺少 url: ${JSON.stringify(payload).slice(0, 240)}`);

  const authorizeResponse = await client.fetch(authorizeUrl, {
    method: "GET",
    redirect: "manual",
    headers: oauthBrowserHeaders(client, {
      "accept-encoding": "gzip, deflate, br",
      referer: `${CHATGPT_BASE_URL}/`,
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-site",
    }),
  });
  const location = authorizeResponse.headers.get("location");
  const nextUrl = location ? new URL(location, authorizeUrl).toString() : (authorizeResponse.url || authorizeUrl);
  appendLog(task, "info", `auth 入口刷新后 -> ${safeUrlForLog(nextUrl)}`);
  return nextUrl;
}

async function runWorkspaceSwitchAuthFlow(client: any, task: K12Task, startUrl: string, workspaceId: string): Promise<void> {
  let currentUrl = startUrl;
  for (let hop = 0; hop < 12; hop += 1) {
    if (currentUrl.startsWith(`${CHATGPT_BASE_URL}/api/auth/callback/openai`)) {
      await finishChatGptCallback(client, currentUrl, task, AUTH_WORKSPACE_URL);
      return;
    }
    if (currentUrl === AUTH_WORKSPACE_URL || currentUrl.startsWith(`${AUTH_WORKSPACE_URL}?`)) {
      currentUrl = await selectK12AuthWorkspace(client, task, workspaceId, currentUrl);
      continue;
    }
    if (currentUrl.startsWith(AUTH_CHOOSE_ACCOUNT_URL)) {
      currentUrl = await chooseCurrentAuthAccount(client, task, currentUrl);
      continue;
    }
    if (isAddPhoneUrl(currentUrl)) {
      throw new Error("切换 K12 workspace 时触发 add-phone，无法仅靠当前 Web session 完成");
    }
    if (
      currentUrl === `${AUTH_BASE_URL}/log-in`
      || currentUrl.startsWith(`${AUTH_BASE_URL}/log-in`)
      || currentUrl === `${AUTH_BASE_URL}/email-verification`
      || currentUrl === AUTH_CREATE_ACCOUNT_PASSWORD_URL
    ) {
      throw new Error(`切换 K12 workspace 需要重新登录，当前停在 ${safeUrlForLog(currentUrl)}`);
    }
    if (currentUrl.startsWith(AUTH_BASE_URL)) {
      const response = await client.fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: oauthBrowserHeaders(client, {
          referer: CHATGPT_BASE_URL,
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-site",
        }),
      });
      const location = response.headers.get("location");
      if (location) {
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (response.url && response.url !== currentUrl) {
        currentUrl = response.url;
        continue;
      }
    }
    if (currentUrl.startsWith(CHATGPT_BASE_URL)) {
      const response = await client.fetch(currentUrl, {
        method: "GET",
        redirect: "follow",
        headers: oauthBrowserHeaders(client, {
          referer: AUTH_BASE_URL,
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-site",
        }),
      });
      if (!response.ok) throw new Error(`切换 K12 workspace 跳转失败: HTTP ${response.status}`);
      return;
    }
    throw new Error(`切换 K12 workspace 跳转未识别: ${safeUrlForLog(currentUrl)}`);
  }
  throw new Error(`切换 K12 workspace 跳转次数过多，最后停在 ${safeUrlForLog(currentUrl)}`);
}

async function switchToK12WorkspaceAccessToken(client: any, task: K12Task, accessToken: string, workspaceId: string): Promise<string> {
  if (isK12AccessToken(accessToken, task)) return accessToken;

  appendLog(task, "warn", `当前 Web AT 仍不是 K12，尝试直接 workspace/select 切到 K12: ${describeAccessTokenContext(accessToken)}`);
  try {
    const nextUrl = await selectK12AuthWorkspace(client, task, workspaceId);
    await followK12WorkspaceSelection(client, task, nextUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isInvalidAuthStateError(error)) throw error;
    appendLog(task, "warn", "当前 auth session 已失效；改为复用 ChatGPT cookie 刷新 auth session 后直接切 K12");
    const refreshedUrl = await openChatGptAuthEntryForWorkspaceSwitch(client, task);
    await runWorkspaceSwitchAuthFlow(client, task, refreshedUrl, workspaceId);
  }

  let latestToken = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    latestToken = await readChatGptSessionAccessToken(client, task, `workspace/select ${workspaceId.slice(0, 8)}... 后 第 ${attempt} 次`);
    if (isK12AccessToken(latestToken, task)) return latestToken;
    if (attempt < 3) await sleep(1000);
  }
  appendLog(task, "warn", `workspace/select 后 session AT 仍不是 K12: ${describeAccessTokenContext(latestToken || accessToken)}`);
  return latestToken || accessToken;
}

async function ensureK12AccessTokenForNoRt(client: any, task: K12Task, accessToken: string): Promise<string> {
  if (isK12AccessToken(accessToken, task)) return accessToken;

  appendLog(task, "warn", `当前 AT 不是 K12 上下文，不能直接 noRT 入库: ${describeAccessTokenContext(accessToken)}`);
  let latestToken = accessToken;
  for (const workspaceId of targetK12WorkspaceIds(task)) {
    const existingOk = task.workspaceResults.some((item) => item.workspaceId === workspaceId && item.route === task.route && item.ok);
    if (!existingOk) {
      const result = await sendK12Invite(task, client, latestToken, workspaceId, task.route);
      task.workspaceResults.push(result);
      await persistTasks();
      if (!result.ok) continue;
    }
    await checkK12WorkspaceMembership(client, task, latestToken, workspaceId);
    latestToken = await switchToK12WorkspaceAccessToken(client, task, latestToken, workspaceId);
    if (isK12AccessToken(latestToken, task)) return latestToken;
    appendLog(task, "warn", `K12 请求成功后 session AT 仍不是 K12: ${describeAccessTokenContext(latestToken)}`);
  }

  throw new Error(
    `noRT fallback 需要 K12 workspace AT，但当前仍是 ${describeAccessTokenContext(latestToken)}。` +
    "说明邮箱登录后停在个人/free 账户，未切到 K12 团队 token，已阻止导入不可用账号。",
  );
}

function buildSub2ApiCredentialsFromAccessToken(accessToken: string, fallbackEmail: string): Record<string, unknown> {
  const payload = decodeJwtPayload(accessToken);
  const auth = (payload["https://api.openai.com/auth"] || {}) as Record<string, unknown>;
  const profile = (payload["https://api.openai.com/profile"] || {}) as Record<string, unknown>;
  const credentials: Record<string, unknown> = {
    access_token: accessToken,
    email: asString(profile.email || payload.email, fallbackEmail),
    chatgpt_account_id: asString(auth.chatgpt_account_id),
    chatgpt_user_id: normalizeChatGptUserId(auth),
    plan_type: asString(auth.chatgpt_plan_type),
    client_id: asString(payload.client_id, "app_X8zY6vW2pQ9tR3dE7nK1jL5gH"),
  };
  for (const key of Object.keys(credentials)) {
    if (!credentials[key]) delete credentials[key];
  }
  if (appConfig.requireChatgptAccountId && !credentials.chatgpt_account_id) {
    throw new Error(`AT 中缺少 chatgpt_account_id: ${credentials.email || fallbackEmail || "(unknown)"}`);
  }
  return credentials;
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  }
  return "";
}

function normalizeTimestampValue(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e11 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeTimestampValue(numeric);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  return "";
}

function epochSecondsFromValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const seconds = numeric > 1e11 ? numeric / 1000 : numeric;
    return seconds > 0 ? Math.trunc(seconds) : undefined;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : undefined;
}

function firstPositiveEpochSeconds(...values: unknown[]): number | undefined {
  for (const value of values) {
    const seconds = epochSecondsFromValue(value);
    if (seconds && seconds > 0) return seconds;
  }
  return undefined;
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function buildSyntheticCodexIdToken(email: string, accountId: string, planType: string, userId: string, expiresAt: string): string {
  if (!accountId) return "";
  const now = Math.trunc(Date.now() / 1000);
  const expires = epochSecondsFromValue(expiresAt) || now + 90 * 24 * 60 * 60;
  const authInfo: Record<string, unknown> = {chatgpt_account_id: accountId};
  if (planType) authInfo.chatgpt_plan_type = planType;
  if (userId) {
    authInfo.chatgpt_user_id = userId;
    authInfo.user_id = userId;
  }
  const payload: Record<string, unknown> = {
    iat: now,
    exp: expires,
    "https://api.openai.com/auth": authInfo,
  };
  if (email) payload.email = email;
  return `${encodeBase64UrlJson({alg: "none", typ: "JWT", cpa_synthetic: true})}.${encodeBase64UrlJson(payload)}.synthetic`;
}

function stripJsonUnavailable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripJsonUnavailable).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, stripJsonUnavailable(item)] as const)
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  if (value === undefined || value === null || value === "") return undefined;
  return value;
}

function stripUndefinedNull(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function sanitizeFileToken(value: string, fallback = "account"): string {
  const text = String(value || fallback)
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (text || fallback).slice(0, 120);
}

function resolveJsonOutDir(): string {
  const configured = asString(appConfig.jsonOutDir) || defaultJsonOutDir;
  return path.isAbsolute(configured) ? configured : path.join(rootDir, configured);
}

function buildAccountJsonOutput(
  task: K12Task,
  email: EmailRecord,
  accessToken: string,
  options: {credentials?: Record<string, unknown>; accountName?: string; source?: string} = {},
): {format: JsonOutFormat; accountName: string; data: unknown} {
  const format = normalizeJsonOutFormat(appConfig.jsonOutFormat);
  const credentials = options.credentials || {};
  const payload = decodeJwtPayload(accessToken);
  const auth = (payload["https://api.openai.com/auth"] || {}) as Record<string, unknown>;
  const profile = (payload["https://api.openai.com/profile"] || {}) as Record<string, unknown>;
  const inputIdToken = firstNonEmpty(credentials.id_token, credentials.idToken);
  const idPayload = inputIdToken ? decodeJwtPayload(inputIdToken) : {};
  const idAuth = (idPayload["https://api.openai.com/auth"] || {}) as Record<string, unknown>;

  const accountId = firstNonEmpty(
    auth.chatgpt_account_id,
    credentials.chatgpt_account_id,
    credentials.chatgptAccountId,
    idAuth.chatgpt_account_id,
    idAuth.account_id,
  );
  const userId = firstNonEmpty(
    normalizeChatGptUserId(auth),
    credentials.chatgpt_user_id,
    credentials.chatgptUserId,
    idAuth.chatgpt_user_id,
    idAuth.user_id,
  );
  const outputEmail = firstNonEmpty(
    profile.email,
    payload.email,
    credentials.email,
    idPayload.email,
    task.accessTokenEmail,
    email.email,
  );
  const planType = firstNonEmpty(auth.chatgpt_plan_type, credentials.plan_type, credentials.planType, idAuth.chatgpt_plan_type);
  const expiresAt = firstNonEmpty(
    normalizeTimestampValue(credentials.expires_at),
    normalizeTimestampValue(credentials.expiresAt),
    normalizeTimestampValue(credentials.expired),
    normalizeTimestampValue(payload.exp),
    task.accessTokenExpiresAt,
  );
  const expiresEpoch = firstPositiveEpochSeconds(credentials.expires_at, credentials.expiresAt, credentials.expired, payload.exp, expiresAt);
  const idTokenAccountId = firstNonEmpty(idAuth.chatgpt_account_id, idAuth.account_id);
  const idTokenMatchesAccessToken = !inputIdToken || !accountId || !idTokenAccountId || idTokenAccountId === accountId;
  const syntheticIdToken = idTokenMatchesAccessToken ? "" : buildSyntheticCodexIdToken(outputEmail, accountId, planType, userId, expiresAt);
  const idToken = idTokenMatchesAccessToken
    ? firstNonEmpty(inputIdToken, buildSyntheticCodexIdToken(outputEmail, accountId, planType, userId, expiresAt))
    : syntheticIdToken;
  const refreshToken = firstNonEmpty(credentials.refresh_token, credentials.refreshToken);
  const sessionToken = firstNonEmpty(credentials.session_token, credentials.sessionToken);
  const clientId = firstNonEmpty(credentials.client_id, credentials.clientId, payload.client_id, "app_X8zY6vW2pQ9tR3dE7nK1jL5gH");
  const organizationId = firstNonEmpty(credentials.organization_id, credentials.organizationId);
  const accountName = firstNonEmpty(
    options.accountName,
    task.sub2apiAccount,
    email.sub2apiAccount,
    outputEmail,
    accountId,
    email.email,
  );
  const exportedAt = nowIso();

  const sub2apiAccount = stripJsonUnavailable({
    name: accountName,
    platform: "openai",
    type: "oauth",
    expires_at: expiresEpoch,
    auto_pause_on_expired: true,
    concurrency: appConfig.sub2apiConcurrency,
    priority: appConfig.sub2apiAccountPriority,
    rate_multiplier: 1,
    credentials: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      session_token: sessionToken,
      chatgpt_account_id: accountId,
      chatgpt_user_id: userId,
      client_id: clientId,
      email: outputEmail,
      expires_at: expiresEpoch,
      organization_id: organizationId,
      plan_type: planType,
    },
    extra: {
      email: outputEmail,
      privacy_mode: "training_off",
      openai_oauth_responses_websockets_v2_enabled: false,
      openai_oauth_responses_websockets_v2_mode: "off",
      source: options.source || "gpt-k12",
      no_rt: task.sub2apiNoRtMode === true || accountName.endsWith("--noRT") || undefined,
    },
  });

  if (format === "sub2api") {
    return {
      format,
      accountName,
      data: {
        exported_at: exportedAt,
        proxies: [],
        accounts: [sub2apiAccount],
      },
    };
  }

  return {
    format,
    accountName,
    data: stripUndefinedNull({
      type: "codex",
      account_id: accountId,
      chatgpt_account_id: accountId,
      email: outputEmail,
      name: accountName,
      plan_type: planType,
      chatgpt_plan_type: planType,
      id_token: idToken,
      id_token_synthetic: idToken.endsWith(".synthetic") || undefined,
      access_token: accessToken,
      refresh_token: refreshToken || "",
      session_token: sessionToken,
      last_refresh: exportedAt,
      expired: expiresAt,
      source: options.source || "gpt-k12",
    }),
  };
}

async function writeAccountJsonFile(
  task: K12Task,
  email: EmailRecord,
  accessToken: string,
  options: {credentials?: Record<string, unknown>; accountName?: string; source?: string} = {},
): Promise<void> {
  if (!accessToken) return;
  const output = buildAccountJsonOutput(task, email, accessToken, options);
  const outDir = resolveJsonOutDir();
  await mkdir(outDir, {recursive: true});
  const filename = `${output.format}-${sanitizeFileToken(output.accountName || email.email)}.json`;
  const filePath = path.join(outDir, filename);
  await writeFile(filePath, `${JSON.stringify(output.data, null, 2)}\n`, "utf8");
  task.jsonOutFile = filePath;
  task.jsonOutFormat = output.format;
  appendLog(task, "ok", `账号 JSON 已写出: ${filePath}`);
}

async function tryWriteAccountJsonFile(
  task: K12Task,
  email: EmailRecord,
  accessToken: string,
  options: {credentials?: Record<string, unknown>; accountName?: string; source?: string} = {},
): Promise<void> {
  try {
    await writeAccountJsonFile(task, email, accessToken, options);
  } catch (error) {
    appendLog(task, "warn", `账号 JSON 写出失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function pickErrorMessage(payload: unknown, fallback = "unknown error"): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : null;
  return asString(error?.message || error?.code || record.detail || record.message || record.error, fallback);
}

function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const key of ["items", "accounts", "data", "records", "list"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = extractItems(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

function unwrapSub2ApiAccount(value: Record<string, unknown>): Record<string, unknown> {
  const nested = value.account || value.Account;
  if (nested && typeof nested === "object") return nested as Record<string, unknown>;
  return value;
}

function asIdString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "string") return value.trim();
  return "";
}

function sub2ApiAccountId(account: Record<string, unknown>): string {
  const unwrapped = unwrapSub2ApiAccount(account);
  return asIdString(unwrapped.id) || asIdString(unwrapped.db_id) || asIdString(unwrapped.account_id);
}

function sub2ApiAccountName(account: Record<string, unknown>): string {
  const unwrapped = unwrapSub2ApiAccount(account);
  return asString(unwrapped.name || unwrapped.account_name);
}

function sub2ApiAccountCredentials(account: Record<string, unknown>): Record<string, unknown> {
  const unwrapped = unwrapSub2ApiAccount(account);
  return (unwrapped.credentials && typeof unwrapped.credentials === "object" ? unwrapped.credentials : {}) as Record<string, unknown>;
}

function mergeCredentials(existing: Record<string, unknown>, accessToken: string, email: EmailRecord): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...existing,
    ...buildSub2ApiCredentialsFromAccessToken(accessToken, email.email),
    access_token: accessToken,
  };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined || next[key] === null || next[key] === "") delete next[key];
  }
  return next;
}

function expectedSub2ApiAccountNames(email: EmailRecord, groupName = appConfig.sub2apiGroupName || "k12"): string[] {
  return Array.from(new Set([
    asString(email.sub2apiAccount),
    `${email.email}---${groupName || "k12"}`,
    `${email.email}--noRT`,
  ].filter(Boolean)));
}

function findAccountByNames(accounts: unknown[], names: string[]): Record<string, unknown> | null {
  const normalizedNames = new Set(names.map((item) => item.toLowerCase()));
  for (const item of accounts) {
    if (!item || typeof item !== "object") continue;
    const account = unwrapSub2ApiAccount(item as Record<string, unknown>);
    if (normalizedNames.has(sub2ApiAccountName(account).toLowerCase())) return account;
  }
  return null;
}

function normalizeSub2ApiOrigin(rawUrl: string): string {
  const normalized = asString(rawUrl).replace(/\/+$/, "");
  if (!normalized) throw new Error("Sub2API 地址为空");
  return new URL(normalized).origin;
}

async function requestSub2ApiJson(
  origin: string,
  pathname: string,
  options: {method?: string; token?: string; body?: unknown; timeoutMs?: number; accept?: string} = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, options.timeoutMs ?? 30000));
  try {
    const response = await fetch(`${origin}${pathname}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: options.accept || "application/json",
        "Content-Type": "application/json",
        ...(options.token ? {Authorization: `Bearer ${options.token}`} : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = {raw: text};
    }
    if (payload && typeof payload === "object" && "code" in payload) {
      const record = payload as Record<string, unknown>;
      if (Number(record.code) === 0) return record.data;
      const message = asString(record.message || record.detail || record.error || record.reason, JSON.stringify(payload).slice(0, 300));
      throw new Error(`Sub2API ${pathname} 失败: ${message}`);
    }
    if (!response.ok) {
      throw new Error(`Sub2API ${pathname} HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Sub2API 请求超时: ${pathname}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function loginSub2ApiAdmin(): Promise<{origin: string; token: string}> {
  if (!appConfig.sub2apiUrl || !appConfig.sub2apiEmail || !appConfig.sub2apiPassword) {
    throw new Error("Sub2API 配置不完整：地址、账号、密码均不能为空");
  }
  const origin = normalizeSub2ApiOrigin(appConfig.sub2apiUrl);
  const loginData = (await requestSub2ApiJson(origin, "/api/v1/auth/login", {
    method: "POST",
    body: {email: appConfig.sub2apiEmail, password: appConfig.sub2apiPassword},
  })) as Record<string, unknown>;
  const token = asString(loginData.access_token || loginData.accessToken);
  if (!token) throw new Error("Sub2API 登录响应缺少 access_token");
  return {origin, token};
}

async function findSub2ApiAccountByName(
  origin: string,
  adminToken: string,
  names: string[],
): Promise<Record<string, unknown> | null> {
  const uniqueNames = Array.from(new Set(names.map((item) => item.trim()).filter(Boolean)));
  for (const name of uniqueNames) {
    const data = await requestSub2ApiJson(
      origin,
      `/api/v1/admin/accounts?page=1&page_size=20&platform=openai&type=oauth&search=${encodeURIComponent(name)}`,
      {token: adminToken},
    );
    const found = findAccountByNames(extractItems(data), uniqueNames);
    if (found) return found;
  }
  return null;
}

async function testOpenAiAccessToken(accessToken: string, model = DEFAULT_AT_LIVENESS_MODEL): Promise<{ok: boolean; status: number; message: string; latencyMs: number; banned?: boolean}> {
  const tokenInfo = summarizeToken(accessToken);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await undiciFetch(CHATGPT_CODEX_RESPONSES_URL, {
      method: "POST",
      ...buildDownloadFetchOptions(),
      headers: {
        Accept: "text/event-stream, application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "OpenAI-Beta": "responses=experimental",
        originator: "opencode",
        ...(tokenInfo.accountId ? {"chatgpt-account-id": tokenInfo.accountId} : {}),
      },
      body: JSON.stringify({
        model,
        input: [{
          role: "user",
          content: [{type: "input_text", text: "hi"}],
        }],
        instructions: "You are a helpful assistant.",
        stream: true,
        store: false,
      }),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    const parsed = (() => {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    })();
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      return {ok: true, status: response.status, message: `AT 存活: HTTP ${response.status} / ${latencyMs}ms`, latencyMs};
    }
    const reason = pickErrorMessage(parsed, text.slice(0, 240) || `HTTP ${response.status}`);
    const message = `AT 失效/不可用: HTTP ${response.status}: ${reason}`;
    return {ok: false, status: response.status, message, latencyMs, banned: isOpenAiAccountBannedMessage(`${reason}\n${text}`)};
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error instanceof Error && error.name === "AbortError") {
      return {ok: false, status: 0, message: "AT 测活超时", latencyMs};
    }
    const message = `AT 测活失败: ${error instanceof Error ? error.message : String(error)}`;
    return {ok: false, status: 0, message, latencyMs, banned: isOpenAiAccountBannedMessage(message)};
  } finally {
    clearTimeout(timer);
  }
}

async function testSub2ApiAccountLiveness(
  origin: string,
  adminToken: string,
  accountId: string,
  model = DEFAULT_AT_LIVENESS_MODEL,
): Promise<{ok: boolean; status: number; message: string; latencyMs: number}> {
  const startedAt = Date.now();
  try {
    const data = await requestSub2ApiJson(origin, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/test`, {
      method: "POST",
      token: adminToken,
      body: {model_id: model, prompt: ""},
      timeoutMs: 60000,
      accept: "text/event-stream, application/json",
    });
    const raw = typeof data === "string"
      ? data
      : data && typeof data === "object" && typeof (data as Record<string, unknown>).raw === "string"
        ? String((data as Record<string, unknown>).raw)
        : JSON.stringify(data || "");
    const lower = raw.toLowerCase();
    const latencyMs = Date.now() - startedAt;
    if (lower.includes("\"type\":\"error\"") || lower.includes("\"success\":false")) {
      return {ok: false, status: 0, message: `Sub2API 测活失败: ${raw.slice(0, 240)}`, latencyMs};
    }
    return {ok: true, status: 200, message: `Sub2API 测活通过 / ${latencyMs}ms`, latencyMs};
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return {ok: false, status: 0, message: `Sub2API 测活失败: ${error instanceof Error ? error.message : String(error)}`, latencyMs};
  }
}

async function checkSub2ApiAccessTokens(body: Record<string, unknown>): Promise<{
  items: Array<{
    emailId: string;
    email: string;
    accountName: string;
    accountId: string;
    ok: boolean;
    status: number;
    message: string;
    latencyMs: number;
  }>;
  ok: number;
  failed: number;
  missing: number;
  skippedRunning: number;
}> {
  const requestedEmailIds = Array.isArray(body.emailIds)
    ? body.emailIds.map((item) => String(item)).filter(Boolean)
    : [];
  const requested = new Set(requestedEmailIds);
  const existingIds = new Set(emails.map((item) => item.id));
  const missing = requestedEmailIds.filter((id) => !existingIds.has(id)).length;
  const selectedEmails = emails.filter((item) => requested.has(item.id));
  const sub2apiGroupName = asString(body.sub2apiGroupName, appConfig.sub2apiGroupName) || "k12";
  const items: Array<{
    emailId: string;
    email: string;
    accountName: string;
    accountId: string;
    ok: boolean;
    status: number;
    message: string;
    latencyMs: number;
  }> = [];
  let skippedRunning = 0;
  let changedEmails = false;

  const {origin, token: adminToken} = await loginSub2ApiAdmin();

  for (const email of selectedEmails) {
    if (email.status === "running" || email.status === "banned" || hasActiveTask(email.id)) {
      skippedRunning += 1;
      continue;
    }

    const startedAt = Date.now();
    try {
      const names = expectedSub2ApiAccountNames(email, sub2apiGroupName);
      const account = await findSub2ApiAccountByName(origin, adminToken, names);
      if (!account) {
        const message = `Sub2API 未找到账号: ${names.join(" / ")}`;
        items.push({
          emailId: email.id,
          email: email.email,
          accountName: "",
          accountId: "",
          ok: false,
          status: 404,
          message,
          latencyMs: Date.now() - startedAt,
        });
        continue;
      }

      const accountId = sub2ApiAccountId(account);
      const accountName = sub2ApiAccountName(account);
      if (accountName && email.sub2apiAccount !== accountName) {
        email.sub2apiAccount = accountName;
        email.updatedAt = nowIso();
        changedEmails = true;
      }
      if (!accountId) {
        items.push({
          emailId: email.id,
          email: email.email,
          accountName,
          accountId: "",
          ok: false,
          status: 0,
          message: `Sub2API 账号缺少 id: ${accountName || "(unknown)"}`,
          latencyMs: Date.now() - startedAt,
        });
        continue;
      }

      const accessToken = extractAccessTokenFromCredentials(sub2ApiAccountCredentials(account));
      const result = accessToken
        ? await testOpenAiAccessToken(accessToken)
        : await testSub2ApiAccountLiveness(origin, adminToken, accountId);
      items.push({
        emailId: email.id,
        email: email.email,
        accountName,
        accountId,
        ok: result.ok,
        status: result.status,
        message: result.message,
        latencyMs: result.latencyMs,
      });
    } catch (error) {
      items.push({
        emailId: email.id,
        email: email.email,
        accountName: "",
        accountId: "",
        ok: false,
        status: 0,
        message: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      });
    }
  }

  if (changedEmails) await persistEmails();
  return {
    items,
    ok: items.filter((item) => item.ok).length,
    failed: items.filter((item) => !item.ok).length,
    missing,
    skippedRunning,
  };
}

async function checkTaskAccessToken(task: K12Task): Promise<{
  task: Record<string, unknown>;
  email?: Record<string, unknown>;
  result: {ok: boolean; status: number; message: string; latencyMs: number; banned?: boolean};
  repairTask?: Record<string, unknown>;
}> {
  return checkTaskAccessTokenWithOptions(task, {autoRepair: true});
}

function isInactiveAccessTokenResult(result: {ok: boolean; status: number; message: string; banned?: boolean}): boolean {
  if (result.ok) return false;
  if (result.banned) return true;
  if (result.status === 401 || result.status === 403) return true;
  return /unauthorized|invalid[_ -]?token|token.*expired|access.*denied|account.*(?:deactivated|disabled|suspended|banned)|封号|停用|被封禁/i.test(result.message);
}

function recordTaskAccessTokenLiveness(
  task: K12Task,
  result: {ok: boolean; status: number; message: string; banned?: boolean} | null,
  fallback: "unknown" | "error" = "error",
): void {
  if (!result) {
    task.accessTokenLiveness = fallback;
    task.accessTokenLivenessStatus = 0;
    task.accessTokenLivenessMessage = fallback === "unknown" ? "" : "未完成测活";
  } else {
    task.accessTokenLiveness = result.banned
      ? "banned"
      : result.ok
        ? "alive"
        : isInactiveAccessTokenResult(result)
          ? "inactive"
          : "error";
    task.accessTokenLivenessStatus = result.status;
    task.accessTokenLivenessMessage = result.message;
  }
  task.accessTokenLivenessCheckedAt = nowIso();
}

async function checkTaskAccessTokenWithOptions(
  task: K12Task,
  options: {autoRepair?: boolean} = {},
): Promise<{
  task: Record<string, unknown>;
  email?: Record<string, unknown>;
  result: {ok: boolean; status: number; message: string; latencyMs: number; banned?: boolean};
  repairTask?: Record<string, unknown>;
}> {
  if (task.status === "queued" || task.status === "running") {
    throw new Error("任务正在运行/排队中，不能测活");
  }
  const email = emails.find((item) => item.id === task.emailId);
  if (!email) throw new Error("邮箱记录不存在");
  if (email.status === "banned") throw new Error("该邮箱已标记封号，不再测活/修复");

  if (!task.accessToken && appConfig.tokenOut) {
    if (await hydrateTaskAccessTokensFromTokenOut()) await persistTasks();
  }
  if (!task.accessToken) {
    throw new Error("该任务没有保存完整 AT，无法测活；需要先重新跑一次获取 AT");
  }

  appendLog(task, "info", "开始使用任务保存的 AT 测活");
  const result = await testOpenAiAccessToken(task.accessToken);
  recordTaskAccessTokenLiveness(task, result);
  appendLog(task, result.ok ? "ok" : "warn", `任务 AT 测活: ${result.message}`);

  let repairTask: K12Task | undefined;
  if (result.banned) {
    markEmailBanned(email, "GPT 账号已被 OpenAI 停用/封禁，停止继续获取 AT", task);
  } else if (options.autoRepair !== false && !result.ok && result.status === 401) {
    appendLog(task, "warn", "AT 返回 401，自动创建 AT 修复任务");
    const created = createAtRepairTasks({
      emailIds: [task.emailId],
      sub2apiGroupName: task.sub2apiGroupName || appConfig.sub2apiGroupName || "k12",
    });
    repairTask = created.created[0];
    if (!repairTask && created.skippedRunning) {
      appendLog(task, "warn", "AT 修复任务未创建：该邮箱已有运行中任务");
    }
  } else if (!result.ok) {
    email.lastError = result.message;
    email.updatedAt = nowIso();
  }

  task.updatedAt = nowIso();
  await Promise.all([persistTasks(), persistEmails()]);
  return {
    task: publicTask(task),
    email: publicEmail(email),
    result,
    repairTask: repairTask ? publicTask(repairTask) : undefined,
  };
}

async function checkTaskAccessTokens(body: Record<string, unknown>): Promise<{
  items: Array<{
    taskId: string;
    emailId: string;
    email: string;
    ok: boolean;
    inactive: boolean;
    status: number;
    message: string;
    latencyMs: number;
    banned?: boolean;
    repairTaskId?: string;
    skipped?: boolean;
  }>;
  checked: number;
  inactive: number;
  ok: number;
  repaired: number;
  skipped: number;
}> {
  if (await hydrateTaskAccessTokensFromTokenOut()) await persistTasks();
  const taskIds = Array.isArray(body.taskIds)
    ? body.taskIds.map((item) => String(item)).filter(Boolean)
    : [];
  const idSet = new Set(taskIds);
  const onlyInactive = asBoolean(body.onlyInactive, false);
  const autoRepair = asBoolean(body.autoRepair, false);
  const candidates = taskIds.length
    ? tasks.filter((task) => idSet.has(task.id))
    : tasks.filter((task) => task.status !== "queued" && task.status !== "running" && (task.accessToken || task.accessTokenPreview));

  const items: Array<{
    taskId: string;
    emailId: string;
    email: string;
    ok: boolean;
    inactive: boolean;
    status: number;
    message: string;
    latencyMs: number;
    banned?: boolean;
    repairTaskId?: string;
    skipped?: boolean;
  }> = [];

  for (const task of candidates) {
    try {
      const checked = await checkTaskAccessTokenWithOptions(task, {autoRepair});
      const inactive = isInactiveAccessTokenResult(checked.result);
      if (onlyInactive && !inactive) continue;
      items.push({
        taskId: task.id,
        emailId: task.emailId,
        email: task.email,
        ok: checked.result.ok,
        inactive,
        status: checked.result.status,
        message: checked.result.message,
        latencyMs: checked.result.latencyMs,
        banned: checked.result.banned,
        repairTaskId: asString(checked.repairTask && (checked.repairTask as Record<string, unknown>).id),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (onlyInactive) continue;
      recordTaskAccessTokenLiveness(task, {ok: false, status: 0, message});
      items.push({
        taskId: task.id,
        emailId: task.emailId,
        email: task.email,
        ok: false,
        inactive: false,
        status: 0,
        message,
        latencyMs: 0,
        skipped: true,
      });
    }
  }

  return {
    items,
    checked: items.filter((item) => !item.skipped).length,
    inactive: items.filter((item) => item.inactive).length,
    ok: items.filter((item) => item.ok).length,
    repaired: items.filter((item) => item.repairTaskId).length,
    skipped: items.filter((item) => item.skipped).length,
  };
}

async function updateSub2ApiAccountAccessToken(
  origin: string,
  adminToken: string,
  account: Record<string, unknown>,
  email: EmailRecord,
  accessToken: string,
): Promise<void> {
  const accountId = sub2ApiAccountId(account);
  if (!accountId) throw new Error("Sub2API 账号缺少 id，无法更新");
  const credentials = mergeCredentials(
    sub2ApiAccountCredentials(account),
    accessToken,
    email,
  );
  await requestSub2ApiJson(origin, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/apply-oauth-credentials`, {
    method: "POST",
    token: adminToken,
    body: {
      type: "oauth",
      credentials,
      extra: {
        email: credentials.email || email.email,
        at_repaired_at: nowIso(),
        at_repair_source: "gpt-k12",
      },
    },
    timeoutMs: 60000,
  });
}

async function createSub2ApiNoRtAccountFromAccessToken(task: K12Task, email: EmailRecord, accessToken: string): Promise<string> {
  const groupName = task.sub2apiGroupName || appConfig.sub2apiGroupName || "k12";
  const {origin, token: adminToken} = await loginSub2ApiAdmin();

  const groupsData = await requestSub2ApiJson(origin, "/api/v1/admin/groups/all", {token: adminToken});
  const groups = Array.isArray(groupsData) ? groupsData : [];
  const group = groups.find((item) => {
    const record = item as Record<string, unknown>;
    const name = asString(record.name).toLowerCase();
    const platform = asString(record.platform).toLowerCase();
    return name === groupName.toLowerCase() && (!platform || platform === "openai");
  }) as Record<string, unknown> | undefined;
  const groupId = Number(group?.id);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error(`Sub2API 未找到 openai 分组: ${groupName}`);
  }

  const credentials = buildSub2ApiCredentialsFromAccessToken(accessToken, email.email);
  const accountName = `${email.email}--noRT`;
  await requestSub2ApiJson(origin, "/api/v1/admin/accounts", {
    method: "POST",
    token: adminToken,
    body: {
      name: accountName,
      notes: "noRT fallback: OAuth add-phone blocked; imported access_token only, no refresh_token",
      platform: "openai",
      type: "oauth",
      credentials,
      concurrency: appConfig.sub2apiConcurrency,
      priority: appConfig.sub2apiAccountPriority,
      rate_multiplier: 1,
      group_ids: [groupId],
      auto_pause_on_expired: true,
      extra: {email: credentials.email || email.email, no_rt: true, source: "ai-gpt-k12-add-phone-fallback"},
    },
  });
  appendLog(task, "warn", `Sub2API 已用 AT fallback 创建 noRT 账号: ${accountName} (${groupName}#${groupId})`);
  return accountName;
}

async function upsertSub2ApiNoRtAccountFromAccessToken(task: K12Task, email: EmailRecord, accessToken: string): Promise<string> {
  const groupName = task.sub2apiGroupName || appConfig.sub2apiGroupName || "k12";
  const accountName = `${email.email}--noRT`;
  const {origin, token: adminToken} = await loginSub2ApiAdmin();
  const existing = await findSub2ApiAccountByName(origin, adminToken, [accountName]);
  if (existing) {
    await updateSub2ApiAccountAccessToken(origin, adminToken, existing, email, accessToken);
    appendLog(task, "ok", `Sub2API noRT 账号已存在，已更新 AT: ${accountName}`);
    return accountName;
  }

  const groupsData = await requestSub2ApiJson(origin, "/api/v1/admin/groups/all", {token: adminToken});
  const groups = Array.isArray(groupsData) ? groupsData : [];
  const group = groups.find((item) => {
    const record = item as Record<string, unknown>;
    const name = asString(record.name).toLowerCase();
    const platform = asString(record.platform).toLowerCase();
    return name === groupName.toLowerCase() && (!platform || platform === "openai");
  }) as Record<string, unknown> | undefined;
  const groupId = Number(group?.id);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error(`Sub2API 未找到 openai 分组: ${groupName}`);
  }

  const credentials = buildSub2ApiCredentialsFromAccessToken(accessToken, email.email);
  await requestSub2ApiJson(origin, "/api/v1/admin/accounts", {
    method: "POST",
    token: adminToken,
    body: {
      name: accountName,
      notes: "noRT mode: imported K12 access_token only, no refresh_token",
      platform: "openai",
      type: "oauth",
      credentials,
      concurrency: appConfig.sub2apiConcurrency,
      priority: appConfig.sub2apiAccountPriority,
      rate_multiplier: 1,
      group_ids: [groupId],
      auto_pause_on_expired: true,
      extra: {email: credentials.email || email.email, no_rt: true, source: "ai-gpt-k12-nort-mode"},
    },
    timeoutMs: 60000,
  });
  appendLog(task, "ok", `Sub2API noRT 账号已创建: ${accountName} (${groupName}#${groupId})`);
  return accountName;
}

async function getAuthSessionCandidates(client: any): Promise<Record<string, unknown>[]> {
  const candidates: Record<string, unknown>[] = [];
  if (typeof client.readCookie !== "function") return candidates;

  const cookieNames = [
    "oai-client-auth-session",
    "__Secure-oai-client-auth-session",
    "__Host-oai-client-auth-session",
  ];
  for (const cookieName of cookieNames) {
    const raw = await client.readCookie(AUTH_BASE_URL, cookieName).catch(() => "");
    if (!raw) continue;
    const encoded = String(raw).split(".")[0] || "";
    if (!encoded) continue;
    try {
      const decoded = decodeBase64UrlJson(encoded);
      if (decoded && typeof decoded === "object") {
        candidates.push(decoded as Record<string, unknown>);
      }
    } catch {
      // Cookie may not be a signed JSON payload in all auth variants.
    }
  }
  return candidates;
}

async function createOpenAIClientForEmail(task: K12Task, email: EmailRecord): Promise<any> {
  await ensureSentinelSdk();
  const {OpenAIClient, generateRandomDeviceProfile, MailboxUrlCodeProvider} = await loadBundleModules();
  const mailboxProvider = new MailboxUrlCodeProvider(email.mailboxUrl);
  let baseline: unknown = null;
  try {
    baseline = await mailboxProvider.snapshot();
    appendLog(task, "info", "邮箱基线已读取，等待新验证码");
  } catch (error) {
    appendLog(task, "warn", `邮箱基线读取失败，将直接轮询新验证码: ${error instanceof Error ? error.message : String(error)}`);
  }

  const fetchOtp = async (label: string) => {
    appendLog(task, "info", `等待 ${label} 验证码: ${email.email}`);
    const code = await mailboxProvider.waitForCode({
      baseline,
      timeoutMs: 120000,
      intervalMs: 3000,
      allowBaselineCodeAfterMs: 45000,
    });
    appendLog(task, "ok", `${label} 验证码已获取`);
    try {
      baseline = await mailboxProvider.snapshot();
    } catch {
      // Baseline refresh is best effort only.
    }
    return code;
  };

  return new OpenAIClient({
    email: email.email,
    password: appConfig.defaultPassword,
    deviceProfile: generateRandomDeviceProfile(),
    signupScreenHint: "signup",
    bindEmail: email.email,
    fetchEmailOtp: () => fetchOtp("登录"),
    fetchAddEmailOtp: () => fetchOtp("绑定邮箱"),
  });
}

function collectIds(value: unknown, names: string[], out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, names, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (names.includes(key.toLowerCase()) && typeof child === "string" && child.trim()) {
      out.add(child.trim());
    }
    collectIds(child, names, out);
  }
  return out;
}

interface AuthAccountChoice {
  sessionId: string;
  email: string;
  label: string;
  source: string;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[key] ?? match;
  });
}

function textFromHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function parseChooseAccountChoices(html: string): AuthAccountChoice[] {
  const choices: AuthAccountChoice[] = [];
  const seen = new Set<string>();
  const buttonMatches = html.matchAll(/<button\b[\s\S]*?<\/button>/gi);
  for (const match of buttonMatches) {
    const button = match[0];
    if (!/\bname\s*=\s*["']session_id["']/i.test(button)) continue;
    const valueMatch = button.match(/\bvalue\s*=\s*["']([^"']+)["']/i);
    const sessionId = decodeHtmlEntities(valueMatch?.[1] || "").trim();
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const decodedButton = decodeHtmlEntities(button);
    const email = decodedButton.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || "";
    choices.push({
      sessionId,
      email,
      label: textFromHtml(button).slice(0, 120),
      source: "html",
    });
  }
  return choices;
}

function orderChooseAccountChoices(choices: AuthAccountChoice[], expectedEmail = ""): AuthAccountChoice[] {
  const expected = expectedEmail.trim().toLowerCase();
  if (!expected) return choices;
  const exact = choices.filter((item) => item.email === expected);
  const unknown = choices.filter((item) => !item.email);
  const mismatched = choices.filter((item) => item.email && item.email !== expected);
  return [...exact, ...unknown, ...mismatched];
}

async function extractNextAuthUrl(response: Response, baseUrl: string): Promise<{nextUrl: string; error: string}> {
  const location = response.headers.get("location");
  if (location) return {nextUrl: new URL(location, baseUrl).toString(), error: ""};

  const text = await response.text().catch(() => "");
  const trimmed = text.slice(0, 500);
  try {
    const data = JSON.parse(text) as {continue_url?: string; page?: {payload?: {url?: string}}};
    const nextUrl = String(data.page?.payload?.url || data.continue_url || "");
    if (nextUrl) return {nextUrl: new URL(nextUrl, baseUrl).toString(), error: ""};
  } catch {
    // Some auth endpoints return HTML after a form submit.
  }

  const callbackMatch = text.match(/http:\/\/localhost:1455\/auth\/callback\?[^"' <]+/i);
  if (callbackMatch) return {nextUrl: callbackMatch[0].replace(/&amp;/g, "&"), error: ""};

  const authUrlMatch = text.match(/https:\/\/auth\.openai\.com\/[^"' <]+/i);
  if (authUrlMatch) return {nextUrl: authUrlMatch[0].replace(/&amp;/g, "&"), error: ""};

  if (!response.ok) return {nextUrl: "", error: `HTTP ${response.status}: ${trimmed}`};
  return {nextUrl: "", error: `无跳转地址: ${trimmed}`};
}

async function submitChooseAccountPayload(
  client: any,
  payload: Record<string, unknown>,
  refererUrl: string,
  task?: K12Task,
): Promise<{nextUrl: string; error: string}> {
  const payloadKey = JSON.stringify(payload);
  const response = await client.fetch(`${AUTH_BASE_URL}/api/accounts/session/select`, {
    method: "POST",
    redirect: "manual",
    headers: oauthBrowserHeaders(client, {
      accept: "application/json",
      "content-type": "application/json",
      origin: AUTH_BASE_URL,
      referer: refererUrl,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    }),
    body: JSON.stringify(payload),
  });
  const result = await extractNextAuthUrl(response, refererUrl);
  if (task) {
    appendLog(task, result.nextUrl ? "info" : "warn", `choose-account api ${payloadKey} -> ${result.nextUrl || result.error}`);
  }
  return result;
}

async function submitChooseAccountForm(
  client: any,
  sessionId: string,
  refererUrl: string,
  task?: K12Task,
): Promise<{nextUrl: string; error: string}> {
  const response = await client.fetch(AUTH_CHOOSE_ACCOUNT_URL, {
    method: "POST",
    redirect: "manual",
    headers: oauthBrowserHeaders(client, {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "content-type": "application/x-www-form-urlencoded",
      origin: AUTH_BASE_URL,
      referer: refererUrl,
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
    }),
    body: new URLSearchParams({session_id: sessionId}).toString(),
  });
  const result = await extractNextAuthUrl(response, refererUrl);
  if (task) {
    appendLog(task, result.nextUrl ? "info" : "warn", `choose-account form session_id=${sessionId} -> ${result.nextUrl || result.error}`);
  }
  return result;
}

async function restartAuthFromChooseAccount(client: any, task: K12Task | undefined, chooseUrl: string): Promise<string> {
  if (task) appendLog(task, "warn", "choose-account 未匹配到当前邮箱，改走“登录至另一个帐户”重新接码");
  const response = await client.fetch(`${AUTH_BASE_URL}/log-in-or-create-account`, {
    method: "GET",
    redirect: "manual",
    headers: oauthBrowserHeaders(client, {
      referer: chooseUrl,
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
    }),
  });
  const location = response.headers.get("location");
  const currentUrl = location ? new URL(location, chooseUrl).toString() : (response.url || `${AUTH_BASE_URL}/log-in-or-create-account`);
  if (currentUrl === `${AUTH_BASE_URL}/log-in-or-create-account` || currentUrl.startsWith(`${AUTH_BASE_URL}/log-in-or-create-account`)) {
    return loginAuthFlowWithEmailOtp(client, task, {allowConsent: true});
  }
  return continueAuthSteps(client, currentUrl, task, {allowConsent: true});
}

async function chooseCurrentAuthAccount(client: any, task?: K12Task, chooseUrl = AUTH_CHOOSE_ACCOUNT_URL): Promise<string> {
  const expectedEmail = task?.email?.trim().toLowerCase() || "";
  const pageResp = await client.fetch(chooseUrl, {
    method: "GET",
    redirect: "manual",
    headers: oauthBrowserHeaders(client, {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      referer: AUTH_BASE_URL,
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
    }),
  });
  const redirected = pageResp.headers.get("location");
  if (redirected) return new URL(redirected, chooseUrl).toString();
  const pageHtml = await pageResp.text().catch(() => "");
  const htmlChoices = parseChooseAccountChoices(pageHtml);
  for (const choice of htmlChoices) {
    if (task) appendLog(task, "info", `choose-account html session_id=${choice.sessionId} email=${choice.email || "(unknown)"}`);
  }

  const sessionCandidates = await getAuthSessionCandidates(client);
  const accountIds = new Set<string>();
  const sessionIds = new Set<string>();
  const userIds = new Set<string>();
  for (const candidate of sessionCandidates) {
    collectIds(candidate, ["account_id", "accountid", "account"], accountIds);
    collectIds(candidate, ["session_id", "sessionid", "id"], sessionIds);
    collectIds(candidate, ["user_id", "userid"], userIds);
  }

  for (const choice of orderChooseAccountChoices(htmlChoices, expectedEmail)) {
    if (expectedEmail && choice.email && choice.email !== expectedEmail) {
      if (task) appendLog(task, "warn", `choose-account 跳过非当前邮箱 session: ${choice.email}`);
      continue;
    }
    const apiResult = await submitChooseAccountPayload(client, {session_id: choice.sessionId}, chooseUrl, task);
    if (apiResult.nextUrl && !apiResult.nextUrl.startsWith(AUTH_CHOOSE_ACCOUNT_URL)) return apiResult.nextUrl;
    const formResult = await submitChooseAccountForm(client, choice.sessionId, chooseUrl, task);
    if (formResult.nextUrl && !formResult.nextUrl.startsWith(AUTH_CHOOSE_ACCOUNT_URL)) return formResult.nextUrl;
  }

  const hasOnlyMismatchedHtmlChoices = expectedEmail
    && htmlChoices.length > 0
    && htmlChoices.every((item) => item.email && item.email !== expectedEmail);
  if (hasOnlyMismatchedHtmlChoices) {
    return restartAuthFromChooseAccount(client, task, chooseUrl);
  }

  const payloads: Record<string, unknown>[] = [{}];
  for (const accountId of accountIds) payloads.push({account_id: accountId});
  for (const sessionId of sessionIds) payloads.push({session_id: sessionId});
  for (const userId of userIds) payloads.push({user_id: userId});
  for (const accountId of accountIds) {
    for (const sessionId of sessionIds) payloads.push({account_id: accountId, session_id: sessionId});
  }
  payloads.push({account_id: "default"}, {session_id: "default"});

  let lastError = "";
  const seen = new Set<string>();

  for (const payload of payloads) {
    const payloadKey = JSON.stringify(payload);
    if (seen.has(payloadKey)) continue;
    seen.add(payloadKey);
    const result = await submitChooseAccountPayload(client, payload, chooseUrl, task);
    if (result.nextUrl && !result.nextUrl.startsWith(AUTH_CHOOSE_ACCOUNT_URL)) return result.nextUrl;
    lastError = result.error || (result.nextUrl ? `仍停在 choose-an-account: ${result.nextUrl}` : "");
  }

  if (expectedEmail) return restartAuthFromChooseAccount(client, task, chooseUrl);
  throw new Error(`choose-an-account 自动选择失败: ${lastError || "unknown"}`);
}

async function followToLocalhostCallback(client: any, startUrl: string, task?: K12Task): Promise<string> {
  let currentUrl = startUrl;
  for (let hop = 0; hop < 12; hop += 1) {
    if (currentUrl.startsWith(DEFAULT_OAUTH_REDIRECT_URI)) return currentUrl;
    if (currentUrl.startsWith(CODEX_CONSENT_URL)) {
      currentUrl = await continueCodexConsent(client, currentUrl, task);
      continue;
    }
    if (isAddPhoneUrl(currentUrl)) {
      throw new Error("登录后触发 add-phone 手机接码页面，按 K12 规则判定失败");
    }
    if (currentUrl.startsWith(AUTH_CHOOSE_ACCOUNT_URL)) {
      currentUrl = await chooseCurrentAuthAccount(client, task, currentUrl);
      continue;
    }
    const response = await client.fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: oauthBrowserHeaders(client),
    });
    const location = response.headers.get("location");
    if (location) {
      currentUrl = new URL(location, currentUrl).toString();
      if (currentUrl.startsWith(DEFAULT_OAUTH_REDIRECT_URI)) return currentUrl;
      if (isAddPhoneUrl(currentUrl)) {
        throw new Error("登录后触发 add-phone 手机接码页面，按 K12 规则判定失败");
      }
      continue;
    }
    if (response.url?.startsWith(DEFAULT_OAUTH_REDIRECT_URI)) return response.url;
    if (response.url?.startsWith(CODEX_CONSENT_URL)) {
      currentUrl = await continueCodexConsent(client, response.url, task);
      continue;
    }
    if (response.url && isAddPhoneUrl(response.url)) {
      throw new Error("登录后触发 add-phone 手机接码页面，按 K12 规则判定失败");
    }
    if (response.url?.startsWith(AUTH_CHOOSE_ACCOUNT_URL)) {
      currentUrl = await chooseCurrentAuthAccount(client, task, response.url);
      continue;
    }
    throw new Error(`OAuth 跳转未到达 callback: status=${response.status} url=${response.url || currentUrl}`);
  }
  throw new Error(`OAuth 跳转次数过多，最后停在 ${currentUrl}`);
}

async function continueCodexConsent(client: any, consentUrl: string, task?: K12Task): Promise<string> {
  if (task) appendLog(task, "info", "已到 Codex consent 页，优先选择 K12 workspace");
  await client.fetch(consentUrl, {
    method: "GET",
    redirect: "manual",
    headers: oauthBrowserHeaders(client, {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      referer: AUTH_BASE_URL,
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
    }),
  }).catch(() => undefined);

  try {
    const nextUrl = await selectAuthWorkspace(client, task, consentUrl);
    if (nextUrl && !nextUrl.startsWith(CODEX_CONSENT_URL)) return nextUrl;
  } catch (error) {
    if (task) appendLog(task, "warn", `consent workspace/select 不可用，改为直接 Continue: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (task) appendLog(task, "info", "Codex consent fallback：直接点击 Continue");
  const response = await client.fetch(consentUrl, {
    method: "POST",
    redirect: "manual",
    headers: oauthBrowserHeaders(client, {
      "content-type": "application/x-www-form-urlencoded",
      origin: AUTH_BASE_URL,
      referer: consentUrl,
    }),
    body: "consent=true",
  });
  const location = response.headers.get("location");
  if (location) {
    return new URL(location, consentUrl).toString();
  }
  if (response.url?.startsWith(DEFAULT_OAUTH_REDIRECT_URI)) return response.url;
  if (response.status >= 200 && response.status < 300) {
    const text = await response.text().catch(() => "");
    const callbackMatch = text.match(/http:\/\/localhost:1455\/auth\/callback\?[^"' <]+/i);
    if (callbackMatch) return callbackMatch[0].replace(/&amp;/g, "&");
  }
  throw new Error(`Codex consent Continue 未返回 callback/location: HTTP ${response.status}`);
}

async function loginViaSub2ApiAuthorizeUrl(client: any, authorizeUrl: string, task?: K12Task): Promise<string> {
  const openResponse = await client.fetch(authorizeUrl, {
    redirect: "follow",
    headers: oauthBrowserHeaders(client, {
      "accept-encoding": "gzip, deflate, br",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
    }),
  });
  if (!openResponse.ok) {
    throw new Error(`Sub2API OAuth URL 请求失败: HTTP ${openResponse.status}`);
  }
  let currentUrl = openResponse.url || authorizeUrl;
  if (currentUrl.startsWith(DEFAULT_OAUTH_REDIRECT_URI)) return currentUrl;
  if (isAddPhoneUrl(currentUrl)) {
    throw new Error("登录后触发 add-phone 手机接码页面，按 K12 规则判定失败");
  }
  if (currentUrl.startsWith(AUTH_CHOOSE_ACCOUNT_URL)) {
    currentUrl = await chooseCurrentAuthAccount(client, task, currentUrl);
    return followToLocalhostCallback(client, currentUrl, task);
  }

  if (currentUrl === CODEX_CONSENT_URL) {
    currentUrl = await continueCodexConsent(client, currentUrl, task);
    return followToLocalhostCallback(client, currentUrl, task);
  }

  if (currentUrl === `${AUTH_BASE_URL}/log-in`) {
    let continueUrl = await loginAuthFlowWithEmailOtp(client, task, {allowConsent: true});
    return followToLocalhostCallback(client, continueUrl, task);
  }

  if (currentUrl.startsWith(CODEX_CONSENT_URL)) {
    currentUrl = await continueCodexConsent(client, currentUrl, task);
    return followToLocalhostCallback(client, currentUrl, task);
  }

  return followToLocalhostCallback(client, currentUrl, task);
}

async function runK12WorkspaceJoin(client: any, task: K12Task, email: EmailRecord, accessToken: string): Promise<string> {
  if (!task.runWorkspaceJoin) return accessToken;
  if (!accessToken) {
    throw new Error("K12 空间执行需要 AT：请启用 Sub2API OAuth，或先建立 ChatGPT Web session 后从 /api/auth/session 获取 accessToken");
  }
  let latestToken = accessToken;
  for (const workspaceId of task.workspaceIds) {
    if (task.workspaceResults.some((item) => item.workspaceId === workspaceId && item.route === task.route)) continue;
    const result = await sendK12Invite(task, client, latestToken, workspaceId, task.route);
    task.workspaceResults.push(result);
    await persistTasks();
    if (result.ok) {
      await checkK12WorkspaceMembership(client, task, latestToken, workspaceId);
      const switchedToken = await switchToK12WorkspaceAccessToken(client, task, latestToken, workspaceId);
      if (switchedToken !== latestToken) {
        latestToken = switchedToken;
        recordAccessToken(task, email, latestToken);
        await appendTokenOut(latestToken);
      }
    }
    if (task.workspaceIds.length > 1) await sleep(appConfig.joinIntervalMs);
  }
  return latestToken;
}

async function runTask(task: K12Task): Promise<void> {
  const email = emails.find((item) => item.id === task.emailId);
  if (!email) {
    task.status = "failed";
    task.error = "邮箱记录不存在";
    task.finishedAt = nowIso();
    await persistTasks();
    return;
  }
  if (email.status === "banned") {
    task.status = "failed";
    task.error = "邮箱已标记封号，跳过任务";
    task.finishedAt = nowIso();
    task.updatedAt = nowIso();
    appendLog(task, "error", task.error);
    await persistTasks();
    return;
  }

  task.status = "running";
  task.startedAt = nowIso();
  task.updatedAt = nowIso();
  email.status = "running";
  email.lastTaskId = task.id;
  email.lastError = "";
  await Promise.all([persistTasks(), persistEmails()]);

  try {
    process.env.OPENAI_PROXY_URL = appConfig.defaultProxyUrl || "direct";
    process.env.DEFAULT_PROXY_URL = appConfig.defaultProxyUrl || "direct";
    process.env.OPENAI_FETCH_TIMEOUT_MS = String(appConfig.openaiFetchTimeoutMs);
    await ensureSentinelSdk();

    const client = await createOpenAIClientForEmail(task, email);
    const useNoRtMode = task.sub2apiNoRtMode === true;

    let accessToken = "";
    let jsonCredentials: Record<string, unknown> | undefined;
    let jsonSource = "gpt-k12";
    if (task.runWorkspaceJoin) {
      accessToken = await loginChatGptWebAndGetAccessToken(client, task, email.email);
      recordAccessToken(task, email, accessToken);
      await appendTokenOut(accessToken);
    }

    if (task.runSub2Api) {
      assertNotCanceled(task);
      if (!appConfig.sub2apiUrl || !appConfig.sub2apiEmail || !appConfig.sub2apiPassword) {
        throw new Error("Sub2API 配置不完整：地址、账号、密码均不能为空");
      }
      if (useNoRtMode) {
        appendLog(task, "info", "Sub2API noRT 模式已开启：跳过 OAuth，先加入/切换 K12，再用 K12 AT 入库");
        if (!accessToken) {
          accessToken = await loginChatGptWebAndGetAccessToken(client, task, email.email);
          recordAccessToken(task, email, accessToken);
          await appendTokenOut(accessToken);
        }
        accessToken = await runK12WorkspaceJoin(client, task, email, accessToken);
        accessToken = await ensureK12AccessTokenForNoRt(client, task, accessToken);
        recordAccessToken(task, email, accessToken);
        await appendTokenOut(accessToken);
        const accountName = await upsertSub2ApiNoRtAccountFromAccessToken(task, email, accessToken);
        task.sub2apiAccount = accountName;
        email.sub2apiAccount = accountName;
        jsonSource = "gpt-k12-nort";
      } else {
        try {
          const {Sub2ApiClient} = await loadBundleModules();
          appendLog(task, "info", `Sub2API OA 授权入库，分组 ${task.sub2apiGroupName || appConfig.sub2apiGroupName || "k12"}`);
          const sub2api = new Sub2ApiClient({
            url: appConfig.sub2apiUrl,
            email: appConfig.sub2apiEmail,
            password: appConfig.sub2apiPassword,
            groupName: task.sub2apiGroupName || appConfig.sub2apiGroupName,
            groupNames: [task.sub2apiGroupName || appConfig.sub2apiGroupName],
            proxyName: appConfig.sub2apiProxyName,
            accountPriority: appConfig.sub2apiAccountPriority,
            concurrency: appConfig.sub2apiConcurrency,
          });
          const prepared = await sub2api.prepareOpenAiOAuth();
          appendLog(task, "info", `Sub2API OAuth URL 已生成: ${prepared.groupLabel}`);
          const callbackUrl = await loginViaSub2ApiAuthorizeUrl(client, prepared.oauthUrl, task);
          appendLog(task, "info", "OAuth callback 已获取，交给 Sub2API exchange-code");
          const accountName = `${email.email}---${task.sub2apiGroupName || appConfig.sub2apiGroupName}`;
          const created = await sub2api.exchangeCallbackAndCreateAccount(
            prepared,
            callbackUrl,
            email.email,
            accountName,
            {requireChatgptAccountId: appConfig.requireChatgptAccountId},
          );
          task.sub2apiAccount = created.accountName;
          email.sub2apiAccount = created.accountName;
          jsonCredentials = created.credentials || {};
          jsonSource = "gpt-k12-oauth";
          appendLog(task, "ok", `Sub2API 账号已创建: ${created.accountName}`);
          if (!accessToken) {
            accessToken = extractAccessTokenFromCredentials(created.credentials || {});
            if (!accessToken) {
              throw new Error("Sub2API OAuth 已完成，但 exchange-code 返回中缺少 access_token");
            }
            recordAccessToken(task, email, accessToken);
            await appendTokenOut(accessToken);
          }
        } catch (error) {
          if (!isAddPhoneFlowError(error)) throw error;
          appendLog(task, "warn", "Sub2API OA 授权触发 add-phone，尝试使用 K12 Web AT 创建 noRT 账号");
          if (!accessToken) {
            accessToken = await loginChatGptWebAndGetAccessToken(client, task, email.email);
            recordAccessToken(task, email, accessToken);
            await appendTokenOut(accessToken);
          }
          accessToken = await ensureK12AccessTokenForNoRt(client, task, accessToken);
          recordAccessToken(task, email, accessToken);
          await appendTokenOut(accessToken);
          const accountName = await createSub2ApiNoRtAccountFromAccessToken(task, email, accessToken);
          task.sub2apiAccount = accountName;
          email.sub2apiAccount = accountName;
          jsonSource = "gpt-k12-add-phone-fallback";
        }
      }
    }

    if (task.runWorkspaceJoin && !useNoRtMode) {
      accessToken = await runK12WorkspaceJoin(client, task, email, accessToken);
    }
    if (accessToken) {
      await tryWriteAccountJsonFile(task, email, accessToken, {
        credentials: jsonCredentials,
        accountName: task.sub2apiAccount || email.sub2apiAccount,
        source: jsonSource,
      });
    }

    task.status = "success";
    email.status = "success";
    appendLog(task, "ok", "任务完成");
  } catch (error) {
    const message = normalizeFlowError(error);
    task.status = task.cancelRequested ? "canceled" : "failed";
    task.error = message;
    if (isOpenAiAccountBannedMessage(message)) {
      markEmailBanned(email, message, task);
    } else {
      email.status = task.status === "canceled" ? "free" : "failed";
      email.lastError = message;
    }
    appendLog(task, task.status === "canceled" ? "warn" : "error", message);
  } finally {
    task.finishedAt = nowIso();
    task.updatedAt = nowIso();
    email.updatedAt = nowIso();
    activeWorkers = Math.max(0, activeWorkers - 1);
    await Promise.all([persistTasks(), persistEmails()]);
    scheduleTasks();
  }
}

async function runAtRepairTask(task: K12Task): Promise<void> {
  const email = emails.find((item) => item.id === task.emailId);
  if (!email) {
    task.status = "failed";
    task.error = "邮箱记录不存在";
    task.finishedAt = nowIso();
    await persistTasks();
    return;
  }
  if (email.status === "banned") {
    task.status = "failed";
    task.error = "邮箱已标记封号，跳过 AT 修复";
    task.finishedAt = nowIso();
    task.updatedAt = nowIso();
    appendLog(task, "error", task.error);
    await persistTasks();
    return;
  }

  task.status = "running";
  task.startedAt = nowIso();
  task.updatedAt = nowIso();
  email.status = "running";
  email.lastTaskId = task.id;
  email.lastError = "";
  await Promise.all([persistTasks(), persistEmails()]);

  try {
    process.env.OPENAI_PROXY_URL = appConfig.defaultProxyUrl || "direct";
    process.env.DEFAULT_PROXY_URL = appConfig.defaultProxyUrl || "direct";
    process.env.OPENAI_FETCH_TIMEOUT_MS = String(appConfig.openaiFetchTimeoutMs);

    const {origin, token: adminToken} = await loginSub2ApiAdmin();
    const names = expectedSub2ApiAccountNames(email, task.sub2apiGroupName || appConfig.sub2apiGroupName);
    appendLog(task, "info", `按名称查找 Sub2API 账号: ${names.join(" / ")}`);
    const account = await findSub2ApiAccountByName(origin, adminToken, names);
    if (!account) {
      appendLog(task, "warn", `Sub2API 未找到账号，改为重新获取 K12 AT 后新增账号: ${names.join(" / ")}`);
      const client = await createOpenAIClientForEmail(task, email);
      let newAccessToken = await loginChatGptWebAndGetAccessToken(client, task, email.email);
      newAccessToken = await ensureK12AccessTokenForNoRt(client, task, newAccessToken);
      recordAccessToken(task, email, newAccessToken);
      await appendTokenOut(newAccessToken);
      const createdName = await createSub2ApiNoRtAccountFromAccessToken(task, email, newAccessToken);
      task.sub2apiAccount = createdName;
      email.sub2apiAccount = createdName;
      await tryWriteAccountJsonFile(task, email, newAccessToken, {accountName: createdName, source: "gpt-k12-at-repair-create"});
      task.status = "success";
      email.status = "success";
      appendLog(task, "ok", `Sub2API 未有旧账号，已新增账号: ${createdName}`);
      return;
    }

    const accountId = sub2ApiAccountId(account);
    const accountName = sub2ApiAccountName(account);
    if (!accountId) throw new Error(`Sub2API 账号缺少 id: ${accountName || "(unknown)"}`);
    task.sub2apiAccount = accountName;
    email.sub2apiAccount = accountName;
    appendLog(task, "info", `已找到 Sub2API 账号: ${accountName}#${accountId}`);

    const credentials = sub2ApiAccountCredentials(account);
    const oldAccessToken = extractAccessTokenFromCredentials(credentials);
    if (oldAccessToken) {
      const local = await testOpenAiAccessToken(oldAccessToken);
      appendLog(task, local.ok ? "ok" : "warn", `当前 AT 在线检验: ${local.message}`);
      if (local.banned) {
        markEmailBanned(email, "GPT 账号已被 OpenAI 停用/封禁，停止 AT 修复", task);
        task.status = "failed";
        return;
      }
      if (local.ok) {
        recordAccessToken(task, email, oldAccessToken);
        await tryWriteAccountJsonFile(task, email, oldAccessToken, {
          credentials,
          accountName,
          source: "gpt-k12-at-repair-existing",
        });
        task.status = "success";
        email.status = "success";
        appendLog(task, "ok", "当前 AT 仍可用，无需更新 Sub2API");
        return;
      }
    } else {
      appendLog(task, "warn", "Sub2API 账号缺少 credentials.access_token，准备重新获取");
    }

    const sub2apiTest = await testSub2ApiAccountLiveness(origin, adminToken, accountId);
    appendLog(task, sub2apiTest.ok ? "ok" : "warn", `Sub2API 账号测活: ${sub2apiTest.message}`);
    if (sub2apiTest.ok && oldAccessToken) {
      recordAccessToken(task, email, oldAccessToken);
      await tryWriteAccountJsonFile(task, email, oldAccessToken, {
        credentials,
        accountName,
        source: "gpt-k12-at-repair-sub2api-ok",
      });
      task.status = "success";
      email.status = "success";
      appendLog(task, "ok", "Sub2API 测活通过，无需更新");
      return;
    }

    appendLog(task, "warn", "AT 不可用，开始重新登录获取新 K12 AT");
    const client = await createOpenAIClientForEmail(task, email);
    let newAccessToken = await loginChatGptWebAndGetAccessToken(client, task, email.email);
    newAccessToken = await ensureK12AccessTokenForNoRt(client, task, newAccessToken);
    recordAccessToken(task, email, newAccessToken);
    await appendTokenOut(newAccessToken);

    await updateSub2ApiAccountAccessToken(origin, adminToken, account, email, newAccessToken);
    await tryWriteAccountJsonFile(task, email, newAccessToken, {
      credentials,
      accountName,
      source: "gpt-k12-at-repair-updated",
    });
    appendLog(task, "ok", `Sub2API 账号 AT 已更新: ${accountName}#${accountId}`);
    task.status = "success";
    email.status = "success";
  } catch (error) {
    const message = normalizeFlowError(error);
    task.status = task.cancelRequested ? "canceled" : "failed";
    task.error = message;
    if (isOpenAiAccountBannedMessage(message)) {
      markEmailBanned(email, message, task);
    } else {
      email.status = task.status === "canceled" ? "free" : "failed";
      email.lastError = message;
    }
    appendLog(task, task.status === "canceled" ? "warn" : "error", message);
  } finally {
    task.finishedAt = nowIso();
    task.updatedAt = nowIso();
    email.updatedAt = nowIso();
    activeWorkers = Math.max(0, activeWorkers - 1);
    await Promise.all([persistTasks(), persistEmails()]);
    scheduleTasks();
  }
}

function scheduleTasks(): void {
  const limit = Math.max(1, appConfig.taskConcurrency);
  for (const task of tasks) {
    if (task.status !== "queued") continue;
    const email = emails.find((item) => item.id === task.emailId);
    if (email?.status !== "banned") continue;
    task.status = "failed";
    task.error = email.lastError || "邮箱已标记封号，队列任务跳过";
    task.finishedAt = nowIso();
    task.updatedAt = nowIso();
    appendLog(task, "error", task.error);
  }
  while (activeWorkers < limit) {
    const activeRoots = new Set(
      tasks
        .filter((item) => item.status === "running")
        .map((item) => rootMailboxIdentityByEmailId(item.emailId)),
    );
    const task = tasks.find((item) => (
      item.status === "queued"
      && !item.cancelRequested
      && emails.find((email) => email.id === item.emailId)?.status !== "banned"
      && !activeRoots.has(rootMailboxIdentityByEmailId(item.emailId))
    ));
    if (!task) break;
    activeRoots.add(rootMailboxIdentityByEmailId(task.emailId));
    activeWorkers += 1;
    void (task.kind === "at-repair" ? runAtRepairTask(task) : runTask(task));
  }
}

function createTasks(body: Record<string, unknown>): {created: K12Task[]; skippedRunning: number; missing: number} {
  const requestedEmailIds = Array.isArray(body.emailIds)
    ? body.emailIds.map((item) => String(item)).filter(Boolean)
    : [];
  const requested = new Set(requestedEmailIds);
  const existingIds = new Set(emails.map((item) => item.id));
  const missing = requestedEmailIds.filter((id) => !existingIds.has(id)).length;
  const selectedEmails = requestedEmailIds.length
    ? emails.filter((item) => requested.has(item.id))
    : emails.filter((item) => item.status === "free");
  const limit = asNumber(body.count, selectedEmails.length || 1, 1, 500);
  const workspaceCandidates = uniqueStringList(parseStringList(body.workspaceIds).length ? parseStringList(body.workspaceIds) : appConfig.workspaceIds);
  const route = body.route === "accept" ? "accept" : appConfig.route;
  const runSub2Api = asBoolean(body.runSub2Api, appConfig.runSub2Api);
  const sub2apiNoRtMode = runSub2Api && asBoolean(body.sub2apiNoRtMode, appConfig.sub2apiNoRtMode);
  const runWorkspaceJoin = sub2apiNoRtMode ? true : asBoolean(body.runWorkspaceJoin, appConfig.runWorkspaceJoin);
  const sub2apiGroupName = asString(body.sub2apiGroupName, appConfig.sub2apiGroupName) || "k12";
  const created: K12Task[] = [];
  let skippedRunning = 0;

  for (const email of selectedEmails.slice(0, limit)) {
    if (email.status === "running" || email.status === "banned" || hasActiveTask(email.id)) {
      skippedRunning += 1;
      continue;
    }
    const pickedWorkspaceId = randomItem(workspaceCandidates);
    const taskWorkspaceIds = pickedWorkspaceId ? [pickedWorkspaceId] : [];
    const task: K12Task = {
      id: `k12_${Date.now()}_${randomUUID().slice(0, 8)}`,
      kind: "k12",
      emailId: email.id,
      email: email.email,
      status: "queued",
      route,
      workspaceIds: taskWorkspaceIds,
      runWorkspaceJoin,
      runSub2Api,
      sub2apiNoRtMode,
      sub2apiGroupName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      workspaceResults: [],
      logs: [],
    };
    appendLog(
      task,
      "info",
      `已排队: ${email.email}${workspaceCandidates.length > 1 && pickedWorkspaceId ? `，随机 workspace=${pickedWorkspaceId}` : ""}`,
    );
    tasks.push(task);
    email.status = "running";
    email.lastTaskId = task.id;
    created.push(task);
  }
  void Promise.all([persistTasks(), persistEmails()]);
  scheduleTasks();
  return {created, skippedRunning, missing};
}

function createAtRepairTasks(body: Record<string, unknown>): {created: K12Task[]; skippedRunning: number; missing: number; skippedNoAccount: number} {
  const requestedEmailIds = Array.isArray(body.emailIds)
    ? body.emailIds.map((item) => String(item)).filter(Boolean)
    : [];
  const requested = new Set(requestedEmailIds);
  const existingIds = new Set(emails.map((item) => item.id));
  const missing = requestedEmailIds.filter((id) => !existingIds.has(id)).length;
  const selectedEmails = emails.filter((item) => requested.has(item.id));
  const sub2apiGroupName = asString(body.sub2apiGroupName, appConfig.sub2apiGroupName) || "k12";
  const created: K12Task[] = [];
  let skippedRunning = 0;
  let skippedNoAccount = 0;

  for (const email of selectedEmails) {
    if (email.status === "running" || email.status === "banned" || hasActiveTask(email.id)) {
      skippedRunning += 1;
      continue;
    }
    const task: K12Task = {
      id: `at_repair_${Date.now()}_${randomUUID().slice(0, 8)}`,
      kind: "at-repair",
      emailId: email.id,
      email: email.email,
      status: "queued",
      route: appConfig.route,
      workspaceIds: appConfig.workspaceIds,
      runWorkspaceJoin: false,
      runSub2Api: false,
      sub2apiGroupName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      workspaceResults: [],
      logs: [],
    };
    appendLog(task, "info", `AT 修复已排队: ${email.email}`);
    tasks.push(task);
    email.status = "running";
    email.lastTaskId = task.id;
    email.lastError = "";
    created.push(task);
  }

  void Promise.all([persistTasks(), persistEmails()]);
  scheduleTasks();
  return {created, skippedRunning, missing, skippedNoAccount};
}

function retryTask(source: K12Task): K12Task {
  if (!["failed", "canceled"].includes(source.status)) {
    throw new Error("只能重试失败或已取消的任务");
  }
  const email = emails.find((item) => item.id === source.emailId);
  if (!email) throw new Error("邮箱记录不存在");
  if (email.status === "running") throw new Error("该邮箱当前正在运行，不能重复重试");
  if (email.status === "banned") throw new Error("该邮箱已标记封号，不能重试");

  const task: K12Task = {
    id: `k12_${Date.now()}_${randomUUID().slice(0, 8)}`,
    kind: source.kind || "k12",
    emailId: source.emailId,
    email: source.email,
    status: "queued",
    route: source.route,
    workspaceIds: source.workspaceIds,
    runWorkspaceJoin: source.runWorkspaceJoin,
    runSub2Api: source.runSub2Api,
    sub2apiNoRtMode: source.sub2apiNoRtMode === true,
    sub2apiGroupName: source.sub2apiGroupName || appConfig.sub2apiGroupName || "k12",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    workspaceResults: [],
    logs: [],
  };
  appendLog(task, "info", `重试任务，来源: ${source.id}`);
  tasks.push(task);
  email.status = "running";
  email.lastTaskId = task.id;
  email.lastError = "";
  void Promise.all([persistTasks(), persistEmails()]);
  scheduleTasks();
  return task;
}

function clearFailedTasks(): {removed: number} {
  const failedTasks = tasks.filter((task) => task.status === "failed");
  if (!failedTasks.length) return {removed: 0};
  const removedIds = new Set(failedTasks.map((task) => task.id));
  tasks = tasks.filter((task) => !removedIds.has(task.id));
  for (const email of emails) {
    if (email.lastTaskId && removedIds.has(email.lastTaskId)) {
      delete email.lastTaskId;
      email.updatedAt = nowIso();
    }
  }
  return {removed: removedIds.size};
}

function publicTask(task: K12Task): Record<string, unknown> {
  return {
    ...task,
    logs: task.logs.slice(-240),
  };
}

function summary(): Record<string, unknown> {
  const countByStatus = (items: Array<{status: string}>, status: string) => items.filter((item) => item.status === status).length;
  return {
    emails: {
      total: emails.length,
      free: countByStatus(emails, "free"),
      running: countByStatus(emails, "running"),
      success: countByStatus(emails, "success"),
      failed: countByStatus(emails, "failed"),
      banned: countByStatus(emails, "banned"),
    },
    tasks: {
      total: tasks.length,
      queued: countByStatus(tasks, "queued"),
      running: countByStatus(tasks, "running"),
      success: countByStatus(tasks, "success"),
      failed: countByStatus(tasks, "failed"),
      canceled: countByStatus(tasks, "canceled"),
    },
    config: publicConfig(),
  };
}

function reconcileEmailStatusesFromTasks(): boolean {
  let changed = false;
  for (const email of emails) {
    if (email.status === "banned") continue;
    const related = tasks
      .filter((task) => task.emailId === email.id)
      .sort((a, b) => String(b.finishedAt || b.updatedAt || b.createdAt).localeCompare(String(a.finishedAt || a.updatedAt || a.createdAt)));
    const latestActive = related.find((task) => task.status === "queued" || task.status === "running");
    if (latestActive) {
      if (email.status !== "running") {
        email.status = "running";
        changed = true;
      }
      if (email.lastTaskId !== latestActive.id) {
        email.lastTaskId = latestActive.id;
        changed = true;
      }
      continue;
    }

    const latestSuccess = related.find((task) => task.status === "success");
    if (latestSuccess) {
      if (email.status !== "success") {
        email.status = "success";
        changed = true;
      }
      if (email.lastTaskId !== latestSuccess.id) {
        email.lastTaskId = latestSuccess.id;
        changed = true;
      }
      if (!email.sub2apiAccount && latestSuccess.sub2apiAccount) {
        email.sub2apiAccount = latestSuccess.sub2apiAccount;
        changed = true;
      }
      if (email.lastError) {
        email.lastError = "";
        changed = true;
      }
      continue;
    }

    const latestFailed = related.find((task) => task.status === "failed");
    if (latestFailed) {
      if (email.status !== "failed" && !email.sub2apiAccount) {
        email.status = "failed";
        changed = true;
      }
      if (email.lastTaskId !== latestFailed.id) {
        email.lastTaskId = latestFailed.id;
        changed = true;
      }
      const nextError = latestFailed.error || email.lastError || "";
      if (email.lastError !== nextError) {
        email.lastError = nextError;
        changed = true;
      }
      continue;
    }

    if (email.status === "running") {
      email.status = "free";
      delete email.lastTaskId;
      email.lastError = "";
      changed = true;
    }
  }
  return changed;
}

async function reconcileAndPersistEmailStatuses(): Promise<boolean> {
  const changed = reconcileEmailStatusesFromTasks();
  if (changed) await persistEmails();
  return changed;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 50 * 1024 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = `${JSON.stringify(data, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJsonDownload(res: ServerResponse, data: unknown, filename: string): void {
  const safeFilename = filename.replace(/[^\w.-]+/g, "_");
  const body = `${JSON.stringify(data, null, 2)}\n`;
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${safeFilename}"`,
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {"content-type": contentType});
  res.end(body);
}

async function serveStatic(url: URL, res: ServerResponse): Promise<boolean> {
  const distDir = path.join(rootDir, "dist");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(distDir, pathname));
  if (!filePath.startsWith(distDir) || !existsSync(filePath)) return false;
  const info = await stat(filePath);
  if (!info.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const contentType = ext === ".html"
    ? "text/html; charset=utf-8"
    : ext === ".js"
      ? "text/javascript; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : "application/octet-stream";
  sendText(res, 200, await readFile(filePath, "utf8"), contentType);
  return true;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method || "GET";
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/api/health") {
    await reconcileAndPersistEmailStatuses();
    sendJson(res, 200, {ok: true, rootDir, dataDir, summary: summary()});
    return;
  }

  if (method === "GET" && pathname === "/api/summary") {
    await reconcileAndPersistEmailStatuses();
    sendJson(res, 200, summary());
    return;
  }

  if (method === "POST" && pathname === "/api/emails/reconcile") {
    const changed = await reconcileAndPersistEmailStatuses();
    sendJson(res, 200, {changed, summary: summary()});
    return;
  }

  if (method === "GET" && pathname === "/api/data/export") {
    sendJsonDownload(res, await buildDataExport(), `gpt-k12-data-${new Date().toISOString().slice(0, 10)}.json`);
    return;
  }

  if (method === "POST" && pathname === "/api/data/import") {
    try {
      const body = await readJsonBody(req);
      const result = await importDataBundle(body);
      sendJson(res, 200, {...result, summary: summary()});
    } catch (error) {
      sendJson(res, 409, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (method === "GET" && pathname === "/api/config") {
    sendJson(res, 200, {config: publicConfig()});
    return;
  }

  if ((method === "PATCH" || method === "POST") && pathname === "/api/config") {
    const body = await readJsonBody(req);
    const merged = normalizeConfig({
      ...appConfig,
      ...body,
      defaultPassword: asString(body.defaultPassword) || appConfig.defaultPassword,
      sub2apiPassword: asString(body.sub2apiPassword) || appConfig.sub2apiPassword,
    });
    await saveConfig(merged);
    sendJson(res, 200, {config: publicConfig()});
    return;
  }

  if (method === "GET" && pathname === "/api/emails") {
    await reconcileAndPersistEmailStatuses();
    sendJson(res, 200, {items: emails.map(publicEmail), count: emails.length});
    return;
  }

  if (method === "POST" && pathname === "/api/emails/import") {
    const body = await readJsonBody(req);
    if (asString(body.mailApiBaseUrl)) {
      await saveConfig(normalizeConfig({...appConfig, mailApiBaseUrl: asString(body.mailApiBaseUrl)}));
    }
    const result = await importEmails(String(body.text || ""), appConfig);
    sendJson(res, 200, result);
    return;
  }

  if (method === "POST" && pathname === "/api/emails/delete") {
    const body = await readJsonBody(req);
    let ids = Array.isArray(body.ids) ? body.ids.map((item) => String(item)).filter(Boolean) : [];
    const status = asString(body.status);
    if (status) {
      const allowed = new Set(["free", "failed", "success", "banned"]);
      if (!allowed.has(status)) {
        sendJson(res, 400, {error: "status 只能是 free、failed、success 或 banned"});
        return;
      }
      ids = emails.filter((item) => item.status === status).map((item) => item.id);
    }
    const result = removeEmails(ids);
    await persistEmails();
    sendJson(res, 200, result);
    return;
  }

  if (method === "POST" && pathname === "/api/emails/split") {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map((item) => String(item)).filter(Boolean) : [];
    const count = asNumber(body.count, 4, 1, 50);
    if (!ids.length) {
      sendJson(res, 400, {error: "请选择至少一个母邮箱"});
      return;
    }
    const result = splitEmails(ids, count);
    await persistEmails();
    sendJson(res, 200, {...result, total: emails.length});
    return;
  }

  if (method === "POST" && pathname === "/api/emails/check-at") {
    const body = await readJsonBody(req);
    try {
      const result = await checkSub2ApiAccessTokens(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (method === "DELETE" && pathname.startsWith("/api/emails/")) {
    const id = decodeURIComponent(pathname.split("/").pop() || "");
    const result = removeEmails([id]);
    await persistEmails();
    sendJson(res, 200, result);
    return;
  }

  if (method === "GET" && pathname === "/api/tasks") {
    if (await hydrateTaskAccessTokensFromTokenOut()) await persistTasks();
    sendJson(res, 200, {items: tasks.map(publicTask).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), count: tasks.length});
    return;
  }

  if (method === "POST" && pathname === "/api/tasks") {
    const body = await readJsonBody(req);
    if (body.concurrency !== undefined) {
      await saveConfig(normalizeConfig({...appConfig, taskConcurrency: asNumber(body.concurrency, appConfig.taskConcurrency, 1, 10)}));
    }
    const result = createTasks(body);
    sendJson(res, 201, {
      tasks: result.created.map(publicTask),
      skippedRunning: result.skippedRunning,
      missing: result.missing,
    });
    return;
  }

  if (method === "POST" && pathname === "/api/tasks/repair-at") {
    const body = await readJsonBody(req);
    const result = createAtRepairTasks(body);
    sendJson(res, 201, {
      tasks: result.created.map(publicTask),
      skippedRunning: result.skippedRunning,
      missing: result.missing,
      skippedNoAccount: result.skippedNoAccount,
    });
    return;
  }

  if (method === "POST" && pathname === "/api/tasks/check-at") {
    const body = await readJsonBody(req);
    try {
      const result = await checkTaskAccessTokens(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (method === "POST" && pathname === "/api/tasks/clear-failed") {
    const result = clearFailedTasks();
    await Promise.all([persistTasks(), persistEmails()]);
    sendJson(res, 200, result);
    return;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(cancel|retry|check-at))?$/);
  if (taskMatch) {
    const task = tasks.find((item) => item.id === decodeURIComponent(taskMatch[1]));
    if (!task) {
      sendJson(res, 404, {error: "task not found"});
      return;
    }
    if (method === "POST" && taskMatch[2] === "cancel") {
      task.cancelRequested = true;
      if (task.status === "queued") {
        task.status = "canceled";
        task.finishedAt = nowIso();
        appendLog(task, "warn", "任务已取消");
      } else {
        appendLog(task, "warn", "已请求取消，当前步骤结束后生效");
      }
      await persistTasks();
      sendJson(res, 200, {task: publicTask(task)});
      return;
    }
    if (method === "POST" && taskMatch[2] === "retry") {
      try {
        const created = retryTask(task);
        sendJson(res, 201, {task: publicTask(created)});
      } catch (error) {
        sendJson(res, 409, {error: error instanceof Error ? error.message : String(error)});
      }
      return;
    }
    if (method === "POST" && taskMatch[2] === "check-at") {
      try {
        const result = await checkTaskAccessToken(task);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 409, {error: error instanceof Error ? error.message : String(error)});
      }
      return;
    }
    if (method === "DELETE" && !taskMatch[2]) {
      if (!["failed", "canceled"].includes(task.status)) {
        sendJson(res, 409, {error: "只能删除失败或已取消的任务"});
        return;
      }
      tasks = tasks.filter((item) => item.id !== task.id);
      const email = emails.find((item) => item.id === task.emailId);
      if (email?.lastTaskId === task.id) {
        delete email.lastTaskId;
        email.updatedAt = nowIso();
      }
      await Promise.all([persistTasks(), persistEmails()]);
      sendJson(res, 200, {removed: 1});
      return;
    }
    if (method === "GET" && !taskMatch[2]) {
      sendJson(res, 200, {task: publicTask(task)});
      return;
    }
  }

  sendJson(res, 404, {error: "not found"});
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (await serveStatic(url, res)) return;
    sendJson(res, 404, {error: "not found"});
  } catch (error) {
    sendJson(res, 500, {error: error instanceof Error ? error.message : String(error)});
  }
}

async function boot(): Promise<void> {
  await mkdir(dataDir, {recursive: true});
  appConfig = await loadConfig();
  await saveConfig(appConfig);
  await ensureSentinelSdk();
  emails = await readJson<EmailRecord[]>(emailsFile, []);
  tasks = await readJson<K12Task[]>(tasksFile, []);
  for (const task of tasks) {
    if (task.status === "running" || task.status === "queued") {
      task.status = "failed";
      task.error = "server restarted before task finished";
      task.finishedAt = nowIso();
      appendLog(task, "warn", "服务重启，未完成任务已标记失败");
    }
  }
  await hydrateTaskAccessTokensFromTokenOut();
  await persistTasks();
  await reconcileAndPersistEmailStatuses();

  createServer((req, res) => {
    void handler(req, res);
  }).listen(appConfig.port, "0.0.0.0", () => {
    console.log(`K12 console API listening: http://127.0.0.1:${appConfig.port}/`);
  });
}

void boot();
