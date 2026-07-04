import {mkdir, writeFile} from "node:fs/promises";
import {createInterface} from "node:readline/promises";
import net from "node:net";
import {stdin as input, stdout as output} from "node:process";
import tls from "node:tls";
import {URLSearchParams} from "node:url";
import path from "node:path";
import {Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher} from "undici";
import {SocksClient} from "socks";
import makeFetchCookie from "fetch-cookie";
import {CookieJar} from "tough-cookie";
import {appConfig} from "./config.js";
import {shouldAutoUploadAuthToCLIProxyAPI, uploadAuthFileToCLIProxyAPI} from "./cliproxyapi.js";
import {defaultDeviceProfile, type DeviceProfile, getDeviceClientHints} from "./device-profile.js";
import {
    AUTH_AUTHORIZE_CONTINUE_URL,
    AUTH_BASE_URL,
    AUTH_EMAIL_OTP_SEND_URL,
    AUTH_EMAIL_OTP_VALIDATE_URL,
    AUTH_OAUTH_TOKEN_URLS,
    AUTH_PASSWORD_VERIFY_URL,
    AUTH_REGISTER_URL,
    AUTH_WORKSPACE_SELECT_URL,
    CHATGPT_BASE_URL,
    DEFAULT_CLIENT_ID,
    DEFAULT_REDIRECT_URI,
    DEFAULT_USER_AGENT,
} from "./constants.js";
import {getEmailAddress, getEmailVerificationCode, MAILBOX_CONFIG} from "./mailbox.js";
import {fetchSentinelToken} from "./sentinel.js";
import { pkceCodeChallenge, randomUrlSafeString } from "./utils.js";
import {ISMSActivationBroker} from "./sms/activation-broker.js";

type FetchLike = typeof fetch;

const DEFAULT_INSECURE_TLS = true;
const FETCH_RETRY_COUNT = 3;
const FETCH_RETRY_DELAY_MS = 1500;
const DEFAULT_FETCH_TIMEOUT_MS = 45000;
const AUTHORIZE_CONTINUE_RATE_LIMIT_DELAYS_MS = [8000, 15000, 30000];

function resolveProxyUrl(): string {
    for (const key of ["OPENAI_PROXY_URL", "DEFAULT_PROXY_URL"]) {
        if (process.env[key] !== undefined) {
            const value = String(process.env[key] ?? "").trim();
            return value.toLowerCase() === "direct" ? "" : value;
        }
    }
    const configured = (appConfig.defaultProxyUrl || "").trim();
    return configured.toLowerCase() === "direct" ? "" : configured;
}

function resolveFetchTimeoutMs(): number {
    const parsed = Number(process.env.OPENAI_FETCH_TIMEOUT_MS || "");
    if (Number.isFinite(parsed) && parsed > 0) {
        return Math.max(5000, Math.min(300000, Math.floor(parsed)));
    }
    const configured = Number(appConfig.openaiFetchTimeoutMs || 0);
    if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_FETCH_TIMEOUT_MS;
    return Math.max(5000, Math.min(300000, Math.floor(configured)));
}

function maskProxyForLog(value: string): string {
    if (!value) return "direct";
    try {
        const url = new URL(value);
        if (url.username) url.username = "***";
        if (url.password) url.password = "***";
        return url.toString();
    } catch {
        return value.length > 24 ? `${value.slice(0, 12)}...${value.slice(-8)}` : value;
    }
}

function shouldAllowInsecureTLS(): boolean {
    return DEFAULT_INSECURE_TLS;
}

function createDispatcher(proxyUrl: string, allowInsecureTLS: boolean): Dispatcher {
    if (!proxyUrl) {
        return new Agent({
            connect: {
                rejectUnauthorized: !allowInsecureTLS,
            },
        });
    }

    const parsedProxyUrl = new URL(proxyUrl);
    if (parsedProxyUrl.protocol === "http:" || parsedProxyUrl.protocol === "https:") {
        return new ProxyAgent({
            uri: proxyUrl,
            requestTls: {
                rejectUnauthorized: !allowInsecureTLS,
            },
        });
    }

    if (isSocksProtocol(parsedProxyUrl.protocol)) {
        const connect = ((options, callback) => {
            void createSocksSocket(parsedProxyUrl, options as unknown as Record<string, unknown>, allowInsecureTLS)
                .then((socket) => callback(null, socket))
                .catch((error) => callback(error instanceof Error ? error : new Error(String(error)), null));
        }) as NonNullable<ConstructorParameters<typeof Agent>[0]>["connect"];

        return new Agent({
            connect,
        });
    }

    throw new Error(`不支持的代理协议: ${parsedProxyUrl.protocol}`);
}

function isSocksProtocol(protocol: string): boolean {
    return ["socks4:", "socks4a:", "socks5:", "socks5h:"].includes(protocol);
}

async function createSocksSocket(
    proxyUrl: URL,
    options: Record<string, unknown>,
    allowInsecureTLS: boolean,
): Promise<net.Socket> {
    const destinationHost = String(options.hostname ?? "");
    const rawPort = options.port;
    const destinationPort =
        rawPort === "" || rawPort == null
            ? (options.protocol === "https:" ? 443 : 80)
            : Number(rawPort);
    const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol.startsWith("socks5") ? 1080 : 1080));
    const proxyType = proxyUrl.protocol.startsWith("socks4") ? 4 : 5;

    const connection = await SocksClient.createConnection({
        proxy: {
            host: proxyUrl.hostname,
            port: proxyPort,
            type: proxyType,
            userId: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined,
        },
        command: "connect",
        destination: {
            host: destinationHost,
            port: destinationPort,
        },
    });

    const socket = connection.socket;
    if (options.protocol !== "https:") {
        return socket;
    }

    return await new Promise<net.Socket>((resolve, reject) => {
        const tlsSocket = tls.connect({
            socket,
            host: String(options.servername ?? destinationHost),
            servername: String(options.servername ?? destinationHost),
            rejectUnauthorized: !allowInsecureTLS,
        });
        tlsSocket.once("secureConnect", () => resolve(tlsSocket));
        tlsSocket.once("error", reject);
    });
}

interface ContinueResponse {
    continue_url: string;
    method?: string;
    page?: {
        type?: string;
        backstack_behavior?: string;
        payload?: {
            url?: string;
        };
    };
}

interface AuthSessionWorkspace {
    id: string;
    name?: string;
    kind?: string;
}

interface ClientAuthSessionPayload {
    workspaces?: AuthSessionWorkspace[];
}

interface OAuthTokenResponse {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
}

interface JwtPayload {
    email?: string;
    exp?: number;
    "https://api.openai.com/auth"?: {
        chatgpt_account_id?: string;
    };
}

export interface AuthLoginResult {
    callbackURL: string;
    code: string;
    state: string;
    authFile?: string;
}

interface ChatGPTAuthSession {
    accessToken?: string;
    access_token?: string;
    error?: string;
}

interface ChatGPTAccessTokenClaims {
    exp?: number;
}

export interface SavedAuthRecord {
    access_token: string;
    account_id: string;
    disabled: boolean;
    email: string;
    expired: string;
    id_token: string;
    last_refresh: string;
    refresh_token: string;
    type: "codex";
    websockets: false;
}

export interface OpenAIClientOptions {
    email?: string;
    password: string;
    userAgent?: string;
    deviceProfile?: DeviceProfile;
    manualMode?: boolean;
    signupScreenHint?: string;
    smsBroker?: ISMSActivationBroker;
    /**
     * 当 OAuth 登录流程要求 add-email（phone-only 账号 codex CLI OAuth）时，
     * 用这个 email 提交 add-email/send，并通过 fetchAddEmailOtp 接 OTP。
     */
    bindEmail?: string;
    fetchEmailOtp?: () => Promise<string>;
    fetchAddEmailOtp?: () => Promise<string>;
}

export class OpenAIClient {
    email: string;
    readonly password: string;
    readonly manualMode: boolean;
    readonly jar: CookieJar;
    readonly fetch: FetchLike;
    readonly userAgent: string;
    readonly deviceProfile: DeviceProfile;
    readonly clientHints: ReturnType<typeof getDeviceClientHints>;
    readonly signupScreenHint: string;
    state = "";
    codeVerifier = "";
    deviceID = "";
    readonly smsBroker?: ISMSActivationBroker;
    readonly bindEmail: string;
    readonly fetchEmailOtp?: () => Promise<string>;
    readonly fetchAddEmailOtp?: () => Promise<string>;
    lastAddEmailVerified = "";
    lastEmailOtpVerified = "";

