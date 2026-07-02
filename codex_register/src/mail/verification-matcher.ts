export interface VerificationMailCandidate {
    id?: string;
    sender?: string;
    recipient?: string | string[];
    subject?: string;
    content?: string;
    timestamp?: number;
    extraTexts?: string[];
}

interface FindVerificationMailOptions<T> {
    targetEmail?: string;
    candidateMatcher?: (mail: T) => boolean;
    rememberLastCode?: boolean;
}

const lastVerificationCodeByEmail = new Map<string, string>();

export function normalizeMailbox(value: string): string {
    const input = String(value ?? "").trim().toLowerCase();
    const angleMatch = input.match(/<([^>]+)>/);
    return (angleMatch?.[1] ?? input).trim();
}

function normalizeTextForCodeMatching(text: string): string {
    return String(text ?? "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&#(\d+);/g, (_, codePoint) => String.fromCharCode(Number(codePoint)))
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeSixDigitCode(value: string | undefined): string {
    const digitsOnly = String(value ?? "").replace(/\D/g, "");
    return digitsOnly.length === 6 ? digitsOnly : "";
}

function extractVerificationCode(text: string): string {
    const raw = normalizeTextForCodeMatching(text);
    if (!raw) {
        return "";
    }

    const contextPatterns = [
        /\b((?:\d[\s-]*){6})\b(?=.{0,80}\b(?:is your|your|OpenAI|ChatGPT|verification|security|login|sign[-\s]?in|code|验证码)\b)/i,
        /\b(?:OpenAI|ChatGPT|verification|security|login|sign[-\s]?in|code|验证码)\b.{0,120}?\b((?:\d[\s-]*){6})\b/i,
        /\b((?:\d[\s-]*){6})\b.{0,80}?\b(?:OpenAI|ChatGPT|verification|security|login|sign[-\s]?in|code|验证码)\b/i,
    ];
    for (const pattern of contextPatterns) {
        const matched = raw.match(pattern);
        const code = normalizeSixDigitCode(matched?.[1]);
        if (code) {
            return code;
        }
    }

    const directMatch = raw.match(/\b(\d{6})\b/);
    if (directMatch?.[1]) {
        return directMatch[1];
    }

    return normalizeSixDigitCode(
        raw.match(/(?:^|[^\d])((?:\d[\s-]*){6})(?:[^\d]|$)/)?.[1],
    );
}

function normalizeRecipientList(recipient: string | string[] | undefined): string[] {
    if (Array.isArray(recipient)) {
        return recipient
            .map((item) => normalizeMailbox(item))
            .filter(Boolean);
    }
    const normalized = normalizeMailbox(recipient ?? "");
    return normalized ? [normalized] : [];
}

function collectCandidateTexts(mail: VerificationMailCandidate): string[] {
    const texts = [mail.subject ?? "", mail.content ?? "", ...(mail.extraTexts ?? [])];
    return texts
        .map((item) => String(item ?? "").trim())
        .filter(Boolean);
}

export function findLatestVerificationMail<T extends VerificationMailCandidate>(
    mails: T[],
    options: FindVerificationMailOptions<T> = {},
): (T & { verificationCode: string }) | null {
    const targetEmail = normalizeMailbox(options.targetEmail ?? "");
    const previousCode = targetEmail ? lastVerificationCodeByEmail.get(targetEmail) ?? "" : "";
    const sorted = [...mails].sort(
        (left, right) => Number(right.timestamp ?? 0) - Number(left.timestamp ?? 0),
    );

    for (const mail of sorted) {
        if (targetEmail) {
            const recipients = normalizeRecipientList(mail.recipient);
            if (recipients.length > 0 && !recipients.includes(targetEmail)) {
                continue;
            }
        }

        if (options.candidateMatcher && !options.candidateMatcher(mail)) {
            continue;
        }

        const verificationCode = collectCandidateTexts(mail)
            .map((text) => extractVerificationCode(text))
            .find(Boolean) ?? "";

        if (!verificationCode) {
            continue;
        }

        if (previousCode && verificationCode === previousCode) {
            continue;
        }

        const matchedMail = {
            ...mail,
            verificationCode,
        };
        if (targetEmail && options.rememberLastCode !== false) {
            lastVerificationCodeByEmail.set(targetEmail, verificationCode);
        }
        return matchedMail;
    }

    return null;
}
