import {appendFile, mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import {appConfig} from "./config.js";
import {downloadAuthFile, listAuthFiles, requestCodexAuthUrl, submitOAuthCallback} from "./cpa-codex.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {MailboxUrlCodeProvider, type MailboxSnapshot} from "./mailbox-url.js";
import {OpenAIClient} from "./openai.js";
import {closeSentinelBrowser} from "./sentinel-browser.js";

interface EmailPoolEntry {
    email: string;
    mailboxUrl: string;
    raw: string;
}

interface CpaSettings {
    baseUrl: string;
    managementKey: string;
}

function readArgValue(flag: string): string {
    const index = process.argv.indexOf(flag);
    if (index === -1) return "";
    return process.argv[index + 1] ?? "";
}

function hasFlag(flag: string): boolean {
    return process.argv.includes(flag);
}

function normalizePhone(raw: string): string {
    const value = raw.trim();
    if (!value) return "";
    if (value.startsWith("+")) return value;
    return `+${value.replace(/[^\d]/g, "")}`;
}

function parseEmailPoolLine(line: string): EmailPoolEntry | null {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) return null;
    const parts = raw.split(/\s*-{4,}\s*|\t|,/).map((item) => item.trim()).filter(Boolean);
    const email = parts.find((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)) ?? "";
    const mailboxUrl = parts.find((item) => /^https?:\/\//i.test(item)) ?? "";
    if (!email) return null;
    return {email, mailboxUrl, raw};
}

async function loadEmailPool(filePath: string): Promise<EmailPoolEntry[]> {
    const raw = await readFile(filePath, "utf8").catch(() => "");
    return raw.split(/\r?\n/).map(parseEmailPoolLine).filter((item): item is EmailPoolEntry => Boolean(item));
}

async function consumeEmailPoolEntry(filePath: string, entry: EmailPoolEntry, reason: string): Promise<void> {
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    const index = lines.findIndex((line) => line.trim() === entry.raw);
    if (index >= 0) {
        lines.splice(index, 1);
        const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tmp, `${lines.filter((line) => line !== undefined).join("\n").replace(/\n+$/g, "")}\n`, "utf8");
        await rename(tmp, filePath);
    }
    const history = `${filePath}.history.txt`;
    await appendFile(history, `# consumed at ${new Date().toISOString()} reason=${reason}\n${entry.raw}\n`, "utf8")
        .catch(() => undefined);
}

async function recordEmailPoolHistory(filePath: string, entry: EmailPoolEntry, reason: string): Promise<void> {
    const history = `${filePath}.history.txt`;
    await appendFile(history, `# ${reason} at ${new Date().toISOString()}\n${entry.raw}\n`, "utf8")
        .catch(() => undefined);
}

function buildCpaSettings(): CpaSettings {
    const baseUrl = (
        readArgValue("--cpa-base")
        || process.env.CPA_BASE_URL
        || appConfig.cliproxyApiBaseUrl
        || ""
    ).trim().replace(/\/+$/, "");
    const managementKey = (
        readArgValue("--cpa-key")
        || process.env.CPA_MANAGEMENT_KEY
        || appConfig.cliproxyApiManagementKey
        || ""
    ).trim();
    if (!baseUrl) throw new Error("CPA 地址为空");
    if (!managementKey) throw new Error("CPA management key 为空");
    return {baseUrl, managementKey};
}

function getEmailPoolPath(): string {
    return path.resolve(
        readArgValue("--email-pool")
        || process.env.OA_EMAIL_POOL
        || path.resolve(process.cwd(), "..", "oa_email_pool.txt"),
    );
}

async function writeTempHotmailTokenFile(entry: EmailPoolEntry): Promise<string> {
    const filePath = path.resolve(process.cwd(), ".web-data", `hotmail-${process.pid}-${Date.now()}.txt`);
    await mkdir(path.dirname(filePath), {recursive: true});
    await writeFile(filePath, `${entry.raw}\n`, "utf8");
    return filePath;
}

