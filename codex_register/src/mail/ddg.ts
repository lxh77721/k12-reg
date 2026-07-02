import {ImapFlow} from "imapflow";
import {Agent, fetch as undiciFetch, ProxyAgent, type Dispatcher, type RequestInit as UndiciRequestInit} from "undici";
import {appConfig} from "../config.js";
import {generateEmailName} from "./generate-email-name.js";
import {findLatestVerificationMail, normalizeMailbox, type VerificationMailCandidate} from "./verification-matcher.js";

export type DdgMailMode = "cf" | "imap";

export interface DdgMailConfig {
    ddgToken: string;
    aliasDomain: string;
    addressPrefix: string;
    proxyUrl: string;
    requestTimeoutMs: number;
    pollAttempts: number;
    pollIntervalMs: number;

    cfApiBaseUrl: string;
    cfInboxJwt: string;
    cfApiKey: string;
    cfAuthMode: "none" | "bearer" | "x-api-key" | "x-admin-key" | "query-key";
    cfMessagesPath: string;

    imapEmail: string;
    imapPassword: string;
    imapHost: string;
    imapPort: number;
    imapMailbox: string;
    imapSearchLimit: number;
}

export interface DdgMailbox {
    address: string;
    mode: DdgMailMode;
}

export interface DdgMailMessage {
    provider: "ddg_mail" | "imap_mail";
    mailbox: string;
    messageId: string;
    subject: string;
    sender: string;
    recipient: string[];
    textContent: string;
    htmlContent: string;
    receivedAt: string;
    timestamp: number;
    verificationCode: string;
    raw?: unknown;
}

interface FetchDdgMessageOptions {
    minTimestampMs?: number;
}

const DDG_API_BASE = "https://quack.duckduckgo.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_POLL_ATTEMPTS = 24;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const generatedAliases = new Set<string>();

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function pickString(source: Record<string, unknown>, keys: string[], fallback = ""): string {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return fallback;
}

