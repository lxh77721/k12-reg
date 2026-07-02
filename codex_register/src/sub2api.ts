import {DEFAULT_CLIENT_ID, DEFAULT_REDIRECT_URI} from "./constants.js";

const DEFAULT_GROUP_NAME = "codex";
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_PRIORITY = 1;
const DEFAULT_RATE_MULTIPLIER = 1;

export interface Sub2ApiSettings {
    url: string;
    email: string;
    password: string;
    groupName?: string;
    groupNames?: string[];
    proxyName?: string;
    accountPriority?: number;
    concurrency?: number;
}

export interface Sub2ApiPreparedOAuth {
    origin: string;
    token: string;
    oauthUrl: string;
    sessionId: string;
    state: string;
    groupIds: number[];
    groupLabel: string;
    draftName: string;
    proxyId?: number;
}

export interface Sub2ApiAccountCreateResult {
    account: unknown;
    credentials: Record<string, unknown>;
    accountName: string;
}

export interface Sub2ApiCreateAccountOptions {
    requireChatgptAccountId?: boolean;
}

interface Sub2ApiLoginResult {
    origin: string;
    token: string;
}

function normalizeString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeOrigin(rawUrl: string): string {
    const normalized = normalizeString(rawUrl).replace(/\/+$/, "");
    if (!normalized) throw new Error("SUB2API 地址为空");
    const parsed = new URL(normalized);
    return parsed.origin;
}