async function appendTokenOut(filePath: string, token: string): Promise<void> {
    if (!filePath || !token) return;
    await mkdir(path.dirname(filePath), {recursive: true});
    const existing = await readFile(filePath, "utf8").catch(() => "");
    if (existing.includes(token)) {
        console.log(`[oa-cpa] token 已存在，跳过写入: ${filePath}`);
        return;
    }
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(filePath, `${prefix}${token}\n`, "utf8");
    console.log(`[oa-cpa] 已追加 access_token 到 ${filePath}`);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCpaAuthFile(
    baseUrl: string,
    managementKey: string,
    email: string,
): Promise<{fileName: string; accessToken: string; auth: Record<string, unknown>}> {
    const emailLc = email.toLowerCase();
    const candidates = [`codex-${emailLc}.json`, `codex-${emailLc}-plus.json`];
    const maxAttempts = 12;
    const intervalMs = 3000;
    let lastFileCount = -1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const files = await listAuthFiles(baseUrl, managementKey);
        lastFileCount = files.length;
        const hit = candidates
            .map((want) => files.find((file) => String(file.name || "").toLowerCase() === want))
            .find(Boolean);
        if (hit?.name) {
            console.log(`[oa-cpa] CPA 精确匹配 auth 文件: ${hit.name} (attempt=${attempt}, total=${files.length})`);
            const auth = await downloadAuthFile(baseUrl, managementKey, hit.name);
            const accessToken = String(auth?.access_token || "").trim();
            if (!accessToken) {
                throw new Error(`CPA auth 文件缺少 access_token: ${hit.name}`);
            }
            return {fileName: hit.name, accessToken, auth};
        }
        if (attempt < maxAttempts) {
            console.log(`[oa-cpa] 未看到 codex-${emailLc}(.json|-plus.json) (attempt=${attempt}/${maxAttempts}, total=${files.length})，${intervalMs}ms 后重试`);
            await delay(intervalMs);
        }
    }
    throw new Error(`CPA callback 已提交，但 ${maxAttempts * intervalMs}ms 内未找到 codex-${emailLc}(.json|-plus.json)；CPA 库内共 ${lastFileCount} 文件`);
}

