import {createHash} from "node:crypto";

const CODE_PATTERN = /\b\d{6}\b/;

export interface MailboxSnapshot {
    hash: string;
    code: string;
    receivedAt: string;
}

export interface MailboxWaitOptions {
    baseline?: MailboxSnapshot | null;
    timeoutMs?: number;
    intervalMs?: number;
    allowBaselineCodeAfterMs?: number;
}

function asString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&#(\d+);/g, (_, codePoint) => String.fromCharCode(Number(codePoint)))
        .replace(/&#x([0-9a-f]+);/gi, (_, codePoint) => String.fromCharCode(parseInt(codePoint, 16)))
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'");
}

function normalizeTextForCodeMatching(value: string): string {
    return decodeHtmlEntities(String(value ?? ""))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeSixDigitCode(value: string | undefined): string {
    const digitsOnly = String(value ?? "").replace(/\D/g, "");
    return digitsOnly.length === 6 ? digitsOnly : "";
}

function findCodeInJson(value: unknown): string {
    if (Array.isArray(value)) {
        for (const item of value) {
            const code = findCodeInJson(item);
            if (code) return code;
        }
        return "";
    }

    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const entries = Object.entries(record);
        const findByKey = (keys: string[]) => {
            const wanted = new Set(keys.map((key) => key.toLowerCase()));
            for (const [key, child] of entries) {
                if (!wanted.has(key.toLowerCase())) continue;
                const code = findCodeInJson(child);
                if (code) return code;
            }
            return "";
        };

        for (const key of ["code", "otp", "verification_code", "verificationCode", "passcode"]) {
            const code = normalizeCode(record[key]);
            if (code) return code;
        }

        const textCode = findByKey(["body", "text", "html", "content", "message", "subject"]);
        if (textCode) return textCode;

        const metadataKeys = new Set(["date", "received_at", "receivedat", "created_at", "createdat", "time", "timestamp", "from", "to"]);
        for (const [key, child] of entries) {
            if (metadataKeys.has(key.toLowerCase())) continue;
            const code = findCodeInJson(child);
            if (code) return code;
        }
        return "";
    }

    if (typeof value === "string") {
        return normalizeCode(value);
    }
    return "";
}

function normalizeCode(value: unknown): string {
    const raw = asString(value);
    if (!raw) return "";

    const text = normalizeTextForCodeMatching(raw);
    const contextPatterns = [
        /\b(?:temporary\s+)?verification\s+code\b.{0,160}?\b((?:\d[\s-]*){6})\b/i,
        /\b(?:enter|use|your|OpenAI|ChatGPT|verification|security|login|sign[-\s]?in|code|验证码)\b.{0,160}?\b((?:\d[\s-]*){6})\b/i,
        /\b((?:\d[\s-]*){6})\b.{0,100}?\b(?:OpenAI|ChatGPT|verification|security|login|sign[-\s]?in|code|验证码)\b/i,
    ];
    for (const pattern of contextPatterns) {
        const match = text.match(pattern);
        const code = normalizeSixDigitCode(match?.[1]);
        if (code) return code;
    }

    const match = text.match(CODE_PATTERN);
    return match?.[0] ?? "";
}

function extractCode(raw: string): string {
    try {
        const parsed = JSON.parse(raw) as unknown;
        const code = findCodeInJson(parsed);
        if (code) return code;
    } catch {
        // Fallback to raw text parsing.
    }
    return normalizeCode(raw);
}

export function extractMailboxCodeFromRaw(raw: string): string {
    return extractCode(raw);
}

function findReceivedAtInJson(value: unknown): string {
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findReceivedAtInJson(item);
            if (found) return found;
        }
        return "";
    }
    if (!value || typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    for (const key of ["received_at", "receivedAt", "date", "created_at", "createdAt", "time", "timestamp"]) {
        const item = asString(record[key]);
        if (item) return item;
    }
    for (const child of Object.values(record)) {
        const found = findReceivedAtInJson(child);
        if (found) return found;
    }
    return "";
}