function normalizeGroupNames(settings: Sub2ApiSettings): string[] {
    const source = Array.isArray(settings.groupNames) && settings.groupNames.length
        ? settings.groupNames
        : normalizeString(settings.groupName).split(/[\r\n,;，；]+/);
    const names = source.map((item) => normalizeString(item)).filter(Boolean);
    return Array.from(new Set(names.length ? names : [DEFAULT_GROUP_NAME]));
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function normalizeProxyId(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function extractStateFromAuthUrl(authUrl: string): string {
    try {
        return new URL(authUrl).searchParams.get("state") ?? "";
    } catch {
        return "";
    }
}

function parseCallback(rawUrl: string): {url: string; code: string; state: string} {
    const parsed = new URL(rawUrl);
    const code = parsed.searchParams.get("code") ?? "";
    const state = parsed.searchParams.get("state") ?? "";
    if (!code || !state) {
        throw new Error("OAuth callback 缺少 code 或 state");
    }
    return {url: parsed.toString(), code, state};
}

function buildDraftName(groupName: string): string {
    const prefix = (groupName || DEFAULT_GROUP_NAME)
        .replace(/[^\w-]+/g, "-")
        .replace(/^-+|-+$/g, "") || DEFAULT_GROUP_NAME;
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 14);
    const random = Math.floor(Math.random() * 9000 + 1000);
    return `${prefix}-${stamp}-${random}`;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    try {
        return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function buildOpenAiCredentials(exchangeData: Record<string, unknown>): Record<string, unknown> {
    const credentials: Record<string, unknown> = {};
    for (const key of [
        "access_token",
        "refresh_token",
        "id_token",
        "expires_at",
        "email",
        "chatgpt_account_id",
        "chatgpt_user_id",
        "organization_id",
        "plan_type",
        "client_id",
    ]) {
        const value = exchangeData[key];
        if (value !== undefined && value !== null && value !== "") {
            credentials[key] = value;
        }
    }
    if (!credentials.access_token) {
        throw new Error("SUB2API exchange-code 未返回 access_token");
    }
    if (!credentials.client_id) {
        credentials.client_id = DEFAULT_CLIENT_ID;
    }

    const accessClaims = decodeJwtPayload(String(credentials.access_token));
    const idClaims = credentials.id_token ? decodeJwtPayload(String(credentials.id_token)) : null;
    const profile = (accessClaims?.["https://api.openai.com/profile"] ?? {}) as Record<string, unknown>;
    const auth = (accessClaims?.["https://api.openai.com/auth"] ?? idClaims?.["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
    credentials.email ||= normalizeString(idClaims?.email) || normalizeString(profile.email);
    credentials.chatgpt_account_id ||= normalizeString(auth.chatgpt_account_id);
    credentials.chatgpt_user_id ||= normalizeString(auth.chatgpt_user_id) || normalizeString(auth.user_id);
    credentials.plan_type ||= normalizeString(auth.chatgpt_plan_type);
    return credentials;
}

function buildExtra(exchangeData: Record<string, unknown>, sourceEmail: string): Record<string, unknown> | undefined {
    const extra: Record<string, unknown> = {};
    for (const key of ["email", "name", "privacy_mode"]) {
        const value = exchangeData[key];
        if (value !== undefined && value !== null && value !== "") {
            extra[key] = value;
        }
    }
    if (sourceEmail && !extra.email) extra.email = sourceEmail;
    return Object.keys(extra).length ? extra : undefined;
}

export class Sub2ApiClient {
    readonly settings: Sub2ApiSettings;
    private loginCache: Sub2ApiLoginResult | null = null;

    constructor(settings: Sub2ApiSettings) {
        this.settings = settings;
    }

    async login(): Promise<Sub2ApiLoginResult> {
        if (this.loginCache) return this.loginCache;
        const origin = normalizeOrigin(this.settings.url);
        const email = normalizeString(this.settings.email);
        const password = String(this.settings.password ?? "");
        if (!email) throw new Error("SUB2API 账号为空");
        if (!password) throw new Error("SUB2API 密码为空");

        const data = await this.requestJson(origin, "/api/v1/auth/login", {
            method: "POST",
            body: {email, password},
        });
        const token = normalizeString((data as Record<string, unknown>)?.access_token)
            || normalizeString((data as Record<string, unknown>)?.accessToken);
        if (!token) throw new Error("SUB2API 登录响应缺少 access_token");
        this.loginCache = {origin, token};
        return this.loginCache;
    }

    async prepareOpenAiOAuth(redirectUri = DEFAULT_REDIRECT_URI): Promise<Sub2ApiPreparedOAuth> {
        const {origin, token} = await this.login();
        const groups = await this.getGroups(origin, token);
        const groupIds = groups.map((item) => normalizeProxyId((item as Record<string, unknown>).id)).filter((id): id is number => Boolean(id));
        if (!groupIds.length) throw new Error("SUB2API 目标分组 ID 无效");

        const proxyId = await this.resolveProxyId(origin, token);
        const body: Record<string, unknown> = {redirect_uri: redirectUri};
        if (proxyId) body.proxy_id = proxyId;

        const authData = await this.requestJson(origin, "/api/v1/admin/openai/generate-auth-url", {
            method: "POST",
            token,
            body,
        }) as Record<string, unknown>;
        const oauthUrl = normalizeString(authData.auth_url) || normalizeString(authData.authUrl);
        const sessionId = normalizeString(authData.session_id) || normalizeString(authData.sessionId);
        const state = normalizeString(authData.state) || extractStateFromAuthUrl(oauthUrl);
        if (!oauthUrl || !sessionId) {
            throw new Error(`SUB2API generate-auth-url 响应缺少 auth_url/session_id: ${JSON.stringify(authData).slice(0, 300)}`);
        }
        const groupLabel = groups
            .map((item) => {
                const record = item as Record<string, unknown>;
                return `${normalizeString(record.name) || "group"}#${String(record.id ?? "")}`;
            })
            .join(", ");
        return {
            origin,
            token,
            oauthUrl,
            sessionId,
            state,
            groupIds,
            groupLabel,
            draftName: buildDraftName(normalizeString((groups[0] as Record<string, unknown>).name)),
            proxyId,
        };
    }

    async exchangeCallbackAndCreateAccount(
        prepared: Sub2ApiPreparedOAuth,
        callbackUrl: string,
        sourceEmail = "",
        accountNameOverride = "",
        options: Sub2ApiCreateAccountOptions = {},
    ): Promise<Sub2ApiAccountCreateResult> {
        const callback = parseCallback(callbackUrl);
        if (prepared.state && callback.state !== prepared.state) {
            throw new Error("OAuth callback state 与 SUB2API session state 不一致");
        }

        const exchangeBody: Record<string, unknown> = {
            session_id: prepared.sessionId,
            code: callback.code,
            state: callback.state,
        };
        if (prepared.proxyId) exchangeBody.proxy_id = prepared.proxyId;

        const exchangeData = await this.requestJson(prepared.origin, "/api/v1/admin/openai/exchange-code", {
            method: "POST",
            token: prepared.token,
            body: exchangeBody,
        }) as Record<string, unknown>;

        const credentials = buildOpenAiCredentials(exchangeData);
        const resolvedEmail = normalizeString(exchangeData.email)
            || normalizeString(credentials.email)
            || sourceEmail;
        const expectedEmail = normalizeString(sourceEmail);
        if (expectedEmail && resolvedEmail && resolvedEmail.toLowerCase() !== expectedEmail.toLowerCase()) {
            throw new Error(`SUB2API OAuth 返回邮箱与绑定邮箱不一致: expected=${expectedEmail} actual=${resolvedEmail}`);
        }
        if (options.requireChatgptAccountId && !normalizeString(credentials.chatgpt_account_id)) {
            throw new Error(`SUB2API OAuth 返回缺少 chatgpt_account_id: email=${resolvedEmail || expectedEmail || "(unknown)"}`);
        }
        const accountName = normalizeString(accountNameOverride) || resolvedEmail || prepared.draftName;
        const createBody: Record<string, unknown> = {
            name: accountName,
            notes: "",
            platform: "openai",
            type: "oauth",
            credentials,
            concurrency: normalizePositiveInteger(this.settings.concurrency, DEFAULT_CONCURRENCY),
            priority: normalizePositiveInteger(this.settings.accountPriority, DEFAULT_PRIORITY),
            rate_multiplier: DEFAULT_RATE_MULTIPLIER,
            group_ids: prepared.groupIds,
            auto_pause_on_expired: true,
        };
        if (prepared.proxyId) createBody.proxy_id = prepared.proxyId;
        const extra = buildExtra(exchangeData, sourceEmail);
        if (extra) createBody.extra = extra;

        const account = await this.requestJson(prepared.origin, "/api/v1/admin/accounts", {
            method: "POST",
            token: prepared.token,
            body: createBody,
        });
        return {account, credentials, accountName};
    }

    private async getGroups(origin: string, token: string): Promise<unknown[]> {
        const targetNames = normalizeGroupNames(this.settings);
        const groups = await this.requestJson(origin, "/api/v1/admin/groups/all", {
            method: "GET",
            token,
        });
        const items = Array.isArray(groups) ? groups : [];
        const matched: unknown[] = [];
        const missing: string[] = [];
        for (const name of targetNames) {
            const normalized = name.toLowerCase();
            const found = items.find((item) => {
                const record = item as Record<string, unknown>;
                const itemName = normalizeString(record.name).toLowerCase();
                const platform = normalizeString(record.platform).toLowerCase();
                return itemName === normalized && (!platform || platform === "openai");
            });
            if (found) matched.push(found);
            else missing.push(name);
        }
        if (missing.length) {
            throw new Error(`SUB2API 未找到 openai 分组: ${missing.join(", ")}`);
        }
        return matched;
    }

    private async resolveProxyId(origin: string, token: string): Promise<number | undefined> {
        const preference = normalizeString(this.settings.proxyName);
        if (!preference) return undefined;
        const preferredId = normalizeProxyId(preference);
        const proxies = await this.requestJson(origin, "/api/v1/admin/proxies/all?with_count=true", {
            method: "GET",
            token,
        });
        const items = Array.isArray(proxies) ? proxies : [];
        const active = items.filter((item) => {
            const record = item as Record<string, unknown>;
            const status = normalizeString(record.status).toLowerCase();
            return normalizeProxyId(record.id) && (!status || status === "active");
        });
        const found = preferredId
            ? active.find((item) => normalizeProxyId((item as Record<string, unknown>).id) === preferredId)
            : active.find((item) => normalizeString((item as Record<string, unknown>).name).toLowerCase() === preference.toLowerCase());
        if (!found) {
            const sample = active
                .slice(0, 8)
                .map((item) => `${normalizeString((item as Record<string, unknown>).name) || "(unnamed)"}#${String((item as Record<string, unknown>).id ?? "")}`)
                .join(", ");
            throw new Error(`SUB2API 默认代理未匹配: ${preference}; 可用: ${sample || "无"}`);
        }
        return normalizeProxyId((found as Record<string, unknown>).id);
    }

    private async requestJson(
        origin: string,
        pathname: string,
        options: {method?: string; token?: string; body?: unknown; timeoutMs?: number} = {},
    ): Promise<unknown> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1000, options.timeoutMs ?? 30000));
        try {
            const headers: Record<string, string> = {
                Accept: "application/json",
                "Content-Type": "application/json",
            };
            if (options.token) {
                headers.Authorization = `Bearer ${options.token}`;
            }
            const response = await fetch(`${origin}${pathname}`, {
                method: options.method ?? "GET",
                headers,
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
                const code = Number((payload as Record<string, unknown>).code);
                if (code === 0) return (payload as Record<string, unknown>).data;
                throw new Error(this.formatApiError(pathname, response.status, payload));
            }
            if (!response.ok) {
                throw new Error(this.formatApiError(pathname, response.status, payload));
            }
            return payload;
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                throw new Error(`SUB2API 请求超时: ${pathname}`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    private formatApiError(pathname: string, status: number, payload: unknown): string {
        if (payload && typeof payload === "object") {
            const record = payload as Record<string, unknown>;
            const message = normalizeString(record.message)
                || normalizeString(record.detail)
                || normalizeString(record.error)
                || normalizeString(record.reason);
            if (message) return `SUB2API ${pathname} 失败: ${message}`;
        }
        return `SUB2API ${pathname} 失败: HTTP ${status} ${JSON.stringify(payload).slice(0, 500)}`;
    }
}
