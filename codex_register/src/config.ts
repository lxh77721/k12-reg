import {readFileSync} from "node:fs";
import path from "node:path";

export type MailProviderName = "2925" | "gmail" | "proxiedmail" | "cloudflare" | "hotmail" | "gptmail" | "ddg_mail" | "imap_mail";
export type SmsProviderName = "hero-sms" | "smsbower";

interface AppConfigFile {
    provider?: unknown;
    defaultPassword?: unknown;
    loopDelayMs?: unknown;
    gmailAccessToken?: unknown;
    gmailEmailAddress?: unknown;
    gptMailApiKey?: unknown;
    gptMailDomain?: unknown;
    "2925EmailAddress"?: unknown;
    "2925Password"?: unknown;
    cloudflareEmailDomain?: unknown;
    cloudflareApiBaseUrl?: unknown;
    cloudflareApiKey?: unknown;
    ddgToken?: unknown;
    ddgMode?: unknown;
    ddgEnabled?: unknown;
    ddgAliasDomain?: unknown;
    ddgAddressPrefix?: unknown;
    ddgProxyUrl?: unknown;
    ddgRequestTimeoutMs?: unknown;
    ddgPollAttempts?: unknown;
    ddgPollIntervalMs?: unknown;
    ddgCfApiBaseUrl?: unknown;
    ddgCfInboxJwt?: unknown;
    ddgCfApiKey?: unknown;
    ddgCfAuthMode?: unknown;
    ddgCfMessagesPath?: unknown;
    ddgImapEmail?: unknown;
    ddgImapPassword?: unknown;
    ddgImapHost?: unknown;
    ddgImapPort?: unknown;
    ddgImapMailbox?: unknown;
    ddgImapSearchLimit?: unknown;
    defaultProxyUrl?: unknown;
    smsProvider?: unknown;
    heroSMSApiKey?: unknown;
    heroSMSBaseUrl?: unknown;
    heroSMSService?: unknown;
    heroSMSCountry?: unknown;
    heroSMSCountries?: unknown;
    heroSMSMaxPrice?: unknown;
    heroSMSPriceTiers?: unknown;
    heroSMSPollAttempts?: unknown;
    heroSMSPollIntervalMs?: unknown;
    smsbowerApiKey?: unknown;
    smsbowerBaseUrl?: unknown;
    smsbowerService?: unknown;
    smsbowerCountry?: unknown;
    smsbowerCountries?: unknown;
    smsbowerMaxPrice?: unknown;
    smsbowerMaxPriceTiers?: unknown;
    smsbowerPriceTiers?: unknown;
    smsbowerPricePoolIds?: unknown;
    smsbowerPollAttempts?: unknown;
    smsbowerPollIntervalMs?: unknown;
    smsbowerRequestRetryAttempts?: unknown;
    smsbowerRequestRetryIntervalMs?: unknown;
    smsbowerProviderIds?: unknown;
    smsbowerExceptProviderIds?: unknown;
    smsbowerPhoneException?: unknown;
    cliproxyApiAutoUploadAuth?: unknown;
    cliproxyApiBaseUrl?: unknown;
    cliproxyApiManagementKey?: unknown;
    sub2apiUrl?: unknown;
    sub2apiEmail?: unknown;
    sub2apiPassword?: unknown;
    sub2apiGroupName?: unknown;
    sub2apiGroupNames?: unknown;
    sub2apiProxyName?: unknown;
    sub2apiAccountPriority?: unknown;
    sub2apiConcurrency?: unknown;
}