function pickNumber(source: Record<string, unknown>, keys: string[], fallback: number): number {
    for (const key of keys) {
        const value = source[key];
        const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function normalizeAuthMode(value: string): DdgMailConfig["cfAuthMode"] {
    const normalized = value.trim().toLowerCase();
    if (normalized === "bearer" || normalized === "x-api-key" || normalized === "x-admin-key" || normalized === "query-key") {
        return normalized;
    }
    return "none";
}

export function normalizeDdgMailConfig(input: unknown = appConfig): DdgMailConfig {
    const source = asRecord(input);
    const aliasDomain = pickString(source, ["ddgAliasDomain", "alias_domain", "aliasDomain"], "duck.com")
        .replace(/^@+/, "")
        .toLowerCase();
    return {
        ddgToken: pickString(source, ["ddgToken", "ddg_token"]),
        aliasDomain,
        addressPrefix: pickString(source, ["ddgAddressPrefix", "address_prefix", "addressPrefix"]),
        proxyUrl: pickString(source, ["ddgProxyUrl", "proxyUrl", "defaultProxyUrl"], appConfig.defaultProxyUrl),
        requestTimeoutMs: Math.max(5000, pickNumber(source, ["ddgRequestTimeoutMs", "request_timeout_ms"], DEFAULT_REQUEST_TIMEOUT_MS)),
        pollAttempts: Math.max(1, pickNumber(source, ["ddgPollAttempts", "poll_attempts"], DEFAULT_POLL_ATTEMPTS)),
        pollIntervalMs: Math.max(1000, pickNumber(source, ["ddgPollIntervalMs", "poll_interval_ms"], DEFAULT_POLL_INTERVAL_MS)),

        cfApiBaseUrl: pickString(source, ["ddgCfApiBaseUrl", "ddgCfApiBase", "cf_api_base", "api_base"]).replace(/\/+$/, ""),
        cfInboxJwt: pickString(source, ["ddgCfInboxJwt", "cf_inbox_jwt"]),
        cfApiKey: pickString(source, ["ddgCfApiKey", "cf_api_key"]),
        cfAuthMode: normalizeAuthMode(pickString(source, ["ddgCfAuthMode", "cf_auth_mode"], "none")),
        cfMessagesPath: pickString(source, ["ddgCfMessagesPath", "cf_messages_path"], "/api/mails") || "/api/mails",

        imapEmail: pickString(source, ["ddgImapEmail", "imapEmail", "email", "username"]),
        imapPassword: pickString(source, ["ddgImapPassword", "imapPassword", "password", "imap_key", "api_key"]),
        imapHost: pickString(source, ["ddgImapHost", "imapHost", "host"], "imap.qq.com"),
        imapPort: Math.max(1, pickNumber(source, ["ddgImapPort", "imapPort", "port"], 993)),
        imapMailbox: pickString(source, ["ddgImapMailbox", "imapMailbox", "mailbox"], "INBOX") || "INBOX",
        imapSearchLimit: Math.max(1, pickNumber(source, ["ddgImapSearchLimit", "imapSearchLimit", "search_limit"], 30)),
    };
}

function normalizeMode(value: unknown): DdgMailMode {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized === "imap" || normalized === "imap_mail" || normalized === "qq") return "imap";
    return "cf";
}

function buildDispatcher(config: DdgMailConfig): Dispatcher {
    return config.proxyUrl
        ? new ProxyAgent({
            uri: config.proxyUrl,
            requestTls: {rejectUnauthorized: false},
        })
        : new Agent({
            connect: {rejectUnauthorized: false},
        });
}

async function fetchJson(url: string | URL, init: UndiciRequestInit, config: DdgMailConfig): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
        const response = await undiciFetch(url, {
            ...init,
            dispatcher: buildDispatcher(config),
            signal: controller.signal,
        } satisfies UndiciRequestInit);
        const raw = await response.text();
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`);
        }
        if (!raw.trim()) return {};
        return JSON.parse(raw) as unknown;
    } finally {
        clearTimeout(timer);
    }
}

async function createDuckAlias(config: DdgMailConfig): Promise<string> {
    if (!config.ddgToken) {
        if (config.aliasDomain && config.aliasDomain !== "duck.com") {
            const prefix = config.addressPrefix ? `${config.addressPrefix}.` : "";
            return `${prefix}${generateEmailName()}@${config.aliasDomain}`.toLowerCase();
        }
        throw new Error("DDG Token 未配置，无法创建 @duck.com 别名");
    }

    const payload = await fetchJson(`${DDG_API_BASE}/api/email/addresses`, {
        method: "POST",
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${config.ddgToken}`,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
        body: "{}",
    }, config);
    const addressPart = pickString(asRecord(payload), ["address"]);
    if (!addressPart) {
        throw new Error(`DDG API 返回缺少 address 字段: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    const address = `${addressPart}@duck.com`.toLowerCase();
    if (generatedAliases.has(address)) {
        throw new Error(`DDG API 返回重复别名 ${address}，可能已达到当日生成上限`);
    }
    generatedAliases.add(address);
    return address;
}

export async function createDdgMailbox(mode: DdgMailMode = "cf", configInput?: unknown): Promise<DdgMailbox> {
    const config = normalizeDdgMailConfig(configInput);
    if (mode === "cf") {
        if (!config.cfApiBaseUrl) throw new Error("DDG CF 模式缺少 ddgCfApiBaseUrl / api_base");
        if (!config.cfInboxJwt && !config.cfApiKey) throw new Error("DDG CF 模式缺少 ddgCfInboxJwt 或 ddgCfApiKey");
    }
    if (mode === "imap") {
        if (!config.imapEmail) throw new Error("DDG IMAP 模式缺少 ddgImapEmail / email");
        if (!config.imapPassword) throw new Error("DDG IMAP 模式缺少 ddgImapPassword / password");
    }
    return {
        address: await createDuckAlias(config),
        mode,
    };
}

function parseReceivedMs(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value > 100000000000 ? Math.floor(value) : Math.floor(value * 1000);
    }
    const text = String(value ?? "").trim();
    if (!text) return 0;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
}

function receivedIso(timestamp: number): string {
    return timestamp > 0 ? new Date(timestamp).toISOString() : "";
}

function textCandidates(value: unknown): string[] {
    if (typeof value === "string" || typeof value === "number") {
        const text = String(value).trim();
        return text ? [text] : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap(textCandidates);
    }
    const record = asRecord(value);
    if (Object.keys(record).length) {
        return ["address", "email", "name", "value"].flatMap((key) => textCandidates(record[key]));
    }
    return [];
}

function parseHeaderBlock(raw: string): Record<string, string> {
    const [headerBlock = ""] = raw.split(/\r?\n\r?\n/, 1);
    const headers: Record<string, string> = {};
    let current = "";
    for (const line of headerBlock.split(/\r?\n/)) {
        if (/^[ \t]/.test(line) && current) {
            headers[current] = `${headers[current]} ${line.trim()}`.trim();
            continue;
        }
        const match = line.match(/^([^:]+):\s*(.*)$/);
        if (!match) continue;
        current = match[1].trim().toLowerCase();
        headers[current] = match[2].trim();
    }
    return headers;
}

function parseRawRecipient(raw: string): string[] {
    if (!raw) return [];
    const headers = parseHeaderBlock(raw);
    return ["to", "delivered-to", "x-original-to", "envelope-to"]
        .flatMap((key) => textCandidates(headers[key]))
        .map(normalizeMailbox)
        .filter(Boolean);
}

function decodeQuotedPrintable(value: string): string {
    const bytes: number[] = [];
    const compact = value.replace(/=\r?\n/g, "");
    for (let i = 0; i < compact.length; i += 1) {
        if (compact[i] === "=" && /^[0-9a-f]{2}$/i.test(compact.slice(i + 1, i + 3))) {
            bytes.push(parseInt(compact.slice(i + 1, i + 3), 16));
            i += 2;
        } else {
            bytes.push(compact.charCodeAt(i));
        }
    }
    return Buffer.from(bytes).toString("utf8");
}

function decodeBodyByHeaders(headers: Record<string, string>, body: string): string {
    const encoding = String(headers["content-transfer-encoding"] ?? "").trim().toLowerCase();
    if (encoding === "base64") {
        try {
            return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
        } catch {
            return body;
        }
    }
    if (encoding === "quoted-printable") {
        return decodeQuotedPrintable(body);
    }
    return body;
}

function extractBoundary(contentType: string): string {
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
    return (match?.[1] || match?.[2] || "").trim();
}

function splitRawMessage(raw: string): {headers: Record<string, string>; body: string} {
    const split = raw.match(/\r?\n\r?\n/);
    if (!split || split.index == null) return {headers: parseHeaderBlock(raw), body: ""};
    const headerText = raw.slice(0, split.index);
    const body = raw.slice(split.index + split[0].length);
    return {headers: parseHeaderBlock(headerText), body};
}

function extractMimeText(raw: string): {text: string; html: string} {
    const {headers, body} = splitRawMessage(raw);
    const contentType = String(headers["content-type"] ?? "").toLowerCase();
    const boundary = extractBoundary(contentType);
    if (boundary) {
        const parts = body.split(`--${boundary}`)
            .map((part) => part.trim())
            .filter((part) => part && part !== "--");
        const extracted = parts.map(extractMimeText);
        return {
            text: extracted.map((item) => item.text).filter(Boolean).join("\n").trim(),
            html: extracted.map((item) => item.html).filter(Boolean).join("\n").trim(),
        };
    }
    const decoded = decodeBodyByHeaders(headers, body);
    if (contentType.includes("text/html")) return {text: "", html: decoded.trim()};
    return {text: decoded.trim(), html: ""};
}

function extractContentFromItem(item: Record<string, unknown>): {text: string; html: string; rawText: string} {
    const rawText = pickString(item, ["raw", "raw_text", "source", "mime", "message"]);
    const text = pickString(item, ["text_content", "text", "body", "content", "plain"]);
    const html = pickString(item, ["html_content", "html", "html_body", "body_html"]);
    if (text || html || !rawText) return {text, html, rawText};
    const extracted = extractMimeText(rawText);
    return {text: extracted.text || rawText, html: extracted.html, rawText};
}

function collectRecipients(item: Record<string, unknown>, rawText = ""): string[] {
    const direct = ["to", "mailTo", "receiver", "receivers", "address", "email", "envelope_to", "recipient", "recipients"]
        .flatMap((key) => textCandidates(item[key]));
    const rawRecipients = parseRawRecipient(rawText);
    return Array.from(new Set([...direct, ...rawRecipients].map(normalizeMailbox).filter(Boolean)));
}

function listPayloadItems(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) {
        return data.map(asRecord).filter((item) => Object.keys(item).length);
    }
    const record = asRecord(data);
    for (const key of ["results", "hydra:member", "data", "messages", "emails", "items"]) {
        const value = record[key];
        if (Array.isArray(value)) {
            return value.map(asRecord).filter((item) => Object.keys(item).length);
        }
        const nested = asRecord(value);
        if (Array.isArray(nested.messages)) {
            return nested.messages.map(asRecord).filter((item) => Object.keys(item).length);
        }
        if (Array.isArray(nested.results)) {
            return nested.results.map(asRecord).filter((item) => Object.keys(item).length);
        }
    }
    return [];
}

function cfAuthHeaders(config: DdgMailConfig): Record<string, string> {
    if (!config.cfApiKey) return {};
    if (config.cfAuthMode === "x-api-key") return {"X-API-Key": config.cfApiKey};
    if (config.cfAuthMode === "x-admin-key") return {"X-Admin-Key": config.cfApiKey};
    if (config.cfAuthMode === "bearer") return {Authorization: `Bearer ${config.cfApiKey}`};
    return {};
}

function buildCfUrl(config: DdgMailConfig, path: string): URL {
    return new URL(`${config.cfApiBaseUrl}${path.startsWith("/") ? "" : "/"}${path}`);
}

function toDdgMessage(
    provider: "ddg_mail" | "imap_mail",
    targetEmail: string,
    item: Record<string, unknown>,
): DdgMailMessage {
    const content = extractContentFromItem(item);
    const recipient = collectRecipients(item, content.rawText);
    const senderValue = item.from ?? item.sender ?? item.source ?? item.from_email ?? item.from_address;
    const sender = textCandidates(senderValue)[0] ?? "";
    const timestamp = parseReceivedMs(
        item.createdAt ?? item.created_at ?? item.receivedAt ?? item.received_at ?? item.date ?? item.timestamp ?? item.internalDate,
    );
    const subject = pickString(item, ["subject"]);
    const messageId = pickString(item, ["id", "msgid", "_id", "message_id", "uid"]);
    const candidate = findLatestVerificationMail([{
        id: messageId,
        sender,
        recipient: recipient.length ? recipient : [targetEmail],
        subject,
        content: `${content.text}\n${content.html}`,
        timestamp,
        extraTexts: [content.rawText],
    }], {targetEmail, rememberLastCode: false});
    return {
        provider,
        mailbox: targetEmail,
        messageId,
        subject,
        sender,
        recipient,
        textContent: content.text,
        htmlContent: content.html,
        receivedAt: receivedIso(timestamp),
        timestamp,
        verificationCode: candidate?.verificationCode ?? "",
        raw: item,
    };
}

async function fetchDdgCfDetail(
    item: Record<string, unknown>,
    config: DdgMailConfig,
    headers: Record<string, string>,
): Promise<Record<string, unknown>> {
    const hasBody = Boolean(pickString(item, [
        "text_content",
        "text",
        "body",
        "content",
        "plain",
        "html_content",
        "html",
        "html_body",
        "body_html",
        "raw",
        "raw_text",
        "mime",
    ]));
    if (hasBody) return item;

    const id = pickString(item, ["id", "msgid", "_id", "message_id", "uid"]);
    if (!id) return item;

    const detailPath = config.cfMessagesPath.includes("/emails")
        ? config.cfMessagesPath.replace(/\/emails\b.*/i, "/email")
        : "/api/email";
    const url = buildCfUrl(config, detailPath);
    url.searchParams.set("id", id);
    if (config.cfApiKey && config.cfAuthMode === "query-key") {
        url.searchParams.set("key", config.cfApiKey);
    }

    const detail = asRecord(await fetchJson(url, {method: "GET", headers}, config));
    return {...item, ...detail};
}

async function fetchDdgCfMessage(email: string, config: DdgMailConfig, options: FetchDdgMessageOptions): Promise<DdgMailMessage | null> {
    if (!config.cfApiBaseUrl) throw new Error("DDG CF 模式缺少 ddgCfApiBaseUrl / api_base");
    const url = buildCfUrl(config, config.cfMessagesPath);
    url.searchParams.set("limit", "30");
    url.searchParams.set("offset", "0");
    if (config.cfApiKey && config.cfAuthMode === "query-key") {
        url.searchParams.set("key", config.cfApiKey);
    }
    const headers: Record<string, string> = {
        Accept: "application/json",
        ...cfAuthHeaders(config),
        "User-Agent": "Mozilla/5.0",
    };
    if (config.cfInboxJwt) {
        headers.Authorization = `Bearer ${config.cfInboxJwt}`;
    }

    const payload = await fetchJson(url, {method: "GET", headers}, config);
    const target = normalizeMailbox(email);
    const matchedItems = listPayloadItems(payload)
        .filter((item) => {
            if (!target) return true;
            const recipients = collectRecipients(item, extractContentFromItem(item).rawText);
            return recipients.length > 0 && recipients.some((recipient) => recipient.includes(target) || target.includes(recipient));
        });
    const detailedItems = await Promise.all(matchedItems.map((item) => fetchDdgCfDetail(item, config, headers)));
    const messages = detailedItems
        .map((item) => toDdgMessage("ddg_mail", target, item))
        .filter((item) => {
            if (options.minTimestampMs && item.timestamp && item.timestamp < options.minTimestampMs) return false;
            if (!target) return true;
            return item.recipient.length > 0 && item.recipient.some((recipient) => recipient.includes(target) || target.includes(recipient));
        })
        .sort((left, right) => right.timestamp - left.timestamp);
    return messages.find((item) => item.verificationCode) ?? messages[0] ?? null;
}

function envelopeAddressText(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => asRecord(item))
        .map((item) => pickString(item, ["address"]) || pickString(item, ["name"]))
        .filter(Boolean);
}

function imapMessageToItem(message: Record<string, unknown>): Record<string, unknown> {
    const envelope = asRecord(message.envelope);
    const rawText = Buffer.isBuffer(message.source) ? message.source.toString("utf8") : "";
    const extracted = rawText ? extractMimeText(rawText) : {text: "", html: ""};
    const recipients = [
        ...envelopeAddressText(envelope.to),
        ...envelopeAddressText(envelope.cc),
        ...parseRawRecipient(rawText),
    ];
    const senders = [
        ...envelopeAddressText(envelope.from),
        ...envelopeAddressText(envelope.sender),
    ];
    return {
        id: String(message.uid ?? message.seq ?? ""),
        uid: String(message.uid ?? ""),
        subject: pickString(envelope, ["subject"]),
        from: senders[0] ?? "",
        to: recipients,
        text_content: extracted.text || rawText,
        html_content: extracted.html,
        raw: rawText,
        internalDate: message.internalDate ?? envelope.date,
    };
}

async function imapSearch(client: ImapFlow, target: string, config: DdgMailConfig): Promise<number[]> {
    const ids = new Set<number>();
    for (const query of [{to: target}, {text: target}]) {
        try {
            const result = await client.search(query);
            if (Array.isArray(result)) {
                result.slice(-Math.min(config.imapSearchLimit, 20)).forEach((id) => ids.add(Number(id)));
            }
        } catch {
            // Some IMAP servers reject TEXT/TO search for forwarded aliases; fall back to latest messages.
        }
    }
    return [...ids].filter((id) => Number.isFinite(id) && id > 0);
}

async function fetchDdgImapMessage(email: string, config: DdgMailConfig, options: FetchDdgMessageOptions): Promise<DdgMailMessage | null> {
    if (!config.imapEmail) throw new Error("DDG IMAP 模式缺少 ddgImapEmail / email");
    if (!config.imapPassword) throw new Error("DDG IMAP 模式缺少 ddgImapPassword / password");

    const target = normalizeMailbox(email);
    const client = new ImapFlow({
        host: config.imapHost,
        port: config.imapPort,
        secure: config.imapPort === 993,
        auth: {user: config.imapEmail, pass: config.imapPassword},
        proxy: config.proxyUrl || undefined,
        logger: false,
        emitLogs: false,
        tls: {rejectUnauthorized: false},
        connectionTimeout: config.requestTimeoutMs,
        greetingTimeout: config.requestTimeoutMs,
        socketTimeout: Math.max(config.requestTimeoutMs, 60000),
    });

    try {
        await client.connect();
        const mailbox = await client.mailboxOpen(config.imapMailbox, {readOnly: true});
        const targetIds = await imapSearch(client, target, config);
        const exists = Math.max(0, Number(mailbox.exists ?? 0));
        const start = Math.max(1, exists - config.imapSearchLimit + 1);
        const range: string | number[] = targetIds.length ? targetIds : (exists ? `${start}:${exists}` : []);
        if (Array.isArray(range) && !range.length) return null;
        const fetched = await client.fetchAll(range, {uid: true, envelope: true, internalDate: true, source: true});
        const messages = fetched
            .map((message) => toDdgMessage("imap_mail", target, imapMessageToItem(message as unknown as Record<string, unknown>)))
            .filter((item) => !options.minTimestampMs || !item.timestamp || item.timestamp >= options.minTimestampMs)
            .sort((left, right) => right.timestamp - left.timestamp);
        const targetMatched = messages.filter((item) => {
            if (!target) return true;
            return item.recipient.some((recipient) => recipient.includes(target) || target.includes(recipient));
        });
        return targetMatched.find((item) => item.verificationCode)
            ?? messages.find((item) => item.verificationCode)
            ?? targetMatched[0]
            ?? messages[0]
            ?? null;
    } finally {
        try {
            await client.logout();
        } catch {
            // ignore logout failures
        }
    }
}

export async function fetchLatestDdgMessage(
    email: string,
    modeInput: DdgMailMode | string = "cf",
    configInput?: unknown,
    options: FetchDdgMessageOptions = {},
): Promise<DdgMailMessage | null> {
    const mode = normalizeMode(modeInput);
    const config = normalizeDdgMailConfig(configInput);
    return mode === "imap"
        ? fetchDdgImapMessage(email, config, options)
        : fetchDdgCfMessage(email, config, options);
}

export async function waitForDdgVerificationCode(
    email: string,
    modeInput: DdgMailMode | string = "cf",
    configInput?: unknown,
    options: FetchDdgMessageOptions = {},
): Promise<string> {
    const mode = normalizeMode(modeInput);
    const config = normalizeDdgMailConfig(configInput);
    let lastError = "";
    for (let attempt = 1; attempt <= config.pollAttempts; attempt += 1) {
        try {
            const message = mode === "imap"
                ? await fetchDdgImapMessage(email, config, options)
                : await fetchDdgCfMessage(email, config, options);
            if (message?.verificationCode) {
                console.log(`ddgOtpCode: ${message.verificationCode} mode=${mode} targetEmail=${email}`);
                return message.verificationCode;
            }
            lastError = message ? "latest matching mail has no verification code" : "no matching mail";
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            console.warn(`ddgOtp: attempt=${attempt}/${config.pollAttempts} failed: ${lastError}`);
        }
        if (attempt < config.pollAttempts) {
            await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
        }
    }
    throw new Error(`DDG 邮箱中未找到验证码 targetEmail=${email} mode=${mode}: ${lastError}`);
}

export function createDdgCfProvider(configInput?: unknown) {
    return {
        async getEmailAddress() {
            return (await createDdgMailbox("cf", configInput)).address;
        },
        async getEmailVerificationCode(email: string, options?: {minTimestampMs?: number}) {
            return waitForDdgVerificationCode(email, "cf", configInput, options);
        },
    };
}

export function createDdgImapProvider(configInput?: unknown) {
    return {
        async getEmailAddress() {
            return (await createDdgMailbox("imap", configInput)).address;
        },
        async getEmailVerificationCode(email: string, options?: {minTimestampMs?: number}) {
            return waitForDdgVerificationCode(email, "imap", configInput, options);
        },
    };
}
