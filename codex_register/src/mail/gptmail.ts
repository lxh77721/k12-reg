import {fetch as undiciFetch, Agent, ProxyAgent, type Dispatcher, type RequestInit as UndiciRequestInit} from "undici";
import {appConfig} from "../config.js";
import {generateEmailName} from "./generate-email-name.js";
import {findLatestVerificationMail} from "./verification-matcher.js";

interface GPTMailEnvelope<T> {
    success?: boolean;
    data?: T;
    error?: string;
}

interface GPTMailGeneratedEmailData {
    email?: string;
}

interface GPTMailEmailItem {
    id?: string;
    email_address?: string;
    to_address?: string;
    recipient?: string;
    from_address?: string;
    sender?: string;
    from?: string;
    subject?: string;
    content?: string;
    body?: string;
    text?: string;
    html_content?: string;
    html?: string;
    has_html?: boolean;
    timestamp?: number;
    created_at?: string;
    createdAt?: string;
    date?: string;
}

interface GPTMailEmailsData {
    emails?: GPTMailEmailItem[];
    count?: number;
}

const GPTMAIL_API_BASE_URL = "https://mail.chatgpt.org.uk";
const GPTMAIL_POLL_ATTEMPTS = 12;
const GPTMAIL_POLL_INTERVAL_MS = 5000;

function normalizeEmail(value: string): string {
    return String(value ?? "").trim().toLowerCase();
}

function firstNonEmptyString(...values: unknown[]): string {
    for (const value of values) {
        const text = String(value ?? "").trim();
        if (text) {
            return text;
        }
    }
    return "";
}

function normalizeTimestamp(...values: unknown[]): number {
    for (const value of values) {
        if (value === undefined || value === null || value === "") {
            continue;
        }
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
        }
        const parsed = Date.parse(String(value));
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return 0;
}

function ensureApiBaseUrlConfigured(): string {
    return GPTMAIL_API_BASE_URL;
}

function ensureApiKeyConfigured(): string {
    const apiKey = String(appConfig.gptMailApiKey ?? "").trim();
    if (!apiKey) {
        throw new Error("gptMailApiKey 未配置，请先在 config.json 中填写 GPTMail API Key");
    }
    return apiKey;
}

function buildDispatcher(): Dispatcher {
    const proxyUrl = String(appConfig.defaultProxyUrl ?? "").trim();
    return proxyUrl
        ? new ProxyAgent({
            uri: proxyUrl,
            requestTls: {rejectUnauthorized: false},
        })
        : new Agent({
            connect: {rejectUnauthorized: false},
        });
}

async function gptMailFetch(input: string | URL, init: UndiciRequestInit = {}) {
    return undiciFetch(input, {
        ...init,
        dispatcher: buildDispatcher(),
    } satisfies UndiciRequestInit);
}

function buildHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return {
        Accept: "application/json",
        "X-API-Key": ensureApiKeyConfigured(),
        ...extraHeaders,
    };
}

async function requestJSON<T>(path: string, init: UndiciRequestInit = {}): Promise<T> {
    const baseUrl = ensureApiBaseUrlConfigured();
    const url = `${baseUrl}${path}`;
    const response = await gptMailFetch(url, init);
    const rawBody = await response.text();
    if (!response.ok) {
        throw new Error(`GPTMail 请求失败: ${response.status} body=${rawBody}`);
    }

    const payload = JSON.parse(rawBody) as GPTMailEnvelope<T>;
    if (!payload?.success) {
        throw new Error(`GPTMail 返回失败: ${payload?.error ?? rawBody}`);
    }
    return payload.data as T;
}

async function generateMailbox(): Promise<string> {
    const domain = String(appConfig.gptMailDomain ?? "").trim();
    const body: Record<string, string> = {
        prefix: generateEmailName(),
    };
    if (domain) {
        body.domain = domain;
    }

    const data = await requestJSON<GPTMailGeneratedEmailData>("/api/generate-email", {
        method: "POST",
        headers: buildHeaders({
            "Content-Type": "application/json",
        }),
        body: JSON.stringify(body),
    });
    const email = normalizeEmail(String(data?.email ?? ""));
    if (!email) {
        throw new Error(`GPTMail 生成邮箱返回异常: ${JSON.stringify(data)}`);
    }
    return email;
}