export interface AppConfig {
    provider: MailProviderName;
    defaultPassword: string;
    loopDelayMs: number;
    gmailAccessToken: string;
    gmailEmailAddress: string;
    gptMailApiKey: string;
    gptMailDomain: string;
    ["2925EmailAddress"]: string;
    ["2925Password"]: string;
    cloudflareEmailDomain: string;
    cloudflareApiBaseUrl: string;
    cloudflareApiKey: string;
    ddgToken: string;
    ddgMode: string;
    ddgEnabled: boolean;
    ddgAliasDomain: string;
    ddgAddressPrefix: string;
    ddgProxyUrl: string;
    ddgRequestTimeoutMs: number;
    ddgPollAttempts: number;
    ddgPollIntervalMs: number;
    ddgCfApiBaseUrl: string;
    ddgCfInboxJwt: string;
    ddgCfApiKey: string;
    ddgCfAuthMode: string;
    ddgCfMessagesPath: string;
    ddgImapEmail: string;
    ddgImapPassword: string;
    ddgImapHost: string;
    ddgImapPort: number;
    ddgImapMailbox: string;
    ddgImapSearchLimit: number;
    defaultProxyUrl: string;
    smsProvider: SmsProviderName;
    heroSMSApiKey?: string;
    heroSMSBaseUrl: string;
    heroSMSService: string;
    heroSMSCountry: number;
    heroSMSCountries?: number[];
    heroSMSMaxPrice: number;
    heroSMSPriceTiers?: number[];
    heroSMSPollAttempts: number;
    heroSMSPollIntervalMs: number;
    smsbowerApiKey?: string;
    smsbowerBaseUrl: string;
    smsbowerService: string;
    smsbowerCountry: number;
    smsbowerCountries?: number[];
    smsbowerMaxPrice: number;
    smsbowerMaxPriceTiers?: number[];
    smsbowerPriceTiers?: string[];
    smsbowerPricePoolIds?: string[];
    smsbowerPollAttempts: number;
    smsbowerPollIntervalMs: number;
    smsbowerRequestRetryAttempts: number;
    smsbowerRequestRetryIntervalMs: number;
    smsbowerProviderIds?: string[];
    smsbowerExceptProviderIds?: string[];
    smsbowerPhoneException?: string[];
    cliproxyApiAutoUploadAuth: boolean;
    cliproxyApiBaseUrl: string;
    cliproxyApiManagementKey: string;
    sub2apiUrl: string;
    sub2apiEmail: string;
    sub2apiPassword: string;
    sub2apiGroupName: string;
    sub2apiGroupNames?: string[];
    sub2apiProxyName: string;
    sub2apiAccountPriority: number;
    sub2apiConcurrency: number;
}

const DEFAULT_CONFIG: AppConfig = {
    provider: "proxiedmail",
    defaultPassword: "ChangeMe123!",
    loopDelayMs: 120000,
    gmailAccessToken: "",
    gmailEmailAddress: "",
    gptMailApiKey: "",
    gptMailDomain: "",
    "2925EmailAddress": "",
    "2925Password": "",
    cloudflareEmailDomain: "",
    cloudflareApiBaseUrl: "",
    cloudflareApiKey: "",
    ddgToken: "",
    ddgMode: "cf",
    ddgEnabled: false,
    ddgAliasDomain: "duck.com",
    ddgAddressPrefix: "",
    ddgProxyUrl: "",
    ddgRequestTimeoutMs: 30000,
    ddgPollAttempts: 24,
    ddgPollIntervalMs: 5000,
    ddgCfApiBaseUrl: "",
    ddgCfInboxJwt: "",
    ddgCfApiKey: "",
    ddgCfAuthMode: "none",
    ddgCfMessagesPath: "/api/mails",
    ddgImapEmail: "",
    ddgImapPassword: "",
    ddgImapHost: "imap.qq.com",
    ddgImapPort: 993,
    ddgImapMailbox: "INBOX",
    ddgImapSearchLimit: 30,
    defaultProxyUrl: "http://127.0.0.1:10808",
    smsProvider: "hero-sms",
    heroSMSApiKey: undefined,
    heroSMSBaseUrl: "",
    heroSMSService: "dr",
    heroSMSCountry: 52,
    heroSMSMaxPrice: 0.05,
    heroSMSPollAttempts: 10,
    heroSMSPollIntervalMs: 3000,
    smsbowerApiKey: undefined,
    smsbowerBaseUrl: "https://smsbower.online/stubs/handler_api.php",
    smsbowerService: "dr",
    smsbowerCountry: 52,
    smsbowerMaxPrice: 0.05,
    smsbowerPollAttempts: 10,
    smsbowerPollIntervalMs: 3000,
    smsbowerRequestRetryAttempts: 10,
    smsbowerRequestRetryIntervalMs: 3000,
    cliproxyApiAutoUploadAuth: false,
    cliproxyApiBaseUrl: "http://localhost:8317",
    cliproxyApiManagementKey: "",
    sub2apiUrl: "",
    sub2apiEmail: "",
    sub2apiPassword: "",
    sub2apiGroupName: "codex",
    sub2apiProxyName: "",
    sub2apiAccountPriority: 1,
    sub2apiConcurrency: 10,
};