    constructor(options: OpenAIClientOptions) {
        this.smsBroker = options.smsBroker;
        this.bindEmail = options.bindEmail?.trim() ?? "";
        this.fetchEmailOtp = options.fetchEmailOtp;
        this.fetchAddEmailOtp = options.fetchAddEmailOtp;
        this.email = options.email?.trim() ?? "";
        this.password = options.password;
        this.deviceProfile = options.deviceProfile
            ? {
                ...options.deviceProfile,
                languages: [...options.deviceProfile.languages],
            }
            : {
                ...defaultDeviceProfile(),
                userAgent: options.userAgent?.trim() || DEFAULT_USER_AGENT,
            };
        this.userAgent = this.deviceProfile.userAgent;
        this.clientHints = getDeviceClientHints(this.deviceProfile);
        this.manualMode = options.manualMode ?? !this.email;
        this.signupScreenHint = options.signupScreenHint?.trim() || "signup";
        this.jar = new CookieJar();
        const proxyUrl = resolveProxyUrl();
        console.log(`[openai] proxy=${maskProxyForLog(proxyUrl)} timeout=${resolveFetchTimeoutMs()}ms`);
        setGlobalDispatcher(createDispatcher(proxyUrl, shouldAllowInsecureTLS()));
        const cookieFetch = makeFetchCookie(fetch, this.jar) as FetchLike;
        this.fetch = ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) =>
            this.fetchWithRetry(cookieFetch, input, init)) as FetchLike;
    }

    private logProgress(current: number | string, total: number, message: string): void {
        console.log(`[${current}/${total}] ${message}`);
    }

    /**
     * Codex CPA 登录：用 CPA 给的 authorize URL（PKCE/state 由 CPA 持有），
     * 走完所有用户交互（password / add-email / consent），最终拿到 localhost callback URL，
     * 但**不**交换 token —— 把 callback URL 交给 CPA 由 CPA 完成 token 交换并入库。
     *
     * 适用：phone-only 账号通过 codex CLI OAuth 登录的入库链路。
     *
     * @param authorizeUrl CPA 的 /v0/management/codex-auth-url 返回的 URL
     * @returns localhost:1455/auth/callback?... 完整 URL
     */
    async authLoginViaCpaAuthorizeURL(authorizeUrl: string, flowLabel = "CPA"): Promise<string> {
        const totalSteps = 6;
        this.logProgress(1, totalSteps, `打开 ${flowLabel} 授权页`);
        const oauthResp = await this.fetch(authorizeUrl, {
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
            }),
        });
        if (!oauthResp.ok) {
            throw new Error(`${flowLabel} OauthUrl请求失败: ${oauthResp.status}`);
        }
        if (oauthResp.url.startsWith(DEFAULT_REDIRECT_URI)) {
            return oauthResp.url;
        }
        if (
            oauthResp.url !== `${AUTH_BASE_URL}/log-in` &&
            oauthResp.url !== `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`
        ) {
            throw new Error(`${flowLabel} OauthUrl重定向到错误的URL: ${oauthResp.url}`);
        }

        this.deviceID = await this.readCookie("https://openai.com", "oai-did");
        if (!this.deviceID) {
            throw new Error(`${flowLabel} OauthUrl未返回oai-did cookie`);
        }

        if (oauthResp.url === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            this.logProgress(5, totalSteps, "选择工作区");
            const continueURL = await this.selectWorkspace(oauthResp.url);
            this.logProgress(6, totalSteps, "跟随回调到 localhost");
            return await this.followToLocalhostCallback(continueURL);
        }

        this.logProgress(2, totalSteps, "提交登录用户名");
        let continueURL = await this.authorizeContinue();
        if (continueURL === `${AUTH_BASE_URL}/log-in/password`) {
            this.logProgress(3, totalSteps, "密码页改走邮箱验证码");
            continueURL = await this.sendEmailOtpForLogin();
        }

        if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
            this.logProgress(4, totalSteps, "提交邮箱验证码");
            continueURL = await this.emailOtpValidate();
            this.lastEmailOtpVerified = this.bindEmail || this.email;
        }

        if (continueURL === `${AUTH_BASE_URL}/add-phone`) {
            throw new Error(`${flowLabel} 登录触发 add-phone 流程，当前不支持`);
        }

        if (continueURL === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            this.logProgress(5, totalSteps, "选择工作区");
            continueURL = await this.selectWorkspace(continueURL);
        }

        if (continueURL === `${AUTH_BASE_URL}/add-email`) {
            if (!this.bindEmail) {
                throw new Error("OAuth 跳到 /add-email 但未提供 bindEmail");
            }
            this.logProgress("5-a", totalSteps, `提交绑定邮箱: ${this.bindEmail}`);
            continueURL = await this.sendAddEmail(this.bindEmail);
            if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
                this.logProgress("5-b", totalSteps, "等待并提交邮箱 OTP");
                if (!this.fetchAddEmailOtp) {
                    throw new Error("/email-verification 但未配置 fetchAddEmailOtp");
                }
                const code = await this.fetchAddEmailOtp();
                if (!code) throw new Error("add-email OTP 未提供");
                continueURL = await this.emailOtpValidate(code);
                this.lastAddEmailVerified = this.bindEmail;
            }
            if (continueURL === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
                continueURL = await this.selectWorkspace(continueURL);
            }
        }

        this.logProgress(6, totalSteps, "跟随回调到 localhost");
        return await this.followToLocalhostCallback(continueURL);
    }

    /**
     * 从 continueURL（通常是 https://auth.openai.com/authorize/xxx 或类似）
     * 跟着重定向链直到 localhost:1455/auth/callback?code=...&state=...
     * 不抛 add-phone 异常（CPA 流程已在前面处理过）。
     */
    private async followToLocalhostCallback(startURL: string): Promise<string> {
        if (startURL.startsWith(DEFAULT_REDIRECT_URI)) {
            return startURL;
        }
        let currentURL = startURL;
        for (let hop = 0; hop < 10; hop++) {
            const response = await this.fetch(currentURL, {
                method: "GET",
                redirect: "manual",
                headers: {
                    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "user-agent": this.userAgent,
                    "accept-language": this.deviceProfile.acceptLanguage,
                },
            });
            const location = response.headers.get("location");
            if (location) {
                const nextURL = new URL(location, currentURL).toString();
                if (nextURL.startsWith(DEFAULT_REDIRECT_URI)) {
                    return nextURL;
                }
                currentURL = nextURL;
                continue;
            }
            if (response.url.startsWith(DEFAULT_REDIRECT_URI)) {
                return response.url;
            }
            throw new Error(`OAuth跳转未到达 localhost callback: status=${response.status} url=${response.url}`);
        }
        throw new Error(`OAuth跳转次数过多，最后停在: ${currentURL}`);
    }

    async authLoginHTTP(): Promise<AuthLoginResult> {
        const totalSteps = 6;
        this.logProgress(1, totalSteps, "打开登录授权页");
        const oauthUrl = this.prepareManualLogin();
        const oauthResp = await this.fetch(oauthUrl, {
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
            }),
        });
        if (!oauthResp.ok) {
            throw new Error(`OauthUrl请求失败: ${oauthResp.status}`);
        }
        if (oauthResp.url.startsWith(DEFAULT_REDIRECT_URI)) {
            const result = this.extractAuthResult(oauthResp.url);
            const authRecord = await this.exchangeCodeForToken(result.code);
            const authPath = await this.saveAuthRecord(authRecord);
            result.authFile = authPath;
            return result;
        }
        if (
            oauthResp.url !== `${AUTH_BASE_URL}/log-in` &&
            oauthResp.url !== `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`
        ) {
            throw new Error(`OauthUrl重定向到错误的URL: ${oauthResp.url}`);
        }

        this.deviceID = await this.readCookie("https://openai.com", "oai-did");
        if (!this.deviceID) {
            throw new Error("OauthUrl未返回oai-did cookie");
        }

        if (oauthResp.url === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            this.logProgress(5, totalSteps, "选择工作区");
            let consentNext = await this.selectWorkspace(oauthResp.url);

            // 新 phone 账号可能没 workspace,selectWorkspace 返回仍是 consent
            if (consentNext === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent` || consentNext === oauthResp.url) {
                console.log(`[oauth] selectWorkspace 返回仍是 consent, 尝试 GET follow redirect`);
                const resp = await this.fetch(consentNext, {
                    method: "GET",
                    redirect: "manual",
                    headers: this.createBrowserHeaders({}),
                });
                const loc = resp.headers.get("location");
                if (loc) {
                    consentNext = new URL(loc, consentNext).toString();
                    console.log(`[oauth] consent 302 → ${consentNext}`);
                } else {
                    // 200 = 需要 POST consent form。尝试直接 POST accept
                    console.log(`[oauth] consent 页返回 200,尝试 POST 同意`);
                    const postResp = await this.fetch(consentNext, {
                        method: "POST",
                        redirect: "manual",
                        headers: this.createBrowserHeaders({
                            "content-type": "application/x-www-form-urlencoded",
                            origin: AUTH_BASE_URL,
                            referer: consentNext,
                        }),
                        body: "consent=true",
                    });
                    const postLoc = postResp.headers.get("location");
                    if (postLoc) {
                        consentNext = new URL(postLoc, consentNext).toString();
                        console.log(`[oauth] consent POST 302 → ${consentNext}`);
                    } else {
                        // 实在拿不到,试用 followOAuthRedirects 走原始 URL
                        console.warn(`[oauth] consent POST 也没 redirect, status=${postResp.status}`);
                    }
                }
            }

            this.logProgress(6, totalSteps, "交换授权并保存凭证");
            const result = await this.followOAuthRedirects(consentNext);
            const authRecord = await this.exchangeCodeForToken(result.code);
            const authPath = await this.saveAuthRecord(authRecord);
            result.authFile = authPath;
            return result;
        }

        this.logProgress(2, totalSteps, "提交登录邮箱");
        let continueURL = await this.authorizeContinue();
        if (continueURL === `${AUTH_BASE_URL}/log-in/password`) {
            this.logProgress(3, totalSteps, "密码页改走邮箱验证码");
            continueURL = await this.sendEmailOtpForLogin();
        }

        if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
            this.logProgress(4, totalSteps, "提交邮箱验证码");
            continueURL = await this.emailOtpValidate();
        }

        if (continueURL === `${AUTH_BASE_URL}/add-phone`) {
            // --skip-phone: 尝试跳过 phone 验证，直接走 email-otp 路径
            if (process.argv.includes("--skip-phone")) {
                this.logProgress('4-skip', totalSteps, "检测到 add-phone，尝试跳过走 email-otp");
                try {
                    const emailOtpContinue = await this.sendEmailOtp();
                    console.log(`[skip-phone] sendEmailOtp 成功，continue_url=${emailOtpContinue}`);
                    if (emailOtpContinue === `${AUTH_BASE_URL}/email-verification`) {
                        this.logProgress('4-skip-b', totalSteps, "等待邮箱验证码");
                        continueURL = await this.emailOtpValidate();
                        console.log(`[skip-phone] emailOtpValidate 成功，continue_url=${continueURL}`);
                    } else {
                        continueURL = emailOtpContinue;
                    }
                } catch (e) {
                    console.error(`[skip-phone] 失败: ${(e as Error).message}`);
                    console.error(`[skip-phone] 将回退到 phone 流程`);
                }
            }
        }

        if (continueURL === `${AUTH_BASE_URL}/add-phone`) {
            if (!this.smsBroker) {
                throw new Error("未配置 SMS provider，无法进行短信验证");
            }
            // 45s (15 * 3000ms) 接不到验证码自动换号重试，最多 8 次
            const MAX_PHONE_ATTEMPTS = 8;
            let phoneSuccess = false;
            let lastErr: unknown = null;
            for (let phoneTry = 1; phoneTry <= MAX_PHONE_ATTEMPTS; phoneTry += 1) {
                this.logProgress('4-a', totalSteps, `(${phoneTry}/${MAX_PHONE_ATTEMPTS}) 进入短信验证流程，从接码平台获取号码`);
                const lease = await this.smsBroker.getActivation();
                this.logProgress('4-b', totalSteps, `(${phoneTry}/${MAX_PHONE_ATTEMPTS}) 发送短信验证码，phone=+${lease.phoneNumber}`);
                const phoneNumber = `+${lease.phoneNumber}`;
                let sendOk = false;
                try {
                    continueURL = await this.sendPhoneOtp(phoneNumber);
                    sendOk = true;
                } catch (e) {
                    lastErr = e;
                    console.warn(`[add-phone] sendPhoneOtp 失败(${(e as Error).message}), 换号重试`);
                    await this.smsBroker?.markAsFailed(true);
                    continue;
                }
                if (!sendOk) continue;

                this.logProgress('4-c', totalSteps, `(${phoneTry}/${MAX_PHONE_ATTEMPTS}) 等待短信验证码 (45s 超时换号)`);
                try {
                    const { code } = await lease.waitForVerificationCode();
                    this.logProgress('4-d', totalSteps, `提交短信验证，code=[${code}]`);
                    continueURL = await this.validatePhone(code);
                    phoneSuccess = true;
                    break;
                } catch (e) {
                    lastErr = e;
                    console.warn(`[add-phone] (${phoneTry}/${MAX_PHONE_ATTEMPTS}) 接码失败/超时(${(e as Error).message}), 换号重试`);
                    // 强制换号（rotate=true），不复用同一号
                    try { await this.smsBroker?.markAsFailed(true); } catch (_) { /* ignore */ }
                    continue;
                }
            }
            if (!phoneSuccess) {
                throw lastErr ?? new Error(`add-phone 重试 ${MAX_PHONE_ATTEMPTS} 次均失败`);
            }
        }

        if (continueURL === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            this.logProgress(5, totalSteps, "选择工作区");
            const wsResult = await this.selectWorkspace(continueURL);
            // 如果 selectWorkspace 返回仍是 consent(新 phone 账号无 workspace),
            // 直接 GET consent 页跟 redirect chain 走到 callback
            if (wsResult === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent` || wsResult === continueURL) {
                console.log(`[oauth] selectWorkspace 返回仍是 consent, 尝试 follow redirect chain`);
                const consentResp = await this.fetch(wsResult, {
                    method: "GET",
                    redirect: "manual",
                    headers: this.createBrowserHeaders({}),
                });
                const loc = consentResp.headers.get("location");
                continueURL = loc ? new URL(loc, wsResult).toString() : wsResult;
            } else {
                continueURL = wsResult;
            }
        }

        // phone-only 账号 codex OAuth 会要求绑定 email（add-email）
        if (continueURL === `${AUTH_BASE_URL}/add-email`) {
            if (!this.bindEmail) {
                throw new Error("OAuth 跳转到 /add-email 但没配置 bindEmail");
            }
            this.logProgress('5-a', totalSteps, `提交绑定邮箱: ${this.bindEmail}`);
            continueURL = await this.sendAddEmail(this.bindEmail);
            // 应该跳到 /email-verification
            if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
                this.logProgress('5-b', totalSteps, "等待并提交邮箱 OTP");
                if (!this.fetchAddEmailOtp) {
                    throw new Error("/email-verification 但没配置 fetchAddEmailOtp");
                }
                const code = await this.fetchAddEmailOtp();
                if (!code) throw new Error("add-email OTP 未提供");
                continueURL = await this.emailOtpValidate(code);
            }
        }

        this.logProgress(6, totalSteps, "交换授权并保存凭证");
        const result = await this.followOAuthRedirects(continueURL);
        const authRecord = await this.exchangeCodeForToken(result.code);
        const authPath = await this.saveAuthRecord(authRecord);
        result.authFile = authPath;
        return result;
    }

    /**
     * ChatGPT web 登录流程（非 codex CLI OAuth）。
     * 通过 chatgpt.com/api/auth/signin/openai 入口登录已有账号，
     * 最终 fetch chatgpt.com/api/auth/callback/openai 回调建立 session cookies，
     * 使后续 getChatGPTAccessToken() 能正常工作。
     *
     * 适用：phone 注册完成后，用 phone+password 走 ChatGPT web 登录拿 session token。
     */
    async authLoginChatGPTWeb(): Promise<void> {
        const totalSteps = 6;
        let step = 1;

        // Step 1: boot chatgpt.com session（拿 oai-did cookie）
        this.logProgress(step++, totalSteps, "初始化 ChatGPT web 会话");
        await this.bootChatGPTSession();

        // Step 2: POST chatgpt.com/api/auth/signin/openai 走 web 登录入口
        this.logProgress(step++, totalSteps, `打开 ChatGPT web 登录页 (${this.email})`);
        await this.openSignupPage(this.email);

        // Step 3: 提交用户名（phone 或 email）
        this.logProgress(step++, totalSteps, "提交登录用户名");
        let continueURL = await this.authorizeContinue();

        // Step 4: 提交密码
        if (continueURL === `${AUTH_BASE_URL}/log-in/password`) {
            this.logProgress(step++, totalSteps, "密码页改走邮箱验证码");
            continueURL = await this.sendEmailOtpForLogin();
        }

        // 处理 email-verification（某些情况下登录也需要 OTP）
        if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
            this.logProgress("4-a", totalSteps, "提交邮箱验证码");
            continueURL = await this.emailOtpValidate();
        }

        // 处理 add-email（phone-only 账号可能触发）
        if (continueURL === `${AUTH_BASE_URL}/add-email`) {
            if (!this.bindEmail) {
                throw new Error("ChatGPT web 登录跳到 /add-email 但未提供 bindEmail");
            }
            this.logProgress("5-a", totalSteps, `提交绑定邮箱: ${this.bindEmail}`);
            continueURL = await this.sendAddEmail(this.bindEmail);
            if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
                this.logProgress("5-b", totalSteps, "等待并提交邮箱 OTP");
                if (!this.fetchAddEmailOtp) {
                    throw new Error("/email-verification 但未配置 fetchAddEmailOtp");
                }
                const code = await this.fetchAddEmailOtp();
                if (!code) throw new Error("add-email OTP 未提供");
                continueURL = await this.emailOtpValidate(code);
            }
        }

        // 处理 about-you（新号首次登录可能触发）
        if (continueURL === `${AUTH_BASE_URL}/about-you`) {
            this.logProgress("5-c", totalSteps, "填写基础资料");
            continueURL = await this.completeAboutYou();
        }

        // Step final: 应该到了 chatgpt.com/api/auth/callback/openai?...
        if (continueURL.startsWith(`${CHATGPT_BASE_URL}/api/auth/callback/openai`)) {
            this.logProgress(6, totalSteps, "完成 ChatGPT 回调（建立 session）");
            await this.finishChatGPTRegistration(continueURL);
        } else {
            throw new Error(`ChatGPT web 登录未到达 callback，停在: ${continueURL}`);
        }
    }

    async authRegisterHTTP(): Promise<string> {
        const stepMessages = [
            "初始化注册会话",
            "生成注册邮箱",
            "打开注册页",
            "提交注册邮箱",
        ];
        let totalSteps = stepMessages.length;
        let step = 1;
        this.logProgress(step++, totalSteps, "初始化注册会话");
        await this.bootChatGPTSession();
        this.logProgress(step++, totalSteps, "生成注册邮箱");
        this.email = await this.generateRegisterEmail();
        console.log("registerEmail:", this.email);
        this.logProgress(step++, totalSteps, "打开注册页");
        await this.openSignupPage(this.email);

        this.logProgress(step++, totalSteps, "提交注册邮箱");
        let continueURL = await this.authorizeContinueForSignup();

        if (continueURL === `${AUTH_BASE_URL}/create-account/password`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交注册密码");
            continueURL = await this.registerPassword();
        }

        if (continueURL === AUTH_EMAIL_OTP_SEND_URL) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "发送邮箱验证码");
            continueURL = await this.sendEmailOtp();
        }

        if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交邮箱验证码");
            continueURL = await this.emailOtpValidate();
        }

        if (continueURL === `${AUTH_BASE_URL}/about-you`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "填写基础资料");
            continueURL = await this.completeAboutYou();
        }

        if (continueURL.startsWith(`${CHATGPT_BASE_URL}/api/auth/callback/openai`)) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "完成注册");
            await this.finishChatGPTRegistration(continueURL);
            console.log(`[注册成功] 邮箱：${this.email} 密码：${this.password}`);
        }

        return continueURL;
    }

    async authRegisterAndAuthorizeHTTP(): Promise<AuthLoginResult> {
        const stepMessages = [
            "打开直接注册授权页",
            "提交注册邮箱",
        ];
        let totalSteps = stepMessages.length;
        let step = 1;

        if (!this.email) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "生成注册邮箱");
            this.email = await this.generateRegisterEmail();
            console.log("registerEmail:", this.email);
        }

        this.logProgress(step++, totalSteps, "打开直接注册授权页");
        await this.openDirectSignupAuthorizePage(this.email);

        this.logProgress(step++, totalSteps, "提交注册邮箱");
        let continueURL = await this.authorizeContinueForSignup(this.signupScreenHint);

        if (continueURL === `${AUTH_BASE_URL}/log-in/password` || continueURL === `${AUTH_BASE_URL}/log-in`) {
            throw new Error(`邮箱已被 OpenAI 判定为已有账号，signup 注册流程被路由到登录分支: ${continueURL}`);
        }

        if (continueURL === `${AUTH_BASE_URL}/create-account/password`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交注册密码");
            continueURL = await this.registerPassword();
        }

        if (continueURL === AUTH_EMAIL_OTP_SEND_URL) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "发送邮箱验证码");
            continueURL = await this.sendEmailOtp();
        }

        if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交邮箱验证码");
            continueURL = await this.emailOtpValidate();
        }

        if (continueURL === `${AUTH_BASE_URL}/add-phone`) {
            if (!this.smsBroker) {
                throw new Error("未配置 SMS provider，无法进行短信验证");
            }
            // 45s 接不到验证码自动换号重试，最多 8 次
            const MAX_PHONE_ATTEMPTS = 8;
            let phoneSuccess = false;
            let lastErr: unknown = null;
            for (let phoneTry = 1; phoneTry <= MAX_PHONE_ATTEMPTS; phoneTry += 1) {
                this.logProgress(step, totalSteps + phoneTry, `(${phoneTry}/${MAX_PHONE_ATTEMPTS}) 进入短信验证流程，从接码平台获取号码`);
                const lease = await this.smsBroker.getActivation();
                this.logProgress(step, totalSteps + phoneTry, `(${phoneTry}/${MAX_PHONE_ATTEMPTS}) 发送短信验证码，phone=+${lease.phoneNumber}`);
                const phoneNumber = `+${lease.phoneNumber}`;
                let sendOk = false;
                try {
                    continueURL = await this.sendPhoneOtp(phoneNumber);
                    sendOk = true;
                } catch (e) {
                    lastErr = e;
                    console.warn(`[add-phone] sendPhoneOtp 失败(${(e as Error).message}), 换号重试`);
                    await this.smsBroker?.markAsFailed(true);
                    continue;
                }
                if (!sendOk) continue;

                this.logProgress(step, totalSteps + phoneTry, `(${phoneTry}/${MAX_PHONE_ATTEMPTS}) 等待短信验证码 (45s 超时换号)`);
                try {
                    const { code } = await lease.waitForVerificationCode();
                    this.logProgress(step, totalSteps + phoneTry, `提交短信验证，code=[${code}]`);
                    continueURL = await this.validatePhone(code);
                    phoneSuccess = true;
                    break;
                } catch (e) {
                    lastErr = e;
                    console.warn(`[add-phone] (${phoneTry}/${MAX_PHONE_ATTEMPTS}) 接码失败/超时(${(e as Error).message}), 换号重试`);
                    try { await this.smsBroker?.markAsFailed(true); } catch (_) { /* ignore */ }
                    continue;
                }
            }
            if (!phoneSuccess) {
                throw lastErr ?? new Error(`add-phone 重试 ${MAX_PHONE_ATTEMPTS} 次均失败`);
            }
            step += 1;
            totalSteps += 4;
        }

        if (continueURL === `${AUTH_BASE_URL}/about-you`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "填写基础资料");
            continueURL = await this.completeAboutYou();
        }

        if (continueURL === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "选择工作区");
            continueURL = await this.selectWorkspace(continueURL);
        }

        totalSteps += 1;
        this.logProgress(step++, totalSteps, "交换授权并保存凭证");
        return await this.finalizeAuthorizationFromContinueURL(continueURL);
    }

    prepareManualLogin(prompt: "login" | "none" = "login"): string {
        this.state = randomUrlSafeString(24);
        this.codeVerifier = randomUrlSafeString(64);
        const query = new URLSearchParams({
            client_id: DEFAULT_CLIENT_ID,
            response_type: "code",
            redirect_uri: DEFAULT_REDIRECT_URI,
            scope: "openid email profile offline_access",
            state: this.state,
            code_challenge: pkceCodeChallenge(this.codeVerifier),
            code_challenge_method: "S256",
            prompt,
            id_token_add_organizations: "true",
            codex_cli_simplified_flow: "true",
        });
        return `${AUTH_BASE_URL}/oauth/authorize?${query.toString()}`;
    }

    /**
     * ChatGPT.com (web) 的 phone-first 注册入口。
     * 用 chatgpt.com 的 client_id (app_X8zY6vW2pQ9tR3dE7nK1jL5gH)，
     * scope 包含 model.read/model.request 等 ChatGPT 网页所需 scope，
     * redirect 回到 chatgpt.com/api/auth/callback/openai。
     *
     * 该入口允许 username 是 +<phone>，触发 phone-first signup 流程。
     */
    prepareChatGPTWebAuthorizeURL(loginHintPhone: string): string {
        this.state = randomUrlSafeString(24);
        this.codeVerifier = randomUrlSafeString(64);
        const query = new URLSearchParams({
            client_id: "app_X8zY6vW2pQ9tR3dE7nK1jL5gH",
            scope: "openid email profile offline_access model.request model.read organization.read organization.write",
            response_type: "code",
            redirect_uri: "https://chatgpt.com/api/auth/callback/openai",
            audience: "https://api.openai.com/v1",
            device_id: this.deviceProfile?.id || randomUrlSafeString(36),
            prompt: "login",
            "ext-oai-did": this.deviceProfile?.id || randomUrlSafeString(36),
            screen_hint: "login_or_signup",
            login_hint: loginHintPhone,
            state: this.state,
        });
        return `${AUTH_BASE_URL}/api/accounts/authorize?${query.toString()}`;
    }

    async openChatGPTWebAuthorizePage(loginHintPhone: string): Promise<void> {
        const url = this.prepareChatGPTWebAuthorizeURL(loginHintPhone);
        const response = await this.fetch(url, {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "cross-site",
                referer: "https://chatgpt.com/",
            }),
        });
        if (!response.ok) {
            throw new Error(`打开 ChatGPT 网页授权页失败: ${response.status}`);
        }
        // 调试 + 早期判定：OAI 把 session 推到哪个页面决定后续状态机。
        //   /create-account/password → 新号，正常走 register
        //   /log-in/password         → 该号已注册，走 register 必失败（invalid_auth_step）
        //   /log-in                  → 也是已注册路径
        const finalURL = String(response.url || "");
        console.log(`[phone-signup] authorize page resolved url: ${finalURL}`);
        if (finalURL.startsWith(`${AUTH_BASE_URL}/log-in`)) {
            // 用 PHONE_ALREADY_REGISTERED 这个稳定前缀，外层 retry 可以识别后跳过该号
            throw new Error(
                `PHONE_ALREADY_REGISTERED: 手机号 ${loginHintPhone} 已被 OpenAI 注册（authorize 跳到 ${finalURL}），换号`,
            );
        }
    }

    /**
     * Phone-first signup 的 phone OTP 发送：GET /api/accounts/phone-otp/send
     * 这条路径不带 phone_number body，号码已经在 authorize 阶段通过 login_hint 注册。
     * 实际发短信由 user/register 之后的 302 redirect 自动触发。
     */
    async sendPhoneOtpForSignup(): Promise<string> {
        const response = await this.fetch(`${AUTH_BASE_URL}/api/accounts/phone-otp/send`, {
            method: "GET",
            headers: this.createBrowserHeaders({
                accept: "application/json",
                referer: `${AUTH_BASE_URL}/create-account/password`,
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "same-origin",
            }),
        });
        if (!response.ok) {
            throw new Error(`PhoneSignupOtpSend请求失败: ${await this.formatErrorResponse(response)}`);
        }
        // 这是个 GET endpoint（302 -> /contact-verification），但是某些版本可能返回 JSON
        try {
            const payload = (await response.json()) as ContinueResponse;
            return payload.continue_url ?? "";
        } catch {
            return "";
        }
    }

    /**
     * Phone-first 注册一体化流程。
     * @param phoneNumber 完整手机号 (+57xxxxxxx)
     * @param fetchPhoneCode  () => Promise<string>  从外部接码平台取 OTP
     */
    async authPhoneSignupHTTP(
        phoneNumber: string,
        fetchPhoneCode: () => Promise<string>,
    ): Promise<{callbackURL: string}> {
        if (!phoneNumber.startsWith("+")) {
            throw new Error(`phoneNumber 必须包含国家码前缀，比如 +57xxx, got: ${phoneNumber}`);
        }
        // phone 当 email 用（auth 文件名等）
        if (!this.email) {
            this.email = phoneNumber;
        }

        const totalSteps = 5;

        // Step 1: 打开 chatgpt.com web authorize 页（带 login_hint=+phone）
        this.logProgress(1, totalSteps, `打开 ChatGPT 网页授权页 (phone=${phoneNumber})`);
        await this.openChatGPTWebAuthorizePage(phoneNumber);

        // Step 2: POST /api/accounts/user/register
        // 复用 registerPassword 但 username 是 phone（不是 email）
        this.logProgress(2, totalSteps, `提交手机号注册`);
        const sentinelToken1 = await this.fetchSentinelToken("username_password_create");
        const respReg = await this.postJSON(
            AUTH_REGISTER_URL,
            {password: this.password, username: phoneNumber},
            {
                referer: `${AUTH_BASE_URL}/create-account/password`,
                sentinelToken: sentinelToken1,
            },
        );
        if (!respReg.ok) {
            throw new Error(`PhoneSignupRegister请求失败: ${await this.formatErrorResponse(respReg)}`);
        }
        // 响应 continue_url 应该是 /api/accounts/phone-otp/send
        await respReg.json();

        // Step 3: GET /api/accounts/phone-otp/send 触发 SMS
        this.logProgress(3, totalSteps, `触发 phone OTP 发送`);
        await this.sendPhoneOtpForSignup();

        // Step 4: 等待外部 OTP 输入，POST /api/accounts/phone-otp/validate
        this.logProgress(4, totalSteps, `等待 phone OTP`);
        const code = await fetchPhoneCode();
        if (!code) {
            throw new Error("phone OTP 未提供");
        }
        this.logProgress(4, totalSteps, `验证 phone OTP code=${code}`);
        const respValidate = await this.postJSON(
            `${AUTH_BASE_URL}/api/accounts/phone-otp/validate`,
            {code},
            {referer: `${AUTH_BASE_URL}/contact-verification`},
        );
        if (!respValidate.ok) {
            throw new Error(`PhoneSignupValidate请求失败: ${await this.formatErrorResponse(respValidate)}`);
        }
        await respValidate.json();

        // Step 5: 完成 about-you (create_account)
        this.logProgress(5, totalSteps, `填写基础资料并完成注册`);
        const callbackURL = await this.completeAboutYou();

        return {callbackURL};
    }

    async authorizeContinue(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("authorize_continue");
        // 自动检测 username kind：以 + 开头视为 phone_number
        const isPhone = this.email.startsWith("+");
        const usernameKind = isPhone ? "phone_number" : "email";
        const response = await this.fetch(AUTH_AUTHORIZE_CONTINUE_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "openai-sentinel-token": sentinelToken,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
            body: JSON.stringify({
                username: {
                    kind: usernameKind,
                    value: this.email,
                },
            }),
        });
        if (!response.ok) {
            throw new Error(
                `AuthorizeContinue请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        const nextUrl = payload.page?.payload?.url ?? payload.continue_url ?? `${AUTH_BASE_URL}/email-verification`;
        return new URL(nextUrl, AUTH_BASE_URL).toString();
    }

    async authorizeContinueForSignup(screenHint = "login_or_signup"): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("authorize_continue");
        const response = await this.postJSON(
            AUTH_AUTHORIZE_CONTINUE_URL,
            {
                username: {
                    kind: "email",
                    value: this.email,
                },
                screen_hint: screenHint,
            },
            {
                referer: `${AUTH_BASE_URL}/log-in-or-create-account?usernameKind=email`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            throw new Error(
                `AuthorizeContinue注册请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async passwordVerify(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("password_verify");
        const response = await this.postJSON(
            AUTH_PASSWORD_VERIFY_URL,
            {
                password: this.password,
            },
            {
                referer: `${AUTH_BASE_URL}/log-in/password`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            throw new Error(
                `PasswordVerify请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async emailOtpValidate(externalCode?: string): Promise<string> {
        const code = externalCode || await this.resolveEmailOtpCode();
        const response = await this.fetch(AUTH_EMAIL_OTP_VALIDATE_URL, {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                origin: AUTH_BASE_URL,
                referer: `${AUTH_BASE_URL}/email-verification`,
                "user-agent": this.userAgent,
            },
            body: JSON.stringify({code}),
        });
        if (!response.ok) {
            throw new Error(
                `EmailOtpValidate请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async registerPassword(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("username_password_create");
        const response = await this.postJSON(
            AUTH_REGISTER_URL,
            {
                password: this.password,
                username: this.email,
            },
            {
                referer: `${AUTH_BASE_URL}/create-account/password`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            throw new Error(
                `RegisterPassword请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async sendEmailOtp(): Promise<string> {
        const response = await this.fetch(AUTH_EMAIL_OTP_SEND_URL, {
            method: "GET",
            headers: {
                accept: "application/json",
                referer: `${AUTH_BASE_URL}/create-account/password`,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
        });
        if (!response.ok) {
            throw new Error(
                `EmailOtpSend请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async sendEmailOtpForLogin(): Promise<string> {
        const response = await this.fetch(`${AUTH_BASE_URL}/api/accounts/passwordless/send-otp`, {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                origin: AUTH_BASE_URL,
                referer: `${AUTH_BASE_URL}/log-in/password`,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
        });
        if (!response.ok) {
            throw new Error(
                `EmailOtpSendForLogin请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.page?.payload?.url ?? payload.continue_url ?? `${AUTH_BASE_URL}/email-verification`;
    }

    async validatePhone(code: string) {
        const response = await this.postJSON(`${AUTH_BASE_URL}/api/accounts/phone-otp/validate`,
          { code: code },
          { referer: `${AUTH_BASE_URL}/phone-verification` },
        );
        if (!response.ok) {
            throw new Error(
              `PhoneOtpValidate请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async sendPhoneOtp(phoneNumber: string) {
        const response = await this.postJSON(
          `${AUTH_BASE_URL}/api/accounts/add-phone/send`,
          {
              phone_number: phoneNumber,
          },
          {
              referer: `${AUTH_BASE_URL}/add-phone`,
          },
        );
        if (!response.ok) {
            throw new Error(
              `SendPhoneOtp请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    /**
     * Phone-only 账号补绑邮箱：POST /api/accounts/add-email/send
     * body: {"email": "xxx@outlook.com"}
     * 触发邮件 OTP 发送，响应 continue_url 跳到 /email-verification
     */
    async sendAddEmail(emailAddr: string): Promise<string> {
        const response = await this.postJSON(
            `${AUTH_BASE_URL}/api/accounts/add-email/send`,
            {email: emailAddr},
            {referer: `${AUTH_BASE_URL}/add-email`},
        );
        if (!response.ok) {
            throw new Error(
                `SendAddEmail请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async selectWorkspace(consentURL: string): Promise<string> {
        await this.fetch(consentURL, {
            method: "GET",
            headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                referer: `${AUTH_BASE_URL}/email-verification`,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
        });

        const workspaceID = await this.resolveWorkspaceID();
        const response = await this.fetch(AUTH_WORKSPACE_SELECT_URL, {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                origin: AUTH_BASE_URL,
                referer: consentURL,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
            body: JSON.stringify({
                workspace_id: workspaceID,
            }),
        });
        if (!response.ok) {
            throw new Error(
                `WorkspaceSelect请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async followOAuthRedirects(startURL: string): Promise<AuthLoginResult> {
        let currentURL = startURL;
        for (let hop = 0; hop < 10; hop++) {
            const response = await this.fetch(currentURL, {
                method: "GET",
                redirect: "manual",
                headers: {
                    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "user-agent": this.userAgent,
                    "accept-language": this.deviceProfile.acceptLanguage,
                    "sec-ch-ua": this.clientHints.secChUa,
                    "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                    "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                    "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                    "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                    "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
                },
            });

            const location = response.headers.get("location");
            if (location) {
                const nextURL = new URL(location, currentURL).toString();
                if (nextURL.startsWith(`${AUTH_BASE_URL}/add-phone`)) {
                    throw new Error("当前账号在登录后触发了 add-phone 绑手机流程，无法直接完成授权");
                }
                if (nextURL.startsWith(DEFAULT_REDIRECT_URI)) {
                    return this.extractAuthResult(nextURL);
                }
                currentURL = nextURL;
                continue;
            }

            if (response.url.startsWith(`${AUTH_BASE_URL}/add-phone`)) {
                throw new Error("当前账号在登录后触发了 add-phone 绑手机流程，无法直接完成授权");
            }

            if (response.url.startsWith(DEFAULT_REDIRECT_URI)) {
                return this.extractAuthResult(response.url);
            }

            throw new Error(
                `OAuth跳转未到达callback: status=${response.status} url=${response.url}`,
            );
        }

        throw new Error(`OAuth跳转次数过多，最后停在: ${currentURL}`);
    }

    private async finalizeAuthorizationFromContinueURL(startURL: string): Promise<AuthLoginResult> {
        if (startURL.startsWith(DEFAULT_REDIRECT_URI)) {
            const result = this.extractAuthResult(startURL);
            const authRecord = await this.exchangeCodeForToken(result.code);
            result.authFile = await this.saveAuthRecord(authRecord);
            return result;
        }

        const result = await this.followOAuthRedirects(startURL);
        const authRecord = await this.exchangeCodeForToken(result.code);
        result.authFile = await this.saveAuthRecord(authRecord);
        return result;
    }

    async fetchSentinelToken(
        flow:
            | "authorize_continue"
            | "password_verify"
            | "username_password_create"
            | "oauth_create_account",
    ): Promise<string> {
        return fetchSentinelToken({
            flow,
            deviceID: this.deviceID,
            fetch: this.fetch,
            reqEndpoint: "https://sentinel.openai.com/backend-api/sentinel/req",
            userAgent: this.userAgent,
            deviceProfile: this.deviceProfile,
        });
    }

    private async resolveEmailOtpCode(): Promise<string> {
        if (this.manualMode) {
            console.log(`manualEmailOtp: targetEmail=${this.email}`);
            return this.promptEmailOtp();
        }
        if (this.fetchEmailOtp) {
            return this.fetchEmailOtp();
        }
        console.log(`autoEmailOtp: provider=${MAILBOX_CONFIG.provider} targetEmail=${this.email}`);
        return getEmailVerificationCode(this.email);
    }

    private async generateRegisterEmail(): Promise<string> {
        if (this.email) {
            return this.email;
        }
        return getEmailAddress();
    }

    private async promptEmailOtp(): Promise<string> {
        const rl = createInterface({input, output});
        try {
            const code = (await rl.question("请输入邮箱验证码: ")).trim();
            if (!/^\d{6}$/.test(code)) {
                throw new Error(`邮箱验证码格式不正确: ${code}`);
            }
            return code;
        } finally {
            rl.close();
        }
    }

    private async completeAboutYou(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("oauth_create_account");
        const profile = this.randomProfile();
        console.log("registerProfile:", JSON.stringify(profile));

        const response = await this.postJSON(
            `${AUTH_BASE_URL}/api/accounts/create_account`,
            profile,
            {
                referer: `${AUTH_BASE_URL}/about-you`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            throw new Error(
                `CreateAccount请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.page?.payload?.url ?? payload.continue_url;
    }

    private async finishChatGPTRegistration(callbackURL: string): Promise<void> {
        const response = await this.fetch(callbackURL, {
            method: "GET",
            redirect: "follow",
            headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                referer: `${AUTH_BASE_URL}/about-you`,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
        });
        if (!response.ok) {
            throw new Error(`完成 ChatGPT 注册回调失败: ${response.status}`);
        }
    }

    async getChatGPTAccessToken(): Promise<string> {
        const response = await this.fetch(`${CHATGPT_BASE_URL}/api/auth/session`, {
            method: "GET",
            headers: this.createBrowserHeaders({
                accept: "application/json",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
                referer: `${CHATGPT_BASE_URL}/`,
            }),
        });
        if (!response.ok) {
            throw new Error(`获取 ChatGPT accessToken 失败: ${await this.formatErrorResponse(response)}`);
        }

        const payload = (await response.json()) as ChatGPTAuthSession;
        const accessToken = String(payload.accessToken ?? payload.access_token ?? "").trim();
        if (!accessToken) {
            throw new Error(`ChatGPT session 中缺少 accessToken: ${JSON.stringify(payload)}`);
        }
        return accessToken;
    }

    async saveChatGPTAccessToken(accessToken: string): Promise<string> {
        const atDir = path.resolve(process.cwd(), "auth", "at");
        await mkdir(atDir, {recursive: true});
        const fileName = this.buildAuthFileName(this.email);
        const filePath = path.join(atDir, fileName);
        const accessClaims = this.decodeJwtPayload<ChatGPTAccessTokenClaims>(accessToken);
        const expiresAt = accessClaims.exp
            ? new Date(accessClaims.exp * 1000).toISOString()
            : "";
        await writeFile(
            filePath,
            `${JSON.stringify({
                access_token: accessToken,
                expires_at: expiresAt,
                expires_in: accessClaims.exp
                    ? Math.max(0, Math.floor(accessClaims.exp - Date.now() / 1000))
                    : 0,
                email: this.email,
                cookie: await this.jar.getCookieString(CHATGPT_BASE_URL),
                last_refresh: new Date().toISOString(),
                type: "chatgpt",
            }, null, 2)}\n`,
            "utf8",
        );
        return filePath;
    }

    private async exchangeCodeForToken(code: string): Promise<SavedAuthRecord> {
        let lastError = "";
        for (const tokenURL of AUTH_OAUTH_TOKEN_URLS) {
            const body = new URLSearchParams({
                grant_type: "authorization_code",
                client_id: DEFAULT_CLIENT_ID,
                code,
                redirect_uri: DEFAULT_REDIRECT_URI,
                code_verifier: this.codeVerifier,
            });
            const response = await this.fetch(tokenURL, {
                method: "POST",
                headers: this.createBrowserHeaders({
                    accept: "application/json",
                    "content-type": "application/x-www-form-urlencoded",
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-site",
                }),
                body,
            });
            if (!response.ok) {
                lastError = `endpoint=${tokenURL} ${await this.formatErrorResponse(response)}`;
                continue;
            }

            const payload = (await response.json()) as OAuthTokenResponse;
            return this.normalizeAuthRecord(payload);
        }

        throw new Error(`Code换Token失败: ${lastError}`);
    }

    private async resolveWorkspaceID(): Promise<string> {
        const cookie = await this.readCookie(
            AUTH_BASE_URL,
            "oai-client-auth-session",
        );
        if (!cookie) {
            throw new Error("未找到 oai-client-auth-session cookie，无法提取 workspace");
        }

        const encodedPayload = cookie.split(".")[0];
        const payload = this.decodeSignedJson<ClientAuthSessionPayload>(encodedPayload);
        const workspaceID =
            payload.workspaces?.find((w) => w.kind === "personal")?.id
            ?? payload.workspaces?.[0]?.id;
        if (!workspaceID) {
            throw new Error(`当前会话未发现 workspace: ${JSON.stringify(payload)}`);
        }
        return workspaceID;
    }

    private decodeSignedJson<T>(encoded: string): T {
        const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        const json = Buffer.from(padded, "base64").toString("utf8");
        return JSON.parse(json) as T;
    }

    private normalizeAuthRecord(payload: OAuthTokenResponse): SavedAuthRecord {
        if (!payload.access_token) {
            throw new Error(`token响应缺少 access_token: ${JSON.stringify(payload)}`);
        }
        if (!payload.refresh_token) {
            throw new Error(`token响应缺少 refresh_token: ${JSON.stringify(payload)}`);
        }
        if (!payload.id_token) {
            throw new Error(`token响应缺少 id_token: ${JSON.stringify(payload)}`);
        }

        const accessClaims = this.decodeJwtPayload<JwtPayload>(payload.access_token);
        const idClaims = this.decodeJwtPayload<JwtPayload>(payload.id_token);
        const email = idClaims.email ?? accessClaims.email ?? this.email;
        const accountID =
            accessClaims["https://api.openai.com/auth"]?.chatgpt_account_id ??
            idClaims["https://api.openai.com/auth"]?.chatgpt_account_id ??
            "";
        const exp = accessClaims.exp;
        if (!accountID) {
            throw new Error(`token中缺少 account_id: ${JSON.stringify(accessClaims)}`);
        }
        if (!exp) {
            throw new Error(`access_token中缺少 exp: ${JSON.stringify(accessClaims)}`);
        }

        return {
            access_token: payload.access_token,
            account_id: accountID,
            disabled: false,
            email,
            expired: new Date(exp * 1000).toISOString(),
            id_token: payload.id_token,
            last_refresh: new Date().toISOString(),
            refresh_token: payload.refresh_token,
            type: "codex",
            websockets: false,
        };
    }

    private decodeJwtPayload<T>(token: string): T {
        const parts = token.split(".");
        if (parts.length < 2) {
            throw new Error(`JWT格式不正确: ${token.slice(0, 24)}...`);
        }
        return this.decodeSignedJson<T>(parts[1]);
    }

    private extractAuthResult(callbackURL: string): AuthLoginResult {
        const url = new URL(callbackURL);
        const code = url.searchParams.get("code") ?? "";
        const state = url.searchParams.get("state") ?? "";
        if (!code) {
            throw new Error(`callback 中缺少 code: ${callbackURL}`);
        }
        if (!state) {
            throw new Error(`callback 中缺少 state: ${callbackURL}`);
        }
        if (this.state && state !== this.state) {
            throw new Error(
                `callback state 不匹配: expected=${this.state} actual=${state}`,
            );
        }
        return {
            callbackURL,
            code,
            state,
        };
    }

    private async saveAuthRecord(record: SavedAuthRecord): Promise<string> {
        const authDir = path.resolve(process.cwd(), "auth");
        await mkdir(authDir, {recursive: true});
        const fileName = this.buildAuthFileName(record.email);
        const filePath = path.join(authDir, fileName);
        await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

        if (shouldAutoUploadAuthToCLIProxyAPI()) {
            try {
                await uploadAuthFileToCLIProxyAPI(fileName, record);
                console.log(`cliproxyApiAuthUploaded: ${fileName}`);
            } catch (error) {
                console.warn(
                    `cliproxyApiAuthUploadFailed: ${fileName} error=${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        return filePath;
    }

    private buildAuthFileName(email: string): string {
        const now = new Date();
        const date = [
            now.getFullYear(),
            `${now.getMonth() + 1}`.padStart(2, "0"),
            `${now.getDate()}`.padStart(2, "0"),
        ].join("-");
        const safeEmail = email.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
        return `${date}-${safeEmail}.json`;
    }

    private randomProfile(): { name: string; birthdate: string } {
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
        const age = this.randomInt(25, 34);
        const today = new Date();
        const birthYear = today.getFullYear() - age;
        const birthMonth = this.randomInt(1, 12);
        const maxDay = new Date(birthYear, birthMonth, 0).getDate();
        const birthDay = this.randomInt(1, maxDay);

        return {
            name: `${this.pick(firstNames)} ${this.pick(lastNames)}`,
            birthdate: [
                birthYear,
                `${birthMonth}`.padStart(2, "0"),
                `${birthDay}`.padStart(2, "0"),
            ].join("-"),
        };
    }

    private pick<T>(items: T[]): T {
        return items[Math.floor(Math.random() * items.length)];
    }

    private randomInt(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    private async bootChatGPTSession(): Promise<void> {
        const response = await this.fetch(`${CHATGPT_BASE_URL}/`, {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
            }),
        });
        if (!response.ok) {
            throw new Error(`打开 chatgpt.com 失败: ${response.status}`);
        }

        this.deviceID =
            (await this.readCookie(CHATGPT_BASE_URL, "oai-did")) ||
            (await this.readCookie("https://openai.com", "oai-did"));
        if (!this.deviceID) {
            throw new Error("chatgpt.com 未返回 oai-did cookie");
        }
    }

    private async openSignupPage(email: string): Promise<void> {
        const csrfCookie = await this.readCookie(
            CHATGPT_BASE_URL,
            "__Host-next-auth.csrf-token",
        );
        const csrfToken = decodeURIComponent(csrfCookie).split("|")[0] ?? "";
        if (!csrfToken) {
            throw new Error("未找到 __Host-next-auth.csrf-token，无法打开注册页");
        }

        const query = new URLSearchParams({
            prompt: "login",
            "ext-oai-did": this.deviceID,
            auth_session_logging_id: globalThis.crypto.randomUUID(),
            "ext-passkey-client-capabilities": "0111",
            screen_hint: "login_or_signup",
            login_hint: email,
        });
        const body = new URLSearchParams({
            callbackUrl: `${CHATGPT_BASE_URL}/`,
            csrfToken,
            json: "true",
        });

        const response = await this.fetch(
            `${CHATGPT_BASE_URL}/api/auth/signin/openai?${query.toString()}`,
            {
                method: "POST",
                redirect: "follow",
                headers: this.createBrowserHeaders({
                    accept: "*/*",
                    "content-type": "application/x-www-form-urlencoded",
                    origin: CHATGPT_BASE_URL,
                    referer: `${CHATGPT_BASE_URL}/`,
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
                }),
                body,
            },
        );
        if (!response.ok) {
            throw new Error(`打开注册页失败: ${response.status}`);
        }

        const payload = (await response.json()) as { url?: string };
        if (!payload.url) {
            throw new Error(`打开注册页缺少跳转URL: ${JSON.stringify(payload)}`);
        }

        const authorizeResp = await this.fetch(payload.url, {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                referer: `${CHATGPT_BASE_URL}/`,
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "same-site",
            }),
        });
        if (!authorizeResp.ok) {
            throw new Error(`打开 OpenAI authorize 页失败: ${authorizeResp.status}`);
        }
    }

    private async postJSON(
        url: string,
        payload: unknown,
        options: {
            referer: string;
            sentinelToken?: string;
        },
    ): Promise<Response> {
        const headers = this.createBrowserHeaders({
            accept: "application/json",
            "content-type": "application/json",
            origin: AUTH_BASE_URL,
            referer: options.referer,
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
        });
        if (options.sentinelToken) {
            headers.set("openai-sentinel-token", options.sentinelToken);
        }
        return this.fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
        });
    }

    private async readCookie(url: string, key: string): Promise<string> {
        const cookies = await this.jar.getCookies(url);
        return cookies.find((cookie) => cookie.key === key)?.value ?? "";
    }

    private async openDirectSignupAuthorizePage(email: string): Promise<void> {
        const oauthUrl = this.prepareManualLogin();
        const authorizeUrl = new URL(oauthUrl);
        authorizeUrl.searchParams.set("screen_hint", this.signupScreenHint);
        authorizeUrl.searchParams.set("login_hint", email);

        const response = await this.fetch(authorizeUrl.toString(), {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
            }),
        });
        if (!response.ok) {
            throw new Error(`打开直接注册授权页失败: ${response.status}`);
        }

        this.deviceID = await this.readCookie("https://openai.com", "oai-did");
        if (!this.deviceID) {
            throw new Error("直接注册授权页未返回 oai-did cookie");
        }
    }

    private createBrowserHeaders(init: Record<string, string>): Headers {
        return new Headers({
            "user-agent": this.userAgent,
            "accept-language": this.deviceProfile.acceptLanguage,
            "sec-ch-ua": this.clientHints.secChUa,
            "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
            "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
            "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
            "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
            "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            ...init,
        });
    }

    private async formatErrorResponse(response: Response): Promise<string> {
        const body = await response.text();
        try {
            const payload = JSON.parse(body) as {
                error?: {
                    code?: string | null;
                    message?: string | null;
                    description?: string | null;
                };
                error_description?: string | null;
                detail?: string | null;
                message?: string | null;
            };
            const err = payload.error;
            const code = err?.code ?? null;
            // 把所有可能的 description 字段都提取出来，方便定位 next_step / 提示
            const descParts = [
                err?.message,
                err?.description,
                payload.error_description,
                payload.detail,
                payload.message,
            ].filter((v): v is string => typeof v === "string" && v.length > 0);
            const desc = descParts.length > 0 ? descParts.join(" | ") : "";
            if (code || desc) {
                // 完整 body 也保留（截断 600 字符），避免漏掉嵌套字段
                const trimmed = body.length > 600 ? body.slice(0, 600) + "...(truncated)" : body;
                return `${response.status} code=${code ?? "?"} desc=${desc || "?"} body=${trimmed}`;
            }
        } catch {
            // ignore parse error and fall back to raw body
        }
        return `${response.status} body=${body}`;
    }

    private async fetchWithRetry(
        baseFetch: FetchLike,
        input: Parameters<FetchLike>[0],
        init?: Parameters<FetchLike>[1],
    ): Promise<Response> {
        let lastError: unknown;
        const timeoutMs = resolveFetchTimeoutMs();
        const isAuthorizeContinue = this.isAuthorizeContinueRetryTarget(input);
        const maxAttempts = isAuthorizeContinue
            ? Math.max(FETCH_RETRY_COUNT, AUTHORIZE_CONTINUE_RATE_LIMIT_DELAYS_MS.length + 1)
            : FETCH_RETRY_COUNT;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const timed = withFetchTimeout(init, timeoutMs);
            try {
                const response = await baseFetch(input, timed.init);
                if (response.status === 429 && isAuthorizeContinue && attempt < maxAttempts) {
                    const delayMs = AUTHORIZE_CONTINUE_RATE_LIMIT_DELAYS_MS[attempt - 1]
                        ?? AUTHORIZE_CONTINUE_RATE_LIMIT_DELAYS_MS[AUTHORIZE_CONTINUE_RATE_LIMIT_DELAYS_MS.length - 1];
                    console.log(`[authorize-continue 429] ${this.email} 第 ${attempt} 次被限流，等待 ${delayMs}ms 后重试`);
                    await response.arrayBuffer().catch(() => undefined);
                    await sleep(delayMs);
                    continue;
                }
                return response;
            } catch (error) {
                const reportedError = timed.didTimeout()
                    ? withCause(new Error(`request timeout after ${timeoutMs}ms`), error)
                    : error;
                lastError = reportedError;
                if (!isRetryableFetchError(reportedError) || attempt >= maxAttempts) {
                    throw reportedError;
                }
                console.log(
                    `[网络重试 ${attempt}/${maxAttempts}] ${this.describeRetryTarget(input)} ${this.describeRetryError(reportedError)}`,
                );
                console.log(`[延迟] 网络重试等待 ${FETCH_RETRY_DELAY_MS * attempt}ms`);
                await sleep(FETCH_RETRY_DELAY_MS * attempt);
            } finally {
                timed.cleanup();
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private isAuthorizeContinueRetryTarget(input: Parameters<FetchLike>[0]): boolean {
        return this.describeRetryTarget(input).startsWith(AUTH_AUTHORIZE_CONTINUE_URL);
    }

    private describeRetryTarget(input: Parameters<FetchLike>[0]): string {
        if (typeof input === "string") {
            return input;
        }
        if (input instanceof URL) {
            return input.toString();
        }
        if (typeof Request !== "undefined" && input instanceof Request) {
            return input.url;
        }
        return "unknown-url";
    }

    private describeRetryError(error: unknown): string {
        const cause = getErrorCause(error);
        if (!cause) {
            return error instanceof Error ? error.message : String(error);
        }
        const code = "code" in cause ? String((cause as { code?: unknown }).code ?? "") : "";
        return code ? `${cause.message} (${code})` : cause.message;
    }
}

function isRetryableFetchError(error: unknown): boolean {
    const message = collectErrorMessages(error).join(" ").toLowerCase();
    return [
        "aborterror",
        "aborted",
        "econnreset",
        "etimedout",
        "socket hang up",
        "proxy connection timed out",
        "request timeout",
        "timeout",
        "fetch failed",
        "eai_again",
        "ecannotassignrequestedaddress",
        "ehostunreach",
        "enetunreach",
    ].some((keyword) => message.includes(keyword));
}

function getErrorCause(error: unknown): Error | null {
    if (error instanceof Error && error.cause instanceof Error) {
        return error.cause;
    }
    return error instanceof Error ? error : null;
}

function collectErrorMessages(error: unknown): string[] {
    const messages: string[] = [];
    if (error instanceof Error) {
        messages.push(error.message);
        if (error.cause instanceof Error) {
            messages.push(error.cause.message);
            const code = "code" in error.cause ? String((error.cause as { code?: unknown }).code ?? "") : "";
            if (code) {
                messages.push(code);
            }
        }
        const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
        if (code) {
            messages.push(code);
        }
    } else if (error != null) {
        messages.push(String(error));
    }
    return messages;
}

function withFetchTimeout(
    init: Parameters<FetchLike>[1],
    timeoutMs: number,
): {init: Parameters<FetchLike>[1]; cleanup: () => void; didTimeout: () => boolean} {
    const controller = new AbortController();
    let timedOut = false;
    const upstreamSignal = init?.signal;
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);

    if (upstreamSignal?.aborted) {
        abortFromUpstream();
    } else {
        upstreamSignal?.addEventListener("abort", abortFromUpstream, {once: true});
    }

    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    return {
        init: {...init, signal: controller.signal},
        cleanup: () => {
            clearTimeout(timer);
            upstreamSignal?.removeEventListener("abort", abortFromUpstream);
        },
        didTimeout: () => timedOut,
    };
}

function withCause(error: Error, cause: unknown): Error {
    (error as Error & {cause?: unknown}).cause = cause;
    return error;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