async function listEmails(email: string): Promise<GPTMailEmailItem[]> {
    const mailbox = normalizeEmail(email);
    if (!mailbox.includes("@")) {
        throw new Error(`邮箱格式不正确: ${email}`);
    }
    const url = new URL(`${ensureApiBaseUrlConfigured()}/api/emails`);
    url.searchParams.set("email", mailbox);
    const response = await gptMailFetch(url, {
        method: "GET",
        headers: buildHeaders(),
    });
    const rawBody = await response.text();
    if (!response.ok) {
        throw new Error(`GPTMail 邮件列表请求失败: ${response.status} body=${rawBody}`);
    }
    const payload = JSON.parse(rawBody) as GPTMailEnvelope<GPTMailEmailsData>;
    if (!payload?.success) {
        throw new Error(`GPTMail 邮件列表返回失败: ${payload?.error ?? rawBody}`);
    }
    const data = payload?.data as GPTMailEmailsData | GPTMailEmailItem[] | undefined;
    if (Array.isArray(data)) {
        return data;
    }
    return Array.isArray(data?.emails) ? data.emails : [];
}

async function getEmailDetail(id: string): Promise<GPTMailEmailItem> {
    const data = await requestJSON<GPTMailEmailItem>(`/api/email/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: buildHeaders(),
    });
    return data;
}

async function deleteEmail(id: string): Promise<void> {
    await requestJSON(`/api/email/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: buildHeaders(),
    });
}

export function createGPTMailProvider() {
    return {
        async getEmailAddress() {
            ensureApiBaseUrlConfigured();
            ensureApiKeyConfigured();
            return generateMailbox();
        },
        async getEmailVerificationCode(email: string) {
            ensureApiBaseUrlConfigured();
            ensureApiKeyConfigured();

            for (let attempt = 1; attempt <= GPTMAIL_POLL_ATTEMPTS; attempt += 1) {
                console.log(
                    `pollGPTMailOtp: attempt=${attempt}/${GPTMAIL_POLL_ATTEMPTS} targetEmail=${email}`,
                );

                const list = await listEmails(email);
                const details = await Promise.all(
                    list.map(async (mail) => {
                        const id = String(mail?.id ?? "").trim();
                        const detail = id ? await getEmailDetail(id) : mail;
                        return {
                            ...detail,
                            id: String(detail?.id ?? mail?.id ?? ""),
                            sender: firstNonEmptyString(
                                detail?.from_address,
                                detail?.sender,
                                detail?.from,
                                mail?.from_address,
                                mail?.sender,
                                mail?.from,
                            ),
                            recipient: firstNonEmptyString(
                                detail?.email_address,
                                detail?.to_address,
                                detail?.recipient,
                                mail?.email_address,
                                mail?.to_address,
                                mail?.recipient,
                            ),
                            subject: firstNonEmptyString(detail?.subject, mail?.subject),
                            content: firstNonEmptyString(
                                detail?.content,
                                detail?.body,
                                detail?.text,
                                mail?.content,
                                mail?.body,
                                mail?.text,
                            ),
                            timestamp: normalizeTimestamp(
                                detail?.timestamp,
                                detail?.created_at,
                                detail?.createdAt,
                                detail?.date,
                                mail?.timestamp,
                                mail?.created_at,
                                mail?.createdAt,
                                mail?.date,
                            ),
                            extraTexts: [
                                firstNonEmptyString(
                                    detail?.html_content,
                                    detail?.html,
                                    mail?.html_content,
                                    mail?.html,
                                ),
                            ],
                        };
                    }),
                );
                const matchedMail = findLatestVerificationMail(details, {
                    targetEmail: normalizeEmail(email),
                });
                if (matchedMail?.verificationCode) {
                    await deleteEmail(matchedMail.id);
                    console.log(`gptMailOtpCode: ${matchedMail.verificationCode}`);
                    return matchedMail.verificationCode;
                }

                if (attempt < GPTMAIL_POLL_ATTEMPTS) {
                    await new Promise((resolve) => setTimeout(resolve, GPTMAIL_POLL_INTERVAL_MS));
                }
            }

            throw new Error(`GPTMail 中未找到验证码: targetEmail=${email}`);
        },
    };
}