function normalizeNumber(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    return value;
}

function normalizeProvider(value: unknown): MailProviderName {
    if (
        value === "2925"
        || value === "gmail"
        || value === "proxiedmail"
        || value === "cloudflare"
        || value === "hotmail"
        || value === "gptmail"
        || value === "ddg_mail"
        || value === "imap_mail"
    ) {
        return value;
    }
    return DEFAULT_CONFIG.provider;
}

function normalizeSmsProvider(value: unknown): SmsProviderName {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized === "smsbower" || normalized === "sms-bower") {
        return "smsbower";
    }
    return "hero-sms";
}

function normalizeStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
        const items = value.map((v) => String(v).trim()).filter(Boolean);
        return items.length ? items : undefined;
    }

    if (typeof value === "string") {
        const items = value.split(",").map((v) => v.trim()).filter(Boolean);
        return items.length ? items : undefined;
    }

    return undefined;
}

function normalizeNumberArray(value: unknown): number[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const items = value
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v >= 0);
    return items.length ? items : undefined;
}

function normalizePositiveNumberArray(value: unknown): number[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const items = value
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0);
    return items.length ? items : undefined;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(normalized)) {
            return true;
        }
        if (["false", "0", "no", "off"].includes(normalized)) {
            return false;
        }
    }
    return fallback;
}

