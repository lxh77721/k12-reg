import {appConfig} from "./config.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {MAILBOX_CONFIG} from "./mailbox.js";
import {MailboxUrlCodeProvider, type MailboxSnapshot} from "./mailbox-url.js";
import {OpenAIClient} from "./openai.js";
import {closeSentinelBrowser} from "./sentinel-browser.js";
import type {ISMSActivationBroker} from "./sms/activation-broker.js";
import {createSMSBroker} from "./sms/index.js";

function readArgValue(flag: string): string {
    const index = process.argv.indexOf(flag);
    if (index === -1) {
        return "";
    }
    return process.argv[index + 1] ?? "";
}

function hasFlag(flag: string): boolean {
    return process.argv.includes(flag);
}

function readNumberArg(flag: string): number | null {
    const raw = readArgValue(flag).trim();
    if (!raw) {
        return null;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
}

async function writeTempHotmailTokenFile(raw: string): Promise<string> {
    const {mkdir, writeFile} = await import("node:fs/promises");
    const path = await import("node:path");
    const filePath = path.resolve(process.cwd(), ".web-data", `register-hotmail-${process.pid}-${Date.now()}.txt`);
    await mkdir(path.dirname(filePath), {recursive: true});
    await writeFile(filePath, `${raw.trim()}\n`, "utf8");
    return filePath;
}

type RejectedPhoneRecord = {
    phone: string;
    reason: string;
    cancelStatus?: string;
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isPhoneAlreadyRegisteredError(message: string): boolean {
    return message.toUpperCase().includes("PHONE_ALREADY_REGISTERED");
}

function isNoNumbersError(message: string): boolean {
    const upper = message.toUpperCase();
    return upper.includes("NO_NUMBERS") || upper.includes("NO_NUMBER");
}

function compactPhoneFailureReason(message: string): string {
    if (isPhoneAlreadyRegisteredError(message)) return "PHONE_ALREADY_REGISTERED";
    return message.replace(/\s+/g, " ").slice(0, 160);
}

function formatPhoneList(records: RejectedPhoneRecord[]): string {
    return records.map((record) => record.phone).join(", ");
}

function buildPhoneSignupFailureMessage(
    label: string,
    rejectedPhones: RejectedPhoneRecord[],
    finalError: unknown,
): string {
    const finalMessage = errorMessage(finalError).replace(/\s+/g, " ").trim();
    if (!rejectedPhones.length) {
        return finalMessage || `${label} 多次换号均失败`;
    }

    const phones = formatPhoneList(rejectedPhones);
    const cancelSummary = rejectedPhones
        .map((record) => `${record.phone}:${record.cancelStatus ?? "cancel-unknown"}`)
        .join(", ");
    const prefix = `${label} 失败：前面号码已被 OpenAI 判定已注册/black（${phones}），已执行取消并换号`;
    if (isNoNumbersError(finalMessage)) {
        return `${prefix}；后续重新取号时接码平台无号：${finalMessage}；取消状态：${cancelSummary}`;
    }
    return `${prefix}；最后错误：${finalMessage || "unknown"}；取消状态：${cancelSummary}`;
}

async function cancelPhoneActivationForRotate(
    broker: ISMSActivationBroker,
    label: string,
    phoneNumber: string,
): Promise<string> {
    try {
        await broker.markAsFailed(true);
        console.warn(`[${label}] 已取消/退回号码 ${phoneNumber}，准备换号`);
        return "canceled";
    } catch (markError) {
        const markMessage = errorMessage(markError);
        try {
            const result = await broker.cancelCurrentActivation();
            console.warn(`[${label}] 已取消/退回号码 ${phoneNumber}，准备换号 result=${result}`);
            return `canceled:${result}`;
        } catch (cancelError) {
            const cancelMessage = errorMessage(cancelError);
            console.warn(`[${label}] 取消/退回号码 ${phoneNumber} 失败: mark=${markMessage}; cancel=${cancelMessage}`);
            return `cancel-failed:${cancelMessage}`;
        }
    }
}


const smsBroker = appConfig.smsProvider === "smsbower"
    ? (appConfig.smsbowerApiKey ? createSMSBroker({
        provider: "smsbower",
        apiKey: appConfig.smsbowerApiKey,
        baseUrl: appConfig.smsbowerBaseUrl,
        service: appConfig.smsbowerService,
        pollAttempts: appConfig.smsbowerPollAttempts,
        pollIntervalMs: appConfig.smsbowerPollIntervalMs,
        maxPrice: appConfig.smsbowerMaxPrice,
        country: appConfig.smsbowerCountry,
        countries: appConfig.smsbowerCountries,
        priceTiers: appConfig.smsbowerMaxPriceTiers,
        requestRetryAttempts: appConfig.smsbowerRequestRetryAttempts,
        requestRetryIntervalMs: appConfig.smsbowerRequestRetryIntervalMs,
        providerIds: appConfig.smsbowerPricePoolIds ?? appConfig.smsbowerPriceTiers ?? appConfig.smsbowerProviderIds,
        exceptProviderIds: appConfig.smsbowerExceptProviderIds,
        phoneException: appConfig.smsbowerPhoneException,
    }) : undefined)
    : (appConfig.heroSMSApiKey ? createSMSBroker({
        provider: "hero-sms",
        apiKey: appConfig.heroSMSApiKey,
        baseUrl: appConfig.heroSMSBaseUrl,
        service: appConfig.heroSMSService,
        pollAttempts: appConfig.heroSMSPollAttempts,
        pollIntervalMs: appConfig.heroSMSPollIntervalMs,
        maxPrice: appConfig.heroSMSMaxPrice,
        country: appConfig.heroSMSCountry,
        countries: appConfig.heroSMSCountries,
        priceTiers: appConfig.heroSMSPriceTiers,
    }) : undefined)

async function runOnce(): Promise<void> {
    const email = readArgValue("--email").trim();
    const manualOtp = hasFlag("--otp");
    const directSignupAuth = hasFlag("--sign");
    const saveAccessToken = hasFlag("--at");
    const phoneFirst = hasFlag("--phone");
    const codexCpa = hasFlag("--codex-cpa");
    const gpTokenOutPath = readArgValue("--gp-token-out").trim();
    const deviceProfile = generateRandomDeviceProfile();

    // ─── 模式 -1: --codex-cpa --phone +xxx (codex CLI OAuth → CPA 入库) ───
    // 用 CPA 持有的 PKCE 完成 OAuth：
    //   1) GET CPA /v0/management/codex-auth-url 拿 authorize URL
    //   2) 走 OAuth 登录（password verify + add-email）
    //   3) 拿到 localhost:1455/auth/callback?code=...
    //   4) POST CPA /v0/management/oauth-callback 由 CPA 完成 token 交换并入库
    if (codexCpa) {
        const phoneArg = readArgValue("--phone").trim();
        const password = readArgValue("--password").trim() || appConfig.defaultPassword;
        const cpaBase = readArgValue("--cpa-base").trim() || process.env.CPA_BASE_URL?.trim() || appConfig.cliproxyApiBaseUrl || "https://YOUR_CPA_URL";
        const cpaKey = readArgValue("--cpa-key").trim() || process.env.CPA_MANAGEMENT_KEY?.trim() || appConfig.cliproxyApiManagementKey || "";
        if (!cpaKey) {
            throw new Error("--codex-cpa 需要 --cpa-key 或 CPA_MANAGEMENT_KEY 环境变量");
        }

        // add-email 候选邮箱（hotmail 卡密）
        let bindEmail = readArgValue("--bind-email").trim();
        let fetchAddEmailOtp: (() => Promise<string>) | undefined = undefined;
        let hotmailPrepError = "";
        try {
            const {createHotmailProvider} = await import("./mail/hotmail.js");
            const hotmailProvider = createHotmailProvider();
            if (!bindEmail) {
                bindEmail = await hotmailProvider.getEmailAddress();
            }
            console.log(`[codex-cpa] add-email 候选: ${bindEmail}`);
            fetchAddEmailOtp = async () => {
                const startedAt = Date.now();
                console.log(`[codex-cpa] 等待 IMAP 邮件 OTP for ${bindEmail} (after=${new Date(startedAt).toISOString()})...`);
                return await (hotmailProvider as any).getEmailVerificationCode(bindEmail, {minTimestampMs: startedAt});
            };
        } catch (e) {
            hotmailPrepError = (e as Error).message;
            console.warn(`[codex-cpa] hotmail 邮箱准备失败: ${hotmailPrepError}`);
        }

        // 前置校验：OAuth 很可能跳到 /add-email（phone-only 账号必然触发）。
        // 此时需要 bindEmail + fetchAddEmailOtp，否则会在 5 步之后才以
        // "OAuth 跳到 /add-email 但未提供 bindEmail" 报错，掩盖真实原因。
        // 这里直接 fail-fast，给出可操作的提示。
        if (!bindEmail) {
            throw new Error(
                `缺少 add-email 绑定邮箱：请用 --bind-email 指定，或配置可用的 hotmail 卡密池` +
                `（hotmail/tokens.txt 或 HOTMAIL_TOKENS_FILE 指向的文件）。` +
                (hotmailPrepError ? ` hotmail 准备失败原因: ${hotmailPrepError}` : ``)
            );
        }
        if (!fetchAddEmailOtp) {
            throw new Error(
                `已有 bindEmail=${bindEmail} 但无法接收 add-email OTP：hotmail provider 初始化失败` +
                (hotmailPrepError ? `（${hotmailPrepError}）` : ``) +
                `。请检查 hotmail 卡密池配置。`
            );
        }

        // 如果没传 phone，就自动 phone signup（当前 SMS provider 取号注册新账号）
        let phone = "";
        let chatgptAccessToken = "";
        let signupClientRef: OpenAIClient | null = null;
        if (phoneArg) {
            phone = phoneArg.startsWith("+") ? phoneArg : `+${phoneArg}`;
            console.log(`[codex-cpa] 复用已注册号 ${phone}`);
        } else {
            if (!smsBroker) {
                throw new Error(`--codex-cpa 不传 --phone 时需要配置 smsProvider=${appConfig.smsProvider} 对应的 apiKey`);
            }
            console.log(`[codex-cpa] [0] 未传 --phone，自动 phone signup 注册新号`);
            const MAX_PHONE_TRIES = 8;
            let lastErr: unknown = null;
            const rejectedPhones: RejectedPhoneRecord[] = [];
            for (let phoneTry = 1; phoneTry <= MAX_PHONE_TRIES; phoneTry += 1) {
                // 每次 retry 都重建 signupClient（独立 cookie jar + 新 deviceProfile），
                // 否则上次失败留下的 cookie 会污染状态机，触发 invalid_auth_step。
                const signupClient = new OpenAIClient({
                    email: undefined,
                    password,
                    deviceProfile: generateRandomDeviceProfile(),
                    manualMode: manualOtp,
                    smsBroker,
                });
                console.log(`\n[codex-cpa] (${phoneTry}/${MAX_PHONE_TRIES}) ${appConfig.smsProvider} 取号...`);
                let lease;
                try {
                    lease = await smsBroker.getActivation();
                } catch (e) {
                    lastErr = e;
                    if (rejectedPhones.length) {
                        const message = buildPhoneSignupFailureMessage("codex-cpa phone signup", rejectedPhones, e);
                        console.error(`[codex-cpa] final-error: ${message}`);
                        throw new Error(message);
                    }
                    throw e;
                }
                const phoneNumber = `+${lease.phoneNumber}`;
                console.log(`[codex-cpa] 取到 ${phoneNumber}`);
                try {
                    const sigRes = await signupClient.authPhoneSignupHTTP(phoneNumber, async () => {
                        console.log(`[codex-cpa] 等待 OTP (45s 超时换号)...`);
                        const {code} = await lease.waitForVerificationCode();
                        console.log(`[codex-cpa] 收到 OTP: ${code}`);
                        return code;
                    });
                    phone = phoneNumber;
                    signupClientRef = signupClient;
                    console.log(`[codex-cpa] [✅️phone signup 成功] ${phone}`);
                    // 试用探测移到 OAuth 完成后做（用 CPA 入库后的 access_token）
                    void sigRes; // 暂不消费 callbackURL
                    break;
                } catch (e) {
                    lastErr = e;
                    const msg = errorMessage(e);
                    console.warn(`[codex-cpa] (${phoneTry}/${MAX_PHONE_TRIES}) 失败: ${msg}`);
                    const cancelStatus = await cancelPhoneActivationForRotate(smsBroker, "codex-cpa", phoneNumber);
                    if (isPhoneAlreadyRegisteredError(msg)) {
                        const reason = compactPhoneFailureReason(msg);
                        rejectedPhones.push({phone: phoneNumber, reason, cancelStatus});
                        console.warn(`[codex-cpa] black phone=${phoneNumber} reason=${reason} cancel=${cancelStatus}; rotating`);
                    } else {
                        console.warn(`[codex-cpa] rotate phone=${phoneNumber} reason=${compactPhoneFailureReason(msg)} cancel=${cancelStatus}`);
                    }
                    continue;
                }
            }
            if (!phone) {
                const message = buildPhoneSignupFailureMessage(
                    "codex-cpa phone signup",
                    rejectedPhones,
                    lastErr ?? new Error("phone signup 多次换号均失败"),
                );
                console.error(`[codex-cpa] final-error: ${message}`);
                throw new Error(message);
            }
        }

        const {requestCodexAuthUrl, submitOAuthCallback, listAuthFiles, downloadAuthFile} = await import("./cpa-codex.js");

        console.log(`[codex-cpa] [1] CPA codex-auth-url`);
        const {authorizeUrl} = await requestCodexAuthUrl(cpaBase, cpaKey);
        console.log(`[codex-cpa]     authorize: ${authorizeUrl.slice(0, 120)}...`);

        const client = new OpenAIClient({
            email: phone,
            password,
            deviceProfile: generateRandomDeviceProfile(),
            manualMode: manualOtp,
            smsBroker,
            bindEmail,
            fetchAddEmailOtp,
        });

        console.log(`[codex-cpa] [2] 走 OAuth 登录 phone=${phone}`);
        let callbackUrl: string;
        try {
            callbackUrl = await client.authLoginViaCpaAuthorizeURL(authorizeUrl);
        } catch (e) {
            const msg = (e as Error)?.message || String(e);
            // 邮箱已被占用 = 该 hotmail 卡密已永久绑死另一个 ChatGPT 账号(race condition 残留),
            // 立即从池里消费掉,避免下次再被随机选到
            if (msg.includes("email_already_in_use") && bindEmail) {
                console.warn(`[codex-cpa] [⚠️] hotmail 卡密 ${bindEmail} 已绑死另一账号,立即消费`);
                try {
                    const {consumeHotmailLine} = await import("./consume-hotmail.js");
                    const cr = consumeHotmailLine(bindEmail);
                    console.log(`[codex-cpa] [hotmail 卡密消费] ${cr.reason}`);
                } catch (consumeErr) {
                    console.warn(`[codex-cpa] [hotmail 卡密消费失败] ${(consumeErr as Error).message}`);
                }
            }
            throw e;
        }
        console.log(`[codex-cpa]     callback: ${callbackUrl.slice(0, 120)}...`);

        console.log(`[codex-cpa] [3] 提交 callback 给 CPA`);
        const {status, body} = await submitOAuthCallback(cpaBase, cpaKey, callbackUrl);
        console.log(`[codex-cpa]     CPA status=${status}`);
        console.log(`[codex-cpa]     CPA body: ${body.slice(0, 500)}`);
        if (status >= 300) {
            throw new Error(`CPA oauth-callback 失败 status=${status}`);
        }

        // 如果之前还没拿到 ChatGPT accessToken，从 CPA 拉刚入库的 codex auth.json 取 access_token
        if (!chatgptAccessToken) {
            try {
                console.log(`[codex-cpa] 从 CPA 拉刚入库的 codex auth 文件...`);
                if (!bindEmail) {
                    throw new Error("没有 bindEmail，无法精确定位 codex auth 文件（拒绝并发场景下的兜底匹配）");
                }
                const emailLc = bindEmail.toLowerCase();
                // CPA 实际命名有两种：codex-<email>.json 与 codex-<email>-plus.json（plus 套餐）
                // 两者都精确匹配本 email，绝不退化到"最新文件"（避免并发拿到别 worker 的 token）
                const candidates = [
                    `codex-${emailLc}.json`,
                    `codex-${emailLc}-plus.json`,
                ];
                const matchFile = (files: any[]) => {
                    // 优先无后缀，其次 -plus
                    for (const want of candidates) {
                        const hit = files.find(f => String(f.name || "").toLowerCase() === want);
                        if (hit) return hit;
                    }
                    return null;
                };
                // CPA 落库可能有延迟（callback 返回 ok 后服务端异步写文件），放宽到 ~36s
                const POLL_MAX_ATTEMPTS = 12;
                const POLL_INTERVAL_MS = 3000;
                let latest: any = null;
                let lastFileCount = -1;
                for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt += 1) {
                    const files = await listAuthFiles(cpaBase, cpaKey);
                    lastFileCount = files.length;
                    latest = matchFile(files);
                    if (latest) {
                        console.log(`[codex-cpa]     精确匹配文件: ${latest.name} (attempt=${attempt}, 库内共 ${files.length} 文件)`);
                        break;
                    }
                    if (attempt < POLL_MAX_ATTEMPTS) {
                        console.log(`[codex-cpa]     还没看到 codex-${emailLc}(.json|-plus.json) (attempt=${attempt}/${POLL_MAX_ATTEMPTS}, 库内共 ${files.length} 文件)，${POLL_INTERVAL_MS}ms 后重试`);
                        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                    }
                }
                if (!latest) {
                    throw new Error(
                        `等了 ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS}ms 仍找不到 codex-${emailLc}(.json|-plus.json)`
                        + `（CPA 库内共 ${lastFileCount} 文件）—— callback 返回 ok 但未落库，疑似 CPA 端入库失败/延迟。`
                        + `拒绝兜底，避免拿到别 worker 的 token`
                    );
                }
                const auth = await downloadAuthFile(cpaBase, cpaKey, latest.name);
                const tok = String(auth?.access_token || "").trim();
                if (!tok) {
                    throw new Error(`auth 文件里没 access_token: ${JSON.stringify(auth).slice(0, 200)}`);
                }
                chatgptAccessToken = tok;
                console.log(`[codex-cpa] [✅️] 从 CPA 拿到 access_token (${tok.length} 字符, 文件=${latest.name})`);
            } catch (e) {
                console.warn(`[codex-cpa] 从 CPA 取 access_token 失败: ${(e as Error).message}`);
            }
        }

        // 把 ChatGPT accessToken 写到指定的 token 文件
        if (chatgptAccessToken) {
            // ─── 试用探测（在写 token / 消费 hotmail 卡密 之前）───
            // 用 JP 代理打 chatgpt checkout + stripe init 看 amount_due。
            // 无试用 → exit 2：CPA 入库无法回滚（已发生），但不写 token、不消费 hotmail。
            // hotmail 卡密留着下次还能用（refresh_token 已被 hotmail provider 自动续）。
            const probeJP = readArgValue("--probe-trial-jp").trim() || process.env.PROBE_TRIAL_JP_PROXY?.trim() || "";
            if (probeJP) {
                try {
                    const {probeTrial} = await import("./probe-trial.js");
                    console.log(`[codex-cpa] [试用探测] 用 JP 代理打 chatgpt checkout + stripe init`);
                    const probeRes = await probeTrial({
                        accessToken: chatgptAccessToken,
                        proxyJP: probeJP,
                    });
                    if (probeRes.hasTrial) {
                        console.log(`[codex-cpa] [✅️有试用] ${probeRes.reason}`);
                    } else {
                        console.warn(`[codex-cpa] [❌️无试用] ${probeRes.reason}`);
                        console.warn(`[codex-cpa] 不写 token 文件，立即退出（CPA 入库已发生但不可回滚；hotmail 卡密已绑该账号必须消费）`);
                        // hotmail 已经绑给这个 ChatGPT 账号 = 卡密已脏，必须消费再退出
                        if (bindEmail) {
                            try {
                                const {consumeHotmailLine} = await import("./consume-hotmail.js");
                                const cr = consumeHotmailLine(bindEmail);
                                if (cr.ok) {
                                    console.log(`[codex-cpa] [hotmail 卡密消费] ${cr.reason}`);
                                } else {
                                    console.warn(`[codex-cpa] [hotmail 卡密消费跳过] ${cr.reason}`);
                                }
                            } catch (e) {
                                console.warn(`[codex-cpa] [hotmail 卡密消费失败，忽略] ${(e as Error).message}`);
                            }
                        }
                        console.log(`[POOL-RESULT] status=no_trial phone=${phone || ""} email=${bindEmail || ""}`);
                        process.exit(2);
                    }
                } catch (probeErr) {
                    console.warn(`[codex-cpa] [试用探测失败，继续主流程] ${(probeErr as Error).message}`);
                }
            } else {
                console.log(`[codex-cpa] [跳过试用探测] 未配置 --probe-trial-jp / PROBE_TRIAL_JP_PROXY`);
            }

            const gpTokenFile = gpTokenOutPath || readArgValue("--token-out").trim();
            if (!gpTokenFile) {
                console.warn(`[codex-cpa] 未指定 --token-out / --gp-token-out，跳过写 token 文件`);
            } else {
                try {
                    const {appendFile, mkdir, readFile, writeFile} = await import("node:fs/promises");
                    const {dirname} = await import("node:path");
                    await mkdir(dirname(gpTokenFile), {recursive: true});
                    // 追加模式：每个 token 一行
                    let existing = "";
                    try {
                        existing = await readFile(gpTokenFile, "utf8");
                    } catch {
                        // 文件不存在
                    }
                    // 去重：如果该 token 已在文件里就不重复写
                    if (existing.includes(chatgptAccessToken)) {
                        console.log(`[codex-cpa] [⏭️] token 已在 ${gpTokenFile} 里，跳过写入`);
                    } else {
                        // 保证文件以换行结尾再 append
                        const needNewline = existing.length > 0 && !existing.endsWith("\n");
                        if (needNewline) {
                            await writeFile(gpTokenFile, existing + "\n", "utf8");
                        }
                        await appendFile(gpTokenFile, chatgptAccessToken + "\n", "utf8");
                        console.log(`[codex-cpa] [✅️] 追加 token 到: ${gpTokenFile}`);
                    }
                } catch (e) {
                    console.warn(`[codex-cpa] 写 token 文件失败: ${(e as Error).message}`);
                }
            }
        } else {
            console.warn(`[codex-cpa] ⚠️ 没拿到 ChatGPT accessToken，GP Plus 订阅会失败`);
            // 让外层 batch_runner 立刻把这单标失败，避免下游 full_auto_stable 拿到空 token
            // 又写一份 stable_account 占用 CDK 池
            process.exit(1);
        }

        console.log(`\n[✅️codex-cpa 成功] phone=${phone} email=${bindEmail || "(none)"} 已入 CPA token 池`);
        console.log(`[POOL-RESULT] status=ok phone=${phone} email=${bindEmail || ""}`);

        // 注册成功 → 把用过的 hotmail 卡密从池文件移除，append 到 history
        if (bindEmail) {
            try {
                // 等 hotmail provider 的 IMAP refresh-token 持久化先跑完，避免 race condition
                // （IMAP 收 OTP 时可能触发 refresh，然后 persistTextAccount 写回老内容覆盖我们的删除）
                await new Promise(r => setTimeout(r, 1500));
                const {consumeHotmailLine} = await import("./consume-hotmail.js");
                const cr = consumeHotmailLine(bindEmail);
                if (cr.ok) {
                    console.log(`[codex-cpa] [hotmail 卡密消费] ${cr.reason}`);
                } else {
                    console.warn(`[codex-cpa] [hotmail 卡密消费跳过] ${cr.reason}`);
                }
            } catch (e) {
                console.warn(`[codex-cpa] [hotmail 卡密消费失败，忽略] ${(e as Error).message}`);
            }
        }

        // 启动 GP Plus 订阅链路（稳定号方案：full_auto_stable.py）
        // 默认假设项目结构是 <PROJECT_ROOT>/codex_register/ 和 <PROJECT_ROOT>/plus_subscriber/
        // 可通过 --gp-script + --gp-cwd 覆盖
        if (chatgptAccessToken && hasFlag("--gp-plus")) {
            console.log(`\n========== 启动 GP Plus 订阅（稳定号方案）==========`);
            const {spawn} = await import("node:child_process");
            const {basename, dirname, resolve: resolvePath} = await import("node:path");
            const cwd = process.cwd();
            const projectRoot = basename(cwd) === "codex_register" && basename(dirname(cwd)) === "codexrigester"
                ? resolvePath(cwd, "..", "..")
                : resolvePath(cwd, "..");
            const gpScript = readArgValue("--gp-script").trim()
                || resolvePath(projectRoot, "plus_subscriber", "full_auto_stable.py");
            const gpCwd = readArgValue("--gp-cwd").trim()
                || resolvePath(projectRoot, "plus_subscriber");
            const gpTokenArg = readArgValue("--token-out").trim() || gpTokenOutPath || "token.txt";
            const child = spawn("python", ["-u", gpScript, "--token-file", gpTokenArg], {
                cwd: gpCwd,
                stdio: "inherit",
                shell: false,
            });
            await new Promise<void>((resolve) => {
                child.on("exit", (code) => {
                    console.log(`[gp-plus] python 退出 code=${code}`);
                    resolve();
                });
                child.on("error", (e) => {
                    console.error(`[gp-plus] 启动失败: ${e.message}`);
                    resolve();
                });
            });
        }
        return;
    }

    // ─── 模式 0: --phone (phone-first signup, 走 chatgpt.com web 入口) ───
    // 不需要邮箱，直接用当前 SMS provider 取号注册 → 拿 ChatGPT plan accessToken
    if (phoneFirst) {
        if (!smsBroker) {
            throw new Error(`使用 --phone 需要配置 smsProvider=${appConfig.smsProvider} 对应的 apiKey`);
        }
        const callbackOutPath = readArgValue("--callback-out").trim();
        const client = new OpenAIClient({
            email: undefined,
            password: appConfig.defaultPassword,
            deviceProfile,
            manualMode: manualOtp,
            smsBroker,
        });

        let result: {callbackURL: string} | null = null;
        let registeredPhone = "";

        // 复用已注册号：--phone-existing +57xxx 跳过 signup 步骤
        const existingPhone = readArgValue("--phone-existing").trim();
        if (existingPhone) {
            registeredPhone = existingPhone.startsWith("+") ? existingPhone : `+${existingPhone}`;
            console.log(`[phone-signup] 复用已注册号 ${registeredPhone}，跳过 signup 步骤直接登录`);
            result = {callbackURL: ""};
        } else {
            // 从当前 SMS provider 取号（用阶梯 priceTiers, service=dr），最多换号 8 次
            const MAX_PHONE_TRIES = 8;
            let lastErr: unknown = null;
            const rejectedPhones: RejectedPhoneRecord[] = [];

            for (let phoneTry = 1; phoneTry <= MAX_PHONE_TRIES; phoneTry += 1) {
                console.log(`\n[phone-signup] (${phoneTry}/${MAX_PHONE_TRIES}) 取号...`);
                let lease;
                try {
                    lease = await smsBroker.getActivation();
                } catch (e) {
                    lastErr = e;
                    if (rejectedPhones.length) {
                        const message = buildPhoneSignupFailureMessage("phone-signup", rejectedPhones, e);
                        console.error(`[phone-signup] final-error: ${message}`);
                        throw new Error(message);
                    }
                    throw e;
                }
                const phoneNumber = `+${lease.phoneNumber}`;
                console.log(`[phone-signup] 取到号码 ${phoneNumber}`);

                try {
                    result = await client.authPhoneSignupHTTP(phoneNumber, async () => {
                        console.log(`[phone-signup] 等待 OTP (45s 超时换号)...`);
                        const {code} = await lease.waitForVerificationCode();
                        console.log(`[phone-signup] 收到 OTP: ${code}`);
                        return code;
                    });
                    if (result) {
                        registeredPhone = phoneNumber;
                        break;
                    }
                } catch (e) {
                    lastErr = e;
                    const msg = errorMessage(e);
                    console.warn(`[phone-signup] (${phoneTry}/${MAX_PHONE_TRIES}) 失败: ${msg}`);
                    const cancelStatus = await cancelPhoneActivationForRotate(smsBroker, "phone-signup", phoneNumber);
                    if (isPhoneAlreadyRegisteredError(msg)) {
                        const reason = compactPhoneFailureReason(msg);
                        rejectedPhones.push({phone: phoneNumber, reason, cancelStatus});
                        console.warn(`[phone-signup] black phone=${phoneNumber} reason=${reason} cancel=${cancelStatus}; rotating`);
                    } else {
                        console.warn(`[phone-signup] rotate phone=${phoneNumber} reason=${compactPhoneFailureReason(msg)} cancel=${cancelStatus}`);
                    }
                    continue;
                }
            }
            if (!result || !registeredPhone) {
                const message = buildPhoneSignupFailureMessage(
                    "phone-signup",
                    rejectedPhones,
                    lastErr ?? new Error("phone-signup 多次换号均失败"),
                );
                console.error(`[phone-signup] final-error: ${message}`);
                throw new Error(message);
            }
        }

        console.log(`[✅️phone 注册成功] callbackURL=${result.callbackURL.slice(0, 80)}...`);

        // 如果指定了 --callback-out，把完整 callback URL 输出到文件，
        // 由 Python 端用 curl_cffi 完成回调拿 ChatGPT plan token（绕过 Cloudflare）
        if (callbackOutPath && result.callbackURL) {
            const {writeFile} = await import("node:fs/promises");
            const phoneInfo = registeredPhone || existingPhone || "";
            const payload = {
                callback_url: result.callbackURL,
                phone: phoneInfo,
                password: appConfig.defaultPassword,
                ts: Date.now(),
            };
            await writeFile(callbackOutPath, JSON.stringify(payload, null, 2), "utf8");
            console.log(`[callback_out] 已写入 ${callbackOutPath}`);
            console.log(`[提示] 现在用 Python 端的 finish_chatgpt_callback.py 完成 callback 拿 token`);
            return;
        }

        // 注意：result.callbackURL 是 chatgpt.com/api/auth/callback/openai 这个 URL
        // 直接 fetch 它会被 Cloudflare 403（codex-register 的 undici TLS 指纹被识别）。
        // 改走 ChatGPT web 登录流程：bootChatGPTSession → openSignupPage → password →
        // finishChatGPTRegistration(callback) → getChatGPTAccessToken()
        // 这样能在 chatgpt.com 建立完整的 session cookies。
        console.log(`[phone-signup] 切换到 ChatGPT web 登录拿 accessToken...`);

        // free workflow 会通过参数传入预留邮箱；普通注册才 fallback 到旧 Hotmail 池。
        let bindEmail = readArgValue("--bind-email").trim();
        const bindMailboxUrl = readArgValue("--mailbox-url").trim();
        const bindEmailRaw = readArgValue("--email-raw").trim();
        let fetchAddEmailOtp: (() => Promise<string>) | undefined = undefined;
        try {
            if (bindEmail && bindMailboxUrl) {
                const mailbox = new MailboxUrlCodeProvider(bindMailboxUrl);
                let baseline: MailboxSnapshot | null = null;
                try {
                    baseline = await mailbox.snapshot();
                    console.log(`[phone-signup] add-email 预留邮箱: ${bindEmail} mailbox baseline=${baseline.code ? "code" : "empty"}`);
                } catch (error) {
                    console.warn(`[phone-signup] add-email mailbox baseline failed: ${error instanceof Error ? error.message : String(error)}`);
                }
                fetchAddEmailOtp = async () => {
                    console.log(`[add-email] 等待 mailbox-url 邮件 OTP for ${bindEmail}...`);
                    return await new MailboxUrlCodeProvider(bindMailboxUrl).waitForCode({baseline, timeoutMs: 120000, intervalMs: 3000});
                };
            } else if (bindEmail && bindEmailRaw) {
                process.env.HOTMAIL_TOKENS_FILE = await writeTempHotmailTokenFile(bindEmailRaw);
                const {createHotmailProvider} = await import("./mail/hotmail.js");
                const hotmailProvider = createHotmailProvider();
                console.log(`[phone-signup] add-email 预留 Hotmail: ${bindEmail}`);
                fetchAddEmailOtp = async () => {
                    const startedAt = Date.now();
                    console.log(`[add-email] 等待 IMAP 邮件 OTP for ${bindEmail} (after=${new Date(startedAt).toISOString()})...`);
                    return await (hotmailProvider as any).getEmailVerificationCode(bindEmail, {minTimestampMs: startedAt});
                };
            } else {
                const {createHotmailProvider} = await import("./mail/hotmail.js");
                const hotmailProvider = createHotmailProvider();
                bindEmail = await hotmailProvider.getEmailAddress();
                console.log(`[phone-signup] add-email 候选邮箱: ${bindEmail}`);
                fetchAddEmailOtp = async () => {
                    const startedAt = Date.now();
                    console.log(`[add-email] 等待 IMAP 邮件 OTP for ${bindEmail} (after=${new Date(startedAt).toISOString()})...`);
                    return await (hotmailProvider as any).getEmailVerificationCode(bindEmail, {minTimestampMs: startedAt});
                };
            }
        } catch (e) {
            console.warn(`[phone-signup] 邮箱准备失败 (无 add-email 兜底): ${(e as Error).message}`);
        }

        let webLoginClient = new OpenAIClient({
            email: registeredPhone,
            password: appConfig.defaultPassword,
            deviceProfile: generateRandomDeviceProfile(),
            manualMode: manualOtp,
            smsBroker,
            bindEmail,
            fetchAddEmailOtp,
        });

        // ChatGPT web session 偶发不下发 csrf/session token；注册成功后最多重试 3 次取 accessToken。
        let chatgptAccessToken = "";
        let lastWebTokenError = "";
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            if (attempt > 1) {
                await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
                webLoginClient = new OpenAIClient({
                    email: registeredPhone,
                    password: appConfig.defaultPassword,
                    deviceProfile: generateRandomDeviceProfile(),
                    manualMode: manualOtp,
                    smsBroker,
                    bindEmail,
                    fetchAddEmailOtp,
                });
            }
            try {
                console.log(`[phone-signup] ChatGPT web 登录取 accessToken (${attempt}/3)...`);
                await webLoginClient.authLoginChatGPTWeb();
                console.log(`[phone-signup] ChatGPT web 登录成功，session 已建立`);
                chatgptAccessToken = await webLoginClient.getChatGPTAccessToken();
                if (chatgptAccessToken) break;
            } catch (err) {
                lastWebTokenError = (err as Error).message;
                console.warn(`[警告] web login 拿 ChatGPT accessToken 失败 (${attempt}/3): ${lastWebTokenError}`);
            }
        }
        if (!chatgptAccessToken) {
            console.warn(`[phone-signup] 完成但 3 次都拿不到 ChatGPT accessToken${lastWebTokenError ? `: ${lastWebTokenError}` : ""}`);
            console.log(`[phone] ${registeredPhone}`);
            console.log(`[POOL-RESULT] status=registered_no_at phone=${registeredPhone}`);
            return;
        }
        const accessTokenFile = await webLoginClient.saveChatGPTAccessToken(chatgptAccessToken);
        console.log(`[access_token_file] ${accessTokenFile}`);
        console.log(`[access_token] ${chatgptAccessToken}`);
        console.log(`[phone] ${registeredPhone}`);

        if (gpTokenOutPath) {
            const {appendFile, mkdir, readFile, writeFile} = await import("node:fs/promises");
            const {existsSync} = await import("node:fs");
            const {dirname, resolve} = await import("node:path");
            await mkdir(dirname(gpTokenOutPath), {recursive: true});
            // 写 token
            if (!existsSync(gpTokenOutPath)) {
                await writeFile(gpTokenOutPath, chatgptAccessToken + "\n", "utf8");
            } else {
                const existing = await readFile(gpTokenOutPath, "utf8");
                const needNl = existing.length > 0 && !existing.endsWith("\n");
                if (needNl) await appendFile(gpTokenOutPath, "\n", "utf8");
                await appendFile(gpTokenOutPath, chatgptAccessToken + "\n", "utf8");
            }
            console.log(`[gp_token_out] 已追加到 ${gpTokenOutPath}`);

            // 写 phone → pool_phones.txt (同目录)
            const phonesFile = resolve(dirname(gpTokenOutPath), "pool_phones.txt");
            const phoneLine = `${registeredPhone}----${chatgptAccessToken}\n`;
            if (!existsSync(phonesFile)) {
                await writeFile(phonesFile, phoneLine, "utf8");
            } else {
                const existingPhones = await readFile(phonesFile, "utf8");
                const needNl2 = existingPhones.length > 0 && !existingPhones.endsWith("\n");
                if (needNl2) await appendFile(phonesFile, "\n", "utf8");
                await appendFile(phonesFile, phoneLine, "utf8");
            }
            console.log(`[pool_phones] 已追加 ${registeredPhone} → ${phonesFile}`);
        }
        return;
    }

    // ─── 模式 1: --sign --at 一体化：codex OAuth + add-phone + ChatGPT accessToken + CPA 上传 ───
    if (directSignupAuth && saveAccessToken) {
        const client = new OpenAIClient({
            email: email || undefined,
            password: appConfig.defaultPassword,
            deviceProfile,
            manualMode: manualOtp,
            signupScreenHint: "signup",
            smsBroker,
        });
        const result = await client.authRegisterAndAuthorizeHTTP();
        console.log(
            `[✅️授权成功] 邮箱：${client.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
        );

        // 同步拿 ChatGPT accessToken（OAuth 流程已经建立 chatgpt.com cookie）
        let chatgptAccessToken = "";
        try {
            chatgptAccessToken = await client.getChatGPTAccessToken();
        } catch (err) {
            console.warn(`[警告] 拿 ChatGPT accessToken 失败 (${(err as Error).message})，尝试重新登录`);
            const reauthClient = new OpenAIClient({
                email: client.email,
                password: appConfig.defaultPassword,
                deviceProfile: generateRandomDeviceProfile(),
                manualMode: manualOtp,
                smsBroker,
            });
            try {
                await reauthClient.authLoginHTTP();
            } catch (loginErr) {
                console.warn(`[警告] 重登录失败: ${(loginErr as Error).message}`);
            }
            chatgptAccessToken = await reauthClient.getChatGPTAccessToken();
        }
        const accessTokenFile = await client.saveChatGPTAccessToken(chatgptAccessToken);
        console.log(`[access_token_file] ${accessTokenFile}`);
        console.log(`[access_token] ${chatgptAccessToken}`);

        // 同时把 access_token 写到 GP 端 token.txt（供 Plus 订阅链路用）
        if (gpTokenOutPath) {
            try {
                const {writeFile} = await import("node:fs/promises");
                await writeFile(gpTokenOutPath, chatgptAccessToken, "utf8");
                console.log(`[gp_token_out] 已写入 ${gpTokenOutPath}`);
            } catch (e) {
                console.warn(`[警告] 写 gp-token-out 失败: ${(e as Error).message}`);
            }
        }
        return;
    }

    // ─── 模式 2: 仅 --sign（codex OAuth + add-phone + CPA 上传，不取 ChatGPT token） ───
    if (directSignupAuth) {
        const client = new OpenAIClient({
            email: email || undefined,
            password: appConfig.defaultPassword,
            deviceProfile,
            manualMode: manualOtp,
            signupScreenHint: "signup",
            smsBroker
        });
        const result = await client.authRegisterAndAuthorizeHTTP();
        console.log(
            `[✅️授权成功] 邮箱：${client.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
        );
        return;
    }

    // ─── 模式 3: 仅 --at（注册 + ChatGPT accessToken，不带 add-phone，不上传 CPA） ───
    const registerClient = new OpenAIClient({
        email: email || undefined,
        password: appConfig.defaultPassword,
        deviceProfile,
        manualMode: manualOtp,
        smsBroker
    });
    await registerClient.authRegisterHTTP();

    if (saveAccessToken) {
        let accessToken = "";
        try {
            accessToken = await registerClient.getChatGPTAccessToken();
        } catch (err) {
            console.warn(`[警告] 注册后直接拿 accessToken 失败 (${(err as Error).message})，尝试重新登录`);
            // Fallback: 用注册的邮箱密码重新登录，重新建立 cookie 后再拿 token
            const reauthClient = new OpenAIClient({
                email: registerClient.email,
                password: appConfig.defaultPassword,
                deviceProfile: generateRandomDeviceProfile(),
                manualMode: manualOtp,
                smsBroker,
            });
            try {
                await reauthClient.authLoginHTTP();
            } catch (loginErr) {
                console.warn(`[警告] 重登录也失败: ${(loginErr as Error).message}`);
            }
            accessToken = await reauthClient.getChatGPTAccessToken();
        }
        const accessTokenFile = await registerClient.saveChatGPTAccessToken(accessToken);
        console.log(`[✅️注册成功] 邮箱：${registerClient.email} 密码：${appConfig.defaultPassword}`);
        console.log(`[access_token_file] ${accessTokenFile}`);
        console.log(`[access_token] ${accessToken}`);

        // 追加到 --gp-token-out 指定的文件（默认 pool_tokens.txt 用于 GoPay charge）
        if (gpTokenOutPath && accessToken) {
            try {
                const {appendFile, mkdir, readFile, writeFile} = await import("node:fs/promises");
                const {existsSync} = await import("node:fs");
                const {dirname} = await import("node:path");
                await mkdir(dirname(gpTokenOutPath), {recursive: true});
                if (!existsSync(gpTokenOutPath)) {
                    await writeFile(gpTokenOutPath, accessToken + "\n", "utf8");
                } else {
                    const existing = await readFile(gpTokenOutPath, "utf8");
                    const needNewline = existing.length > 0 && !existing.endsWith("\n");
                    if (needNewline) {
                        await writeFile(gpTokenOutPath, existing + "\n", "utf8");
                    }
                    await appendFile(gpTokenOutPath, accessToken + "\n", "utf8");
                }
                console.log(`[gp_token_out] 已追加到: ${gpTokenOutPath}`);
            } catch (e) {
                console.warn(`[警告] 写 gp-token-out 失败: ${(e as Error).message}`);
            }
        }

        // 注册成功 → 把用过的 hotmail 卡密从 pool_emails.txt 移除，append 到 history
        // 仅当 provider=hotmail 且 email 来自池里时才执行（其他 provider 文件结构不同）
        if (MAILBOX_CONFIG.provider === "hotmail" && registerClient.email) {
            try {
                // 等 hotmail provider 的 IMAP refresh-token 持久化先跑完，避免 race condition
                // （IMAP 收 OTP 时可能触发 refresh，然后 persistTextAccount 写回老内容覆盖我们的删除）
                await new Promise(r => setTimeout(r, 1500));
                const {consumeHotmailLine} = await import("./consume-hotmail.js");
                const cr = consumeHotmailLine(registerClient.email);
                if (cr.ok) {
                    console.log(`[hotmail 卡密消费] ${cr.reason}`);
                } else {
                    console.warn(`[hotmail 卡密消费跳过] ${cr.reason}`);
                }
            } catch (e) {
                console.warn(`[hotmail 卡密消费失败，忽略] ${(e as Error).message}`);
            }
        }
        return;
    }

    const loginClient = new OpenAIClient({
        email: registerClient.email,
        password: appConfig.defaultPassword,
        deviceProfile,
        manualMode: manualOtp,
        smsBroker
    });
    const result = await loginClient.authLoginHTTP();
    console.log(
        `[✅️授权成功] 邮箱：${loginClient.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
    );
}

async function main() {
    let round = 0;
    let successCount = 0;
    let failCount = 0;
    const manualEmail = readArgValue("--email").trim();
    const authOnly = hasFlag("--auth");
    const manualOtp = hasFlag("--otp");
    const maxRounds = readNumberArg("--n");

    if (authOnly) {
        if (!manualEmail) {
            throw new Error("使用 --auth 时必须同时指定 --email");
        }
        try {
            const deviceProfile = generateRandomDeviceProfile();
            const client = new OpenAIClient({
                email: manualEmail,
                password: appConfig.defaultPassword,
                deviceProfile,
                manualMode: manualOtp,
                smsBroker,
            });
            const result = await client.authLoginHTTP();
            console.log(
                `[✅️授权成功] 邮箱：${client.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
            );

            // 如果加了 --at，再拿 ChatGPT plan accessToken
            if (hasFlag("--at")) {
                let chatgptAccessToken = "";
                try {
                    chatgptAccessToken = await client.getChatGPTAccessToken();
                } catch (err) {
                    console.warn(`[警告] 拿 ChatGPT accessToken 失败 (${(err as Error).message})`);
                }
                if (chatgptAccessToken) {
                    const accessTokenFile = await client.saveChatGPTAccessToken(chatgptAccessToken);
                    console.log(`[access_token_file] ${accessTokenFile}`);
                    console.log(`[access_token] ${chatgptAccessToken}`);
                    const gpOut = readArgValue("--gp-token-out").trim();
                    if (gpOut) {
                        const {writeFile} = await import("node:fs/promises");
                        await writeFile(gpOut, chatgptAccessToken, "utf8");
                        console.log(`[gp_token_out] 已写入 ${gpOut}`);
                    }
                }
            }
        } catch (error) {
            console.error(`[❌️授权失败]`, error);
        }
        return;
    }

    if (manualEmail) {
        try {
            await runOnce();
        } catch (error) {
            console.error(`[❌️授权失败]`, error);
        }
        return;
    }

    if (hasFlag("--codex-cpa") || hasFlag("--phone")) {
        try {
            await runOnce();
        } catch (error) {
            console.error(`[❌️授权失败]`, error);
            process.exitCode = 1;
        }
        return;
    }

    while (!maxRounds || round < maxRounds) {
        round += 1;
        console.log(
            `第 ${round} 轮开始: 成功=${successCount} 失败=${failCount} 模式=自动`,
        );
        try {
            await runOnce();
            successCount += 1;
        } catch (error) {
            failCount += 1;
            console.error(`[❌️授权失败]`, error);
        }

        if (appConfig.loopDelayMs > 0) {
            console.log(`[延迟] 轮次间等待 ${appConfig.loopDelayMs}ms`);
            await new Promise((resolve) => setTimeout(resolve, appConfig.loopDelayMs));
        }
    }

    console.log(
        `自动模式结束: 已执行=${round} 成功=${successCount} 失败=${failCount}`,
    );
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closeSentinelBrowser();
    });