function detectDead(raw: string): string {
    const lower = raw.toLowerCase();
    try {
        const parsed = JSON.parse(raw) as unknown;
        const reason = detectDeadInJson(parsed);
        if (reason) return reason;
    } catch {
        // Keep raw-text detection below.
    }
    if (
        lower.includes("email_dead") ||
        lower.includes("mailbox dead") ||
        lower.includes("mail dead") ||
        lower.includes('"status":"dead"') ||
        lower.includes("'status':'dead'")
    ) {
        return raw.slice(0, 300);
    }
    return "";
}

function detectDeadInJson(value: unknown): string {
    if (Array.isArray(value)) {
        for (const item of value) {
            const reason = detectDeadInJson(item);
            if (reason) return reason;
        }
        return "";
    }
    if (!value || typeof value !== "object") {
        return typeof value === "string" && /email_dead|mailbox dead|mail dead/i.test(value) ? value : "";
    }
    const record = value as Record<string, unknown>;
    const status = asString(record.status).toLowerCase();
    const message = asString(record.message) || asString(record.error) || asString(record.reason);
    if (status === "dead" || /email_dead|mailbox dead|mail dead/i.test(message)) {
        return message || "mailbox dead";
    }
    for (const child of Object.values(record)) {
        const reason = detectDeadInJson(child);
        if (reason) return reason;
    }
    return "";
}

function snapshotFromRaw(raw: string): MailboxSnapshot {
    let receivedAt = "";
    try {
        receivedAt = findReceivedAtInJson(JSON.parse(raw) as unknown);
    } catch {
        // Raw text responses usually do not expose a stable received timestamp.
    }
    return {
        hash: createHash("sha256").update(raw).digest("hex"),
        code: extractCode(raw),
        receivedAt,
    };
}

function sameAsBaseline(current: MailboxSnapshot, baseline?: MailboxSnapshot | null): boolean {
    if (!baseline) return false;
    if (current.hash && baseline.hash && current.hash === baseline.hash) return true;
    if (current.code && baseline.code && current.code === baseline.code) {
        if (!current.receivedAt || !baseline.receivedAt) return true;
        return current.receivedAt === baseline.receivedAt;
    }
    return false;
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

export class MailboxUrlCodeProvider {
    readonly mailboxUrl: string;

    constructor(mailboxUrl: string) {
        this.mailboxUrl = mailboxUrl.trim();
        if (!this.mailboxUrl) {
            throw new Error("mailbox_url is empty");
        }
    }

    async fetchRaw(): Promise<string> {
        const response = await fetch(this.mailboxUrl, {
            method: "GET",
            headers: {
                Accept: "application/json,text/plain,*/*",
            },
        });
        const raw = await response.text();
        if (!response.ok) {
            throw new Error(`mailbox_url HTTP ${response.status}: ${raw.slice(0, 300)}`);
        }
        const dead = detectDead(raw);
        if (dead) {
            throw new Error(`mailbox dead: ${dead}`);
        }
        return raw;
    }

    async snapshot(): Promise<MailboxSnapshot> {
        return snapshotFromRaw(await this.fetchRaw());
    }

    async waitForCode(options: MailboxWaitOptions = {}): Promise<string> {
        const timeoutMs = Math.max(5000, Math.floor(options.timeoutMs ?? 120000));
        const intervalMs = Math.max(1000, Math.floor(options.intervalMs ?? 3000));
        const allowBaselineCodeAfterMs = Math.max(0, Math.floor(options.allowBaselineCodeAfterMs ?? 0));
        const startedAt = Date.now();
        let lastError = "";

        while (Date.now() - startedAt < timeoutMs) {
            try {
                const snapshot = await this.snapshot();
                if (snapshot.code) {
                    const isBaseline = sameAsBaseline(snapshot, options.baseline);
                    if (!isBaseline) {
                        return snapshot.code;
                    }
                    if (allowBaselineCodeAfterMs && Date.now() - startedAt >= allowBaselineCodeAfterMs) {
                        console.warn(
                            `[mailbox-url] still only sees baseline code after ${allowBaselineCodeAfterMs}ms; trying it as fallback`,
                        );
                        return snapshot.code;
                    }
                }
                lastError = snapshot.code ? "mailbox still returns baseline code" : "mailbox returned no code";
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
            }
            await sleep(intervalMs);
        }

        throw new Error(`mailbox code timeout: ${lastError || "no code"}`);
    }
}