function loadConfig(): AppConfig {
    const configPath = path.resolve(process.cwd(), "config.json");
    let raw: string;
    try {
        raw = readFileSync(configPath, "utf8");
    } catch {
        throw new Error("未找到 config.json，请先复制 config.example.json 为 config.json 并按需修改配置");
    }

    const parsed = JSON.parse(raw) as AppConfigFile;
    return {
        provider: normalizeProvider(parsed.provider),
        defaultPassword:
            typeof parsed.defaultPassword === "string" && parsed.defaultPassword.trim()
                ? parsed.defaultPassword
                : DEFAULT_CONFIG.defaultPassword,
        loopDelayMs: normalizeNumber(parsed.loopDelayMs, DEFAULT_CONFIG.loopDelayMs),
        gmailAccessToken:
            typeof parsed.gmailAccessToken === "string"
                ? parsed.gmailAccessToken.trim()
                : DEFAULT_CONFIG.gmailAccessToken,
        gmailEmailAddress:
            typeof parsed.gmailEmailAddress === "string"
                ? parsed.gmailEmailAddress.trim()
                : DEFAULT_CONFIG.gmailEmailAddress,
        gptMailApiKey:
            typeof parsed.gptMailApiKey === "string"
                ? parsed.gptMailApiKey.trim()
                : DEFAULT_CONFIG.gptMailApiKey,
        gptMailDomain:
            typeof parsed.gptMailDomain === "string"
                ? parsed.gptMailDomain.trim()
                : DEFAULT_CONFIG.gptMailDomain,
        "2925EmailAddress":
            typeof parsed["2925EmailAddress"] === "string"
                ? parsed["2925EmailAddress"].trim()
                : DEFAULT_CONFIG["2925EmailAddress"],
        "2925Password":
            typeof parsed["2925Password"] === "string"
                ? parsed["2925Password"].trim()
                : DEFAULT_CONFIG["2925Password"],
        cloudflareEmailDomain:
            typeof parsed.cloudflareEmailDomain === "string" && parsed.cloudflareEmailDomain.trim()
                ? parsed.cloudflareEmailDomain.trim()
                : DEFAULT_CONFIG.cloudflareEmailDomain,
        cloudflareApiBaseUrl:
            typeof parsed.cloudflareApiBaseUrl === "string"
                ? parsed.cloudflareApiBaseUrl.trim()
                : DEFAULT_CONFIG.cloudflareApiBaseUrl,
        cloudflareApiKey:
            typeof parsed.cloudflareApiKey === "string"
                ? parsed.cloudflareApiKey.trim()
                : DEFAULT_CONFIG.cloudflareApiKey,
        ddgToken:
            typeof parsed.ddgToken === "string"
                ? parsed.ddgToken.trim()
                : DEFAULT_CONFIG.ddgToken,
        ddgMode:
            typeof parsed.ddgMode === "string" && parsed.ddgMode.trim()
                ? parsed.ddgMode.trim()
                : DEFAULT_CONFIG.ddgMode,
        ddgEnabled: normalizeBoolean(parsed.ddgEnabled, DEFAULT_CONFIG.ddgEnabled),
        ddgAliasDomain:
            typeof parsed.ddgAliasDomain === "string" && parsed.ddgAliasDomain.trim()
                ? parsed.ddgAliasDomain.trim()
                : DEFAULT_CONFIG.ddgAliasDomain,
        ddgAddressPrefix:
            typeof parsed.ddgAddressPrefix === "string"
                ? parsed.ddgAddressPrefix.trim()
                : DEFAULT_CONFIG.ddgAddressPrefix,
        ddgProxyUrl:
            typeof parsed.ddgProxyUrl === "string"
                ? parsed.ddgProxyUrl.trim()
                : DEFAULT_CONFIG.ddgProxyUrl,
        ddgRequestTimeoutMs: normalizeNumber(parsed.ddgRequestTimeoutMs, DEFAULT_CONFIG.ddgRequestTimeoutMs),
        ddgPollAttempts: normalizeNumber(parsed.ddgPollAttempts, DEFAULT_CONFIG.ddgPollAttempts),
        ddgPollIntervalMs: normalizeNumber(parsed.ddgPollIntervalMs, DEFAULT_CONFIG.ddgPollIntervalMs),
        ddgCfApiBaseUrl:
            typeof parsed.ddgCfApiBaseUrl === "string"
                ? parsed.ddgCfApiBaseUrl.trim()
                : DEFAULT_CONFIG.ddgCfApiBaseUrl,
        ddgCfInboxJwt:
            typeof parsed.ddgCfInboxJwt === "string"
                ? parsed.ddgCfInboxJwt.trim()
                : DEFAULT_CONFIG.ddgCfInboxJwt,
        ddgCfApiKey:
            typeof parsed.ddgCfApiKey === "string"
                ? parsed.ddgCfApiKey.trim()
                : DEFAULT_CONFIG.ddgCfApiKey,
        ddgCfAuthMode:
            typeof parsed.ddgCfAuthMode === "string" && parsed.ddgCfAuthMode.trim()
                ? parsed.ddgCfAuthMode.trim()
                : DEFAULT_CONFIG.ddgCfAuthMode,
        ddgCfMessagesPath:
            typeof parsed.ddgCfMessagesPath === "string" && parsed.ddgCfMessagesPath.trim()
                ? parsed.ddgCfMessagesPath.trim()
                : DEFAULT_CONFIG.ddgCfMessagesPath,
        ddgImapEmail:
            typeof parsed.ddgImapEmail === "string"
                ? parsed.ddgImapEmail.trim()
                : DEFAULT_CONFIG.ddgImapEmail,
        ddgImapPassword:
            typeof parsed.ddgImapPassword === "string"
                ? parsed.ddgImapPassword.trim()
                : DEFAULT_CONFIG.ddgImapPassword,
        ddgImapHost:
            typeof parsed.ddgImapHost === "string" && parsed.ddgImapHost.trim()
                ? parsed.ddgImapHost.trim()
                : DEFAULT_CONFIG.ddgImapHost,
        ddgImapPort: normalizeNumber(parsed.ddgImapPort, DEFAULT_CONFIG.ddgImapPort),
        ddgImapMailbox:
            typeof parsed.ddgImapMailbox === "string" && parsed.ddgImapMailbox.trim()
                ? parsed.ddgImapMailbox.trim()
                : DEFAULT_CONFIG.ddgImapMailbox,
        ddgImapSearchLimit: normalizeNumber(parsed.ddgImapSearchLimit, DEFAULT_CONFIG.ddgImapSearchLimit),
        defaultProxyUrl:
            typeof parsed.defaultProxyUrl === "string"
                ? parsed.defaultProxyUrl.trim()
                : DEFAULT_CONFIG.defaultProxyUrl,
        smsProvider: normalizeSmsProvider(parsed.smsProvider),
        heroSMSApiKey:
          typeof parsed.heroSMSApiKey === "string"
            ? parsed.heroSMSApiKey.trim()
            : DEFAULT_CONFIG.heroSMSApiKey,
        heroSMSBaseUrl:
          typeof parsed.heroSMSBaseUrl === "string"
            ? parsed.heroSMSBaseUrl.trim()
            : DEFAULT_CONFIG.heroSMSBaseUrl,
        heroSMSService:
          typeof parsed.heroSMSService === "string" && parsed.heroSMSService.trim()
            ? parsed.heroSMSService.trim()
            : DEFAULT_CONFIG.heroSMSService,
        heroSMSCountry:
          typeof parsed.heroSMSCountry === "number"
            ? parsed.heroSMSCountry
            : DEFAULT_CONFIG.heroSMSCountry,
        heroSMSCountries: normalizeNumberArray(parsed.heroSMSCountries),
        heroSMSMaxPrice:
          typeof parsed.heroSMSMaxPrice === "number"
            ? parsed.heroSMSMaxPrice
            : DEFAULT_CONFIG.heroSMSMaxPrice,
        heroSMSPriceTiers: normalizePositiveNumberArray(parsed.heroSMSPriceTiers),
        heroSMSPollAttempts:
          typeof parsed.heroSMSPollAttempts === "number"
            ? parsed.heroSMSPollAttempts
            : DEFAULT_CONFIG.heroSMSPollAttempts,
        heroSMSPollIntervalMs:
          typeof parsed.heroSMSPollIntervalMs === "number"
            ? parsed.heroSMSPollIntervalMs
            : DEFAULT_CONFIG.heroSMSPollIntervalMs,
        smsbowerApiKey:
          typeof parsed.smsbowerApiKey === "string"
            ? parsed.smsbowerApiKey.trim()
            : DEFAULT_CONFIG.smsbowerApiKey,
        smsbowerBaseUrl:
          typeof parsed.smsbowerBaseUrl === "string" && parsed.smsbowerBaseUrl.trim()
            ? parsed.smsbowerBaseUrl.trim()
            : DEFAULT_CONFIG.smsbowerBaseUrl,
        smsbowerService:
          typeof parsed.smsbowerService === "string" && parsed.smsbowerService.trim()
            ? parsed.smsbowerService.trim()
            : DEFAULT_CONFIG.smsbowerService,
        smsbowerCountry:
          typeof parsed.smsbowerCountry === "number"
            ? parsed.smsbowerCountry
            : DEFAULT_CONFIG.smsbowerCountry,
        smsbowerCountries: normalizeNumberArray(parsed.smsbowerCountries),
        smsbowerMaxPrice:
          typeof parsed.smsbowerMaxPrice === "number"
            ? parsed.smsbowerMaxPrice
            : DEFAULT_CONFIG.smsbowerMaxPrice,
        smsbowerMaxPriceTiers: normalizePositiveNumberArray(parsed.smsbowerMaxPriceTiers),
        smsbowerPriceTiers: normalizeStringArray(parsed.smsbowerPriceTiers),
        smsbowerPricePoolIds: normalizeStringArray(parsed.smsbowerPricePoolIds),
        smsbowerPollAttempts:
          typeof parsed.smsbowerPollAttempts === "number"
            ? parsed.smsbowerPollAttempts
            : DEFAULT_CONFIG.smsbowerPollAttempts,
        smsbowerPollIntervalMs:
          typeof parsed.smsbowerPollIntervalMs === "number"
            ? parsed.smsbowerPollIntervalMs
            : DEFAULT_CONFIG.smsbowerPollIntervalMs,
        smsbowerRequestRetryAttempts:
          typeof parsed.smsbowerRequestRetryAttempts === "number"
            ? parsed.smsbowerRequestRetryAttempts
            : DEFAULT_CONFIG.smsbowerRequestRetryAttempts,
        smsbowerRequestRetryIntervalMs:
          typeof parsed.smsbowerRequestRetryIntervalMs === "number"
            ? parsed.smsbowerRequestRetryIntervalMs
            : DEFAULT_CONFIG.smsbowerRequestRetryIntervalMs,
        smsbowerProviderIds: normalizeStringArray(parsed.smsbowerProviderIds),
        smsbowerExceptProviderIds: normalizeStringArray(parsed.smsbowerExceptProviderIds),
        smsbowerPhoneException: normalizeStringArray(parsed.smsbowerPhoneException),
        cliproxyApiAutoUploadAuth: normalizeBoolean(
            parsed.cliproxyApiAutoUploadAuth,
            DEFAULT_CONFIG.cliproxyApiAutoUploadAuth,
        ),
        cliproxyApiBaseUrl:
            typeof parsed.cliproxyApiBaseUrl === "string" && parsed.cliproxyApiBaseUrl.trim()
                ? parsed.cliproxyApiBaseUrl.trim()
                : DEFAULT_CONFIG.cliproxyApiBaseUrl,
        cliproxyApiManagementKey:
            typeof parsed.cliproxyApiManagementKey === "string"
                ? parsed.cliproxyApiManagementKey.trim()
                : DEFAULT_CONFIG.cliproxyApiManagementKey,
        sub2apiUrl:
            typeof parsed.sub2apiUrl === "string"
                ? parsed.sub2apiUrl.trim()
                : DEFAULT_CONFIG.sub2apiUrl,
        sub2apiEmail:
            typeof parsed.sub2apiEmail === "string"
                ? parsed.sub2apiEmail.trim()
                : DEFAULT_CONFIG.sub2apiEmail,
        sub2apiPassword:
            typeof parsed.sub2apiPassword === "string"
                ? parsed.sub2apiPassword
                : DEFAULT_CONFIG.sub2apiPassword,
        sub2apiGroupName:
            typeof parsed.sub2apiGroupName === "string" && parsed.sub2apiGroupName.trim()
                ? parsed.sub2apiGroupName.trim()
                : DEFAULT_CONFIG.sub2apiGroupName,
        sub2apiGroupNames: normalizeStringArray(parsed.sub2apiGroupNames),
        sub2apiProxyName:
            typeof parsed.sub2apiProxyName === "string"
                ? parsed.sub2apiProxyName.trim()
                : DEFAULT_CONFIG.sub2apiProxyName,
        sub2apiAccountPriority:
            typeof parsed.sub2apiAccountPriority === "number"
                ? parsed.sub2apiAccountPriority
                : DEFAULT_CONFIG.sub2apiAccountPriority,
        sub2apiConcurrency:
            typeof parsed.sub2apiConcurrency === "number"
                ? parsed.sub2apiConcurrency
                : DEFAULT_CONFIG.sub2apiConcurrency,
    };
}

export const appConfig = loadConfig();