async function main(): Promise<void> {
    const phone = normalizePhone(readArgValue("--phone"));
    if (!phone) throw new Error("缺少 --phone");
    const password = readArgValue("--password") || appConfig.defaultPassword;
    const cpa = buildCpaSettings();
    const emailPoolPath = getEmailPoolPath();
    const directEmail = readArgValue("--bind-email").trim();
    const directMailboxUrl = readArgValue("--mailbox-url").trim();
    const directEmailRaw = readArgValue("--email-raw").trim();
    let entry: EmailPoolEntry;
    let consumeFromPool = false;
    let consumeOnError = hasFlag("--consume-email-pool-on-error");
    if (directEmail || directMailboxUrl || directEmailRaw) {
        if (!directEmail || (!directMailboxUrl && !directEmailRaw)) {
            throw new Error("--bind-email 必须和 --mailbox-url 或 --email-raw 同时提供");
        }
        entry = {email: directEmail, mailboxUrl: directMailboxUrl, raw: directEmailRaw || `${directEmail}-----${directMailboxUrl}`};
        consumeFromPool = hasFlag("--consume-email-pool");
    } else {
        const entries = await loadEmailPool(emailPoolPath);
        if (!entries.length) {
            throw new Error(`邮箱池为空或格式无效: ${emailPoolPath}`);
        }
        entry = entries[0];
        consumeFromPool = true;
        consumeOnError = true;
    }

    console.log(`[oa-cpa] phone=${phone}`);
    console.log(`[oa-cpa] bind_email=${entry.email}`);
    if (entry.mailboxUrl) console.log(`[oa-cpa] mailbox_url=${entry.mailboxUrl}`);
    else console.log("[oa-cpa] mailbox=hotmail_refresh_token");

    let baseline: MailboxSnapshot | null = null;
    let hotmailProvider: {getEmailVerificationCode(email: string, options?: {minTimestampMs?: number}): Promise<string>} | null = null;
    if (entry.mailboxUrl) {
        const mailbox = new MailboxUrlCodeProvider(entry.mailboxUrl);
        try {
            baseline = await mailbox.snapshot();
            console.log(`[oa-cpa] mailbox baseline code=${baseline.code ? "yes" : "no"}`);
        } catch (error) {
            console.warn(`[oa-cpa] mailbox baseline 失败，继续等待新码: ${error instanceof Error ? error.message : String(error)}`);
        }
    } else {
        process.env.HOTMAIL_TOKENS_FILE = await writeTempHotmailTokenFile(entry);
        const {createHotmailProvider} = await import("./mail/hotmail.js");
        hotmailProvider = createHotmailProvider();
    }

    console.log("[oa-cpa] [1] CPA 生成 Codex OAuth URL");
    const prepared = await requestCodexAuthUrl(cpa.baseUrl, cpa.managementKey);
    console.log(`[oa-cpa]     oauth=${prepared.authorizeUrl.slice(0, 140)}...`);

    const fetchAddEmailOtp = async () => {
        console.log(`[oa-cpa] 等待绑定邮箱验证码 ${entry.email}`);
        const code = hotmailProvider
            ? await hotmailProvider.getEmailVerificationCode(entry.email, {minTimestampMs: Date.now() - 5000})
            : await new MailboxUrlCodeProvider(entry.mailboxUrl).waitForCode({
                baseline,
                timeoutMs: 120000,
                intervalMs: 3000,
            });
        console.log(`[oa-cpa] 收到邮箱验证码 ${code}`);
        return code;
    };

    const client = new OpenAIClient({
        email: phone,
        password,
        deviceProfile: generateRandomDeviceProfile(),
        manualMode: hasFlag("--otp"),
        bindEmail: entry.email,
        fetchAddEmailOtp,
    });

    console.log("[oa-cpa] [2] 手机号密码登录并绑定邮箱");
    let callbackUrl = "";
    try {
        callbackUrl = await client.authLoginViaCpaAuthorizeURL(prepared.authorizeUrl, "CPA");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/email_already_in_use/i.test(message)) {
            if (consumeFromPool || consumeOnError) {
                await consumeEmailPoolEntry(emailPoolPath, entry, "email_already_in_use");
            } else {
                await recordEmailPoolHistory(emailPoolPath, entry, "email_already_in_use");
            }
            console.warn("[oa-cpa] 邮箱已被占用，已从邮箱池移除");
        }
        throw error;
    }
    console.log(`[oa-cpa]     callback=${callbackUrl.slice(0, 140)}...`);

    console.log("[oa-cpa] [3] 提交 OAuth callback 给 CPA");
    const submitted = await submitOAuthCallback(cpa.baseUrl, cpa.managementKey, callbackUrl);
    console.log(`[oa-cpa]     CPA status=${submitted.status}`);
    console.log(`[oa-cpa]     CPA body=${submitted.body.slice(0, 500)}`);
    if (submitted.status >= 300) {
        throw new Error(`CPA oauth-callback 失败 status=${submitted.status}`);
    }

    console.log("[oa-cpa] [4] 等待 CPA auth 文件落库");
    const created = await waitForCpaAuthFile(cpa.baseUrl, cpa.managementKey, entry.email);
    console.log(`[oa-cpa] CPA 已入库账号: ${created.fileName}`);

    if (consumeFromPool) {
        await consumeEmailPoolEntry(emailPoolPath, entry, "oa-cpa-success");
        console.log(`[oa-cpa] 邮箱池已消费: ${entry.email}`);
    } else {
        await recordEmailPoolHistory(emailPoolPath, entry, "oa-cpa-success");
        console.log(`[oa-cpa] 邮箱已记录成功历史: ${entry.email}`);
    }

    const tokenOut = readArgValue("--token-out") || readArgValue("--gp-token-out");
    if (created.accessToken && tokenOut) {
        await appendTokenOut(path.resolve(tokenOut), created.accessToken);
    }
    console.log(`[access_token] ${created.accessToken}`);
    console.log(`[phone] ${phone}`);
    console.log(`[bind_email] ${entry.email}`);
    console.log(`[cpa_account] ${created.fileName}`);
}

main()
    .catch((error) => {
        console.error("[oa-cpa] 失败", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closeSentinelBrowser();
    });
