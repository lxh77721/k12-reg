import {appendFile, mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import {appConfig} from "./config.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {MailboxUrlCodeProvider, type MailboxSnapshot} from "./mailbox-url.js";
import {OpenAIClient} from "./openai.js";
import {closeSentinelBrowser} from "./sentinel-browser.js";
import {Sub2ApiClient, type Sub2ApiSettings} from "./sub2api.js";

interface EmailPoolEntry {
    email: string;
    mailboxUrl: string;
    raw: string;
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

function buildSub2ApiSettings(): Sub2ApiSettings {
    return {
        url: readArgValue("--sub2api-url") || process.env.SUB2API_URL || appConfig.sub2apiUrl,
        email: readArgValue("--sub2api-email") || process.env.SUB2API_EMAIL || appConfig.sub2apiEmail,
        password: readArgValue("--sub2api-password") || process.env.SUB2API_PASSWORD || appConfig.sub2apiPassword,
        groupName: readArgValue("--sub2api-group") || process.env.SUB2API_GROUP || appConfig.sub2apiGroupName,
        groupNames: appConfig.sub2apiGroupNames,
        proxyName: readArgValue("--sub2api-proxy") || process.env.SUB2API_PROXY || appConfig.sub2apiProxyName,
        accountPriority: Number(readArgValue("--sub2api-priority") || process.env.SUB2API_PRIORITY || appConfig.sub2apiAccountPriority),
        concurrency: Number(readArgValue("--sub2api-concurrency") || process.env.SUB2API_CONCURRENCY || appConfig.sub2apiConcurrency),
    };
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
        console.log(`[oa-sub2api] token 已存在，跳过写入: ${filePath}`);
        return;
    }
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(filePath, `${prefix}${token}\n`, "utf8");
    console.log(`[oa-sub2api] 已追加 access_token 到 ${filePath}`);
}

function buildSub2ApiAccountName(phone: string, email: string): string {
    return `${phone}---${email}`;
}

async function main(): Promise<void> {
    const phone = normalizePhone(readArgValue("--phone"));
    if (!phone) throw new Error("缺少 --phone");
    const password = readArgValue("--password") || appConfig.defaultPassword;
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
    console.log(`[oa-sub2api] phone=${phone}`);
    console.log(`[oa-sub2api] bind_email=${entry.email}`);
    if (entry.mailboxUrl) console.log(`[oa-sub2api] mailbox_url=${entry.mailboxUrl}`);
    else console.log("[oa-sub2api] mailbox=hotmail_refresh_token");

    let baseline: MailboxSnapshot | null = null;
    const mailboxProvider = entry.mailboxUrl ? new MailboxUrlCodeProvider(entry.mailboxUrl) : null;
    let hotmailProvider: {getEmailVerificationCode(email: string, options?: {minTimestampMs?: number}): Promise<string>} | null = null;
    if (mailboxProvider) {
        try {
            baseline = await mailboxProvider.snapshot();
            console.log(`[oa-sub2api] mailbox baseline code=${baseline.code ? "yes" : "no"}`);
        } catch (error) {
            console.warn(`[oa-sub2api] mailbox baseline 失败，继续等待新码: ${error instanceof Error ? error.message : String(error)}`);
        }
    } else {
        process.env.HOTMAIL_TOKENS_FILE = await writeTempHotmailTokenFile(entry);
        const {createHotmailProvider} = await import("./mail/hotmail.js");
        hotmailProvider = createHotmailProvider();
    }

    const refreshMailboxBaseline = async (label: string) => {
        if (!mailboxProvider) return;
        try {
            baseline = await mailboxProvider.snapshot();
            console.log(`[oa-sub2api] mailbox ${label} baseline code=${baseline.code ? "yes" : "no"}`);
        } catch (error) {
            console.warn(`[oa-sub2api] mailbox ${label} baseline 失败，继续等待新码: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const fetchEntryEmailOtp = async (label: string) => {
        console.log(`[oa-sub2api] 等待${label}验证码: ${entry.email}`);
        const code = hotmailProvider
            ? await hotmailProvider.getEmailVerificationCode(entry.email, {minTimestampMs: Date.now() - 5000})
            : await mailboxProvider!.waitForCode({
                baseline,
                timeoutMs: 120000,
                intervalMs: 3000,
                allowBaselineCodeAfterMs: 45000,
            });
        console.log(`[oa-sub2api] 收到${label}验证码: ${code}`);
        if (mailboxProvider) {
            await refreshMailboxBaseline(`${label}后`);
        }
        return code;
    };

    const sub2api = new Sub2ApiClient(buildSub2ApiSettings());
    console.log("[oa-sub2api] [1] SUB2API 生成 OpenAI OAuth URL");
    let prepared = await sub2api.prepareOpenAiOAuth();
    console.log(`[oa-sub2api]     group=${prepared.groupLabel}`);
    console.log(`[oa-sub2api]     oauth=${prepared.oauthUrl.slice(0, 140)}...`);

    const manualMode = hasFlag("--otp");
    const singleOAuth = hasFlag("--single-oauth");
    const allowSkipBindEmail = hasFlag("--allow-skip-bind-email");
    const requireChatgptAccountId = !hasFlag("--allow-missing-chatgpt-account-id");
    let callbackUrl = "";

    const runPhoneBindStage = async () => {
        const client = new OpenAIClient({
            email: phone,
            password,
            deviceProfile: generateRandomDeviceProfile(),
            manualMode,
            bindEmail: entry.email,
            fetchEmailOtp: () => fetchEntryEmailOtp("手机号登录邮箱"),
            fetchAddEmailOtp: () => fetchEntryEmailOtp("绑定邮箱"),
        });

        console.log("[oa-sub2api] [2] 手机号密码登录并绑定邮箱");
        try {
            const bindCallbackUrl = await client.authLoginViaCpaAuthorizeURL(prepared.oauthUrl, "SUB2API");
            console.log(`[oa-sub2api]     bind_callback=${bindCallbackUrl.slice(0, 140)}...`);
            if (client.lastAddEmailVerified) {
                console.log(`[oa-sub2api] 邮箱绑定已验证: ${client.lastAddEmailVerified}`);
            } else if (client.lastEmailOtpVerified) {
                console.log(`[oa-sub2api] 手机号登录已通过所选邮箱验证: ${client.lastEmailOtpVerified}`);
            } else {
                console.log(
                    `[oa-sub2api] 手机号 OAuth 未触发 add-email，已拿到 callback；` +
                    `按“手机号已绑定邮箱”处理，继续用所选邮箱二次 OA: ${entry.email}`,
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/email_already_in_use/i.test(message)) {
                if (consumeFromPool || consumeOnError) {
                    await consumeEmailPoolEntry(emailPoolPath, entry, "email_already_in_use");
                } else {
                    await recordEmailPoolHistory(emailPoolPath, entry, "email_already_in_use");
                }
                console.warn("[oa-sub2api] 邮箱已被占用，已从邮箱池移除");
            }
            throw error;
        }
    };

    if (singleOAuth) {
        const client = new OpenAIClient({
            email: phone,
            password,
            deviceProfile: generateRandomDeviceProfile(),
            manualMode,
            bindEmail: entry.email,
            fetchEmailOtp: () => fetchEntryEmailOtp("手机号登录邮箱"),
            fetchAddEmailOtp: () => fetchEntryEmailOtp("绑定邮箱"),
        });
        console.log("[oa-sub2api] [2] 单次 OAuth：手机号密码登录并绑定邮箱");
        callbackUrl = await client.authLoginViaCpaAuthorizeURL(prepared.oauthUrl, "SUB2API");
    } else {
        await runPhoneBindStage();

        await refreshMailboxBaseline("邮箱登录前");
        console.log("[oa-sub2api] [3] 重新生成 SUB2API OAuth URL，并使用邮箱登录");
        prepared = await sub2api.prepareOpenAiOAuth();
        console.log(`[oa-sub2api]     group=${prepared.groupLabel}`);
        console.log(`[oa-sub2api]     oauth=${prepared.oauthUrl.slice(0, 140)}...`);

        const emailClient = new OpenAIClient({
            email: entry.email,
            password,
            deviceProfile: generateRandomDeviceProfile(),
            manualMode,
            fetchEmailOtp: () => fetchEntryEmailOtp("邮箱登录"),
        });
        callbackUrl = await emailClient.authLoginViaCpaAuthorizeURL(prepared.oauthUrl, "SUB2API");
    }
    console.log(`[oa-sub2api]     callback=${callbackUrl.slice(0, 140)}...`);

    console.log("[oa-sub2api] [4] SUB2API exchange-code 并创建中转站账号");
    const accountName = buildSub2ApiAccountName(phone, entry.email);
    const created = await sub2api.exchangeCallbackAndCreateAccount(
        prepared,
        callbackUrl,
        entry.email,
        accountName,
        {requireChatgptAccountId},
    );
    console.log(`[oa-sub2api] [✅] SUB2API 已创建账号: ${created.accountName}`);
    console.log(`[oa-sub2api]     result=${JSON.stringify(created.account).slice(0, 500)}`);

    if (consumeFromPool) {
        await consumeEmailPoolEntry(emailPoolPath, entry, "oa-sub2api-success");
        console.log(`[oa-sub2api] 邮箱池已消费: ${entry.email}`);
    } else {
        await recordEmailPoolHistory(emailPoolPath, entry, "oa-sub2api-success");
        console.log(`[oa-sub2api] 邮箱已记录成功历史: ${entry.email}`);
    }

    const accessToken = String(created.credentials.access_token ?? "");
    const tokenOut = readArgValue("--token-out") || readArgValue("--gp-token-out");
    if (accessToken && tokenOut) {
        await appendTokenOut(path.resolve(tokenOut), accessToken);
    }
    console.log(`[access_token] ${accessToken}`);
    console.log(`[phone] ${phone}`);
    console.log(`[bind_email] ${entry.email}`);
    console.log(`[sub2api_account] ${created.accountName}`);
}

main()
    .catch((error) => {
        console.error("[oa-sub2api] 失败", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closeSentinelBrowser();
    });
