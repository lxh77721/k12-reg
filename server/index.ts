import {createHash, randomUUID} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdir, readFile, stat, writeFile} from "node:fs/promises";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {fetch as undiciFetch, ProxyAgent} from "undici";

type K12Route = "request" | "accept";
type TaskStatus = "queued" | "running" | "success" | "failed" | "canceled";
type LogLevel = "info" | "ok" | "warn" | "error";

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
  sub2apiUrl: string;
  sub2apiEmail: string;
  sub2apiPassword: string;
  sub2apiGroupName: string;
  sub2apiProxyName: string;
  sub2apiAccountPriority: number;
  sub2apiConcurrency: number;
  requireChatgptAccountId: boolean;
  tokenOut: string;
}

interface EmailRecord {
  id: string;
  email: string;
  password: string;
  mailboxUrl: string;
  clientId?: string;
  refreshToken?: string;
  raw: string;
  status: "free" | "running" | "success" | "failed";
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
  emailId: string;
  email: string;
  status: TaskStatus;
  route: K12Route;
  workspaceIds: string[];
  runWorkspaceJoin: boolean;
  runSub2Api: boolean;
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
  workspaceResults: K12WorkspaceResult[];
  sub2apiAccount?: string;
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
    sub2apiUrl: asString(ref.sub2apiUrl, ""),
    sub2apiEmail: asString(ref.sub2apiEmail, ""),
    sub2apiPassword: asString(ref.sub2apiPassword, ""),
    sub2apiGroupName: "k12",
    sub2apiProxyName: asString(ref.sub2apiProxyName, ""),
    sub2apiAccountPriority: asNumber(ref.sub2apiAccountPriority, 1, 1),
    sub2apiConcurrency: asNumber(ref.sub2apiConcurrency, 10, 1),
    requireChatgptAccountId: true,
    tokenOut,
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
    sub2apiUrl: asString(raw.sub2apiUrl),
    sub2apiEmail: asString(raw.sub2apiEmail),
    sub2apiPassword: String(raw.sub2apiPassword || ""),
    sub2apiGroupName: asString(raw.sub2apiGroupName, "k12") || "k12",
    sub2apiProxyName: asString(raw.sub2apiProxyName),
    sub2apiAccountPriority: asNumber(raw.sub2apiAccountPriority, 1, 1),
    sub2apiConcurrency: asNumber(raw.sub2apiConcurrency, 10, 1),
    requireChatgptAccountId: asBoolean(raw.requireChatgptAccountId, true),
    tokenOut: asString(raw.tokenOut) || path.join(rootDir, "pool_tokens.txt"),
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
    sub2apiUrl: appConfig.sub2apiUrl,
    sub2apiEmail: appConfig.sub2apiEmail,
    sub2apiPassword: appConfig.sub2apiPassword,
    sub2apiGroupName: appConfig.sub2apiGroupName,
    sub2apiGroupNames: [appConfig.sub2apiGroupName],
    sub2apiProxyName: appConfig.sub2apiProxyName,
    sub2apiAccountPriority: appConfig.sub2apiAccountPriority,
    sub2apiConcurrency: appConfig.sub2apiConcurrency,
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

async function importEmails(text: string, config = appConfig): Promise<{added: number; updated: number; invalid: number; total: number; invalidSamples: string[]}> {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let added = 0;
  let updated = 0;
  let invalid = 0;
  const invalidSamples: string[] = [];
  const byEmail = new Map(emails.map((item) => [item.email.toLowerCase(), item]));

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
  return {added, updated, invalid, total: emails.length, invalidSamples};
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
    const result = await sendK12Invite(task, client, latestToken, workspaceId, task.route);
    task.workspaceResults.push(result);
    await persistTasks();
    if (!result.ok) continue;
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

function normalizeSub2ApiOrigin(rawUrl: string): string {
  const normalized = asString(rawUrl).replace(/\/+$/, "");
  if (!normalized) throw new Error("Sub2API 地址为空");
  return new URL(normalized).origin;
}

async function requestSub2ApiJson(
  origin: string,
  pathname: string,
  options: {method?: string; token?: string; body?: unknown; timeoutMs?: number} = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, options.timeoutMs ?? 30000));
  try {
    const response = await fetch(`${origin}${pathname}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
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

async function createSub2ApiNoRtAccountFromAccessToken(task: K12Task, email: EmailRecord, accessToken: string): Promise<string> {
  const groupName = task.sub2apiGroupName || appConfig.sub2apiGroupName || "k12";
  const origin = normalizeSub2ApiOrigin(appConfig.sub2apiUrl);
  const loginData = (await requestSub2ApiJson(origin, "/api/v1/auth/login", {
    method: "POST",
    body: {email: appConfig.sub2apiEmail, password: appConfig.sub2apiPassword},
  })) as Record<string, unknown>;
  const adminToken = asString(loginData.access_token || loginData.accessToken);
  if (!adminToken) throw new Error("Sub2API 登录响应缺少 access_token");

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
  if (task) appendLog(task, "info", "已到 Codex consent 页，直接点击 Continue");
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

async function runTask(task: K12Task): Promise<void> {
  const email = emails.find((item) => item.id === task.emailId);
  if (!email) {
    task.status = "failed";
    task.error = "邮箱记录不存在";
    task.finishedAt = nowIso();
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

    const {OpenAIClient, generateRandomDeviceProfile, Sub2ApiClient, MailboxUrlCodeProvider} = await loadBundleModules();
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

    const client = new OpenAIClient({
      email: email.email,
      password: appConfig.defaultPassword,
      deviceProfile: generateRandomDeviceProfile(),
      signupScreenHint: "signup",
      bindEmail: email.email,
      fetchEmailOtp: () => fetchOtp("登录"),
      fetchAddEmailOtp: () => fetchOtp("绑定邮箱"),
    });

    let accessToken = "";
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
      try {
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
      }
    }

    if (task.runWorkspaceJoin) {
      if (!accessToken) {
        throw new Error("K12 空间执行需要 AT：请启用 Sub2API OAuth，或先建立 ChatGPT Web session 后从 /api/auth/session 获取 accessToken");
      }
      for (const workspaceId of task.workspaceIds) {
        if (task.workspaceResults.some((item) => item.workspaceId === workspaceId && item.route === task.route)) continue;
        const result = await sendK12Invite(task, client, accessToken, workspaceId, task.route);
        task.workspaceResults.push(result);
        await persistTasks();
        if (result.ok) {
          await checkK12WorkspaceMembership(client, task, accessToken, workspaceId);
          const switchedToken = await switchToK12WorkspaceAccessToken(client, task, accessToken, workspaceId);
          if (switchedToken !== accessToken) {
            accessToken = switchedToken;
            recordAccessToken(task, email, accessToken);
            await appendTokenOut(accessToken);
          }
        }
        if (task.workspaceIds.length > 1) await sleep(appConfig.joinIntervalMs);
      }
    }

    task.status = "success";
    email.status = "success";
    appendLog(task, "ok", "任务完成");
  } catch (error) {
    const message = normalizeFlowError(error);
    task.status = task.cancelRequested ? "canceled" : "failed";
    task.error = message;
    email.status = task.status === "canceled" ? "free" : "failed";
    email.lastError = message;
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
  while (activeWorkers < limit) {
    const task = tasks.find((item) => item.status === "queued" && !item.cancelRequested);
    if (!task) break;
    activeWorkers += 1;
    void runTask(task);
  }
}

function createTasks(body: Record<string, unknown>): K12Task[] {
  const requestedEmailIds = Array.isArray(body.emailIds)
    ? body.emailIds.map((item) => String(item)).filter(Boolean)
    : [];
  const selectedEmails = requestedEmailIds.length
    ? emails.filter((item) => requestedEmailIds.includes(item.id))
    : emails.filter((item) => item.status === "free");
  const limit = asNumber(body.count, selectedEmails.length || 1, 1, 500);
  const workspaceIds = parseStringList(body.workspaceIds).length ? parseStringList(body.workspaceIds) : appConfig.workspaceIds;
  const route = body.route === "accept" ? "accept" : appConfig.route;
  const runWorkspaceJoin = asBoolean(body.runWorkspaceJoin, appConfig.runWorkspaceJoin);
  const runSub2Api = asBoolean(body.runSub2Api, appConfig.runSub2Api);
  const sub2apiGroupName = asString(body.sub2apiGroupName, appConfig.sub2apiGroupName) || "k12";
  const created: K12Task[] = [];

  for (const email of selectedEmails.slice(0, limit)) {
    const task: K12Task = {
      id: `k12_${Date.now()}_${randomUUID().slice(0, 8)}`,
      emailId: email.id,
      email: email.email,
      status: "queued",
      route,
      workspaceIds,
      runWorkspaceJoin,
      runSub2Api,
      sub2apiGroupName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      workspaceResults: [],
      logs: [],
    };
    appendLog(task, "info", `已排队: ${email.email}`);
    tasks.push(task);
    email.status = "running";
    email.lastTaskId = task.id;
    created.push(task);
  }
  void Promise.all([persistTasks(), persistEmails()]);
  scheduleTasks();
  return created;
}

function retryTask(source: K12Task): K12Task {
  if (!["failed", "canceled"].includes(source.status)) {
    throw new Error("只能重试失败或已取消的任务");
  }
  const email = emails.find((item) => item.id === source.emailId);
  if (!email) throw new Error("邮箱记录不存在");
  if (email.status === "running") throw new Error("该邮箱当前正在运行，不能重复重试");

  const task: K12Task = {
    id: `k12_${Date.now()}_${randomUUID().slice(0, 8)}`,
    emailId: source.emailId,
    email: source.email,
    status: "queued",
    route: source.route,
    workspaceIds: source.workspaceIds,
    runWorkspaceJoin: source.runWorkspaceJoin,
    runSub2Api: source.runSub2Api,
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
    const related = tasks
      .filter((task) => task.emailId === email.id)
      .sort((a, b) => String(b.finishedAt || b.updatedAt || b.createdAt).localeCompare(String(a.finishedAt || a.updatedAt || a.createdAt)));
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
    if (latestFailed && email.status === "free" && !email.sub2apiAccount) {
      email.status = "failed";
      email.lastTaskId = latestFailed.id;
      email.lastError = latestFailed.error || email.lastError || "";
      changed = true;
    }
  }
  return changed;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 10 * 1024 * 1024) throw new Error("request body too large");
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
    sendJson(res, 200, {ok: true, rootDir, dataDir, summary: summary()});
    return;
  }

  if (method === "GET" && pathname === "/api/summary") {
    sendJson(res, 200, summary());
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

  if (method === "DELETE" && pathname.startsWith("/api/emails/")) {
    const id = decodeURIComponent(pathname.split("/").pop() || "");
    const before = emails.length;
    emails = emails.filter((item) => item.id !== id);
    await persistEmails();
    sendJson(res, 200, {removed: before - emails.length});
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
    const created = createTasks(body).map(publicTask);
    sendJson(res, 201, {tasks: created});
    return;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(cancel|retry))?$/);
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
  if (reconcileEmailStatusesFromTasks()) await persistEmails();

  createServer((req, res) => {
    void handler(req, res);
  }).listen(appConfig.port, "0.0.0.0", () => {
    console.log(`K12 console API listening: http://127.0.0.1:${appConfig.port}/`);
  });
}

void boot();
