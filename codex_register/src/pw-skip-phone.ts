/**
 * 免 addphone 方案：API 登录建立 session + Playwright 前端重放绕过
 *
 * 流程:
 *   1. API: email + OTP 走到 add-phone (session cookie 已建立)
 *   2. 把 session cookies 注入 Playwright
 *   3. Playwright 打开新的 Codex OAuth URL → choose-an-account
 *   4. 拦截 session/select 响应，绕过 phone
 *   5. 前端走完 consent → callback code → 换 token
 *
 * 用法:
 *   node dist/pw-skip-phone.js --email xxx@outlook.com [--password xxx] [--head]
 */
import {existsSync} from "node:fs";
import {chromium, type Route} from "playwright-core";
import {appConfig} from "./config.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {AUTH_BASE_URL, DEFAULT_CLIENT_ID, DEFAULT_REDIRECT_URI} from "./constants.js";
import {OpenAIClient} from "./openai.js";
import crypto from "node:crypto";

function readArgValue(flag: string): string {
    const index = process.argv.indexOf(flag);
    if (index === -1) return "";
    return process.argv[index + 1] ?? "";
}

function randomUrlSafeString(length: number): string {
    return crypto.randomBytes(length).toString("base64url").slice(0, length);
}

function pkceCodeChallenge(verifier: string): string {
    return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function resolveBrowserPath(): string {
    const candidates = [
        process.env.SENTINEL_BROWSER_PATH,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ].filter(Boolean) as string[];
    return candidates.find((c) => existsSync(c)) || "";
}

function buildOAuthUrl(): {url: string; state: string; codeVerifier: string} {
    const state = randomUrlSafeString(24);
    const codeVerifier = randomUrlSafeString(64);
    const query = new URLSearchParams({
        client_id: DEFAULT_CLIENT_ID,
        response_type: "code",
        redirect_uri: DEFAULT_REDIRECT_URI,
        scope: "openid email profile offline_access",
        state,
        code_challenge: pkceCodeChallenge(codeVerifier),
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
    });
    return {url: `${AUTH_BASE_URL}/oauth/authorize?${query.toString()}`, state, codeVerifier};
}

async function main() {
    const email = readArgValue("--email").trim();
    const password = readArgValue("--password").trim() || appConfig.defaultPassword;
    const headless = !process.argv.includes("--head");

    if (!email) {
        console.error("用法: node dist/pw-skip-phone.js --email xxx@outlook.com [--password xxx] [--head]");
        process.exit(1);
    }

    console.log(`[pw] email=${email} headless=${headless}`);

    // ═══════════ 阶段 1: API 登录到 add-phone ═══════════
    console.log("\n[阶段1] API 登录建立 session...");
    const deviceProfile = generateRandomDeviceProfile();
    const client = new OpenAIClient({email, password, deviceProfile, manualMode: false});

    const tempOAuthUrl = client.prepareManualLogin("login");
    await client.fetch(tempOAuthUrl, {redirect: "follow", headers: {"user-agent": client.userAgent, "sec-fetch-dest": "document", "sec-fetch-mode": "navigate"}});

    let nextURL = await client.authorizeContinue();
    console.log("  authorize/continue →", nextURL);

    if (nextURL.includes("/email-verification")) {
        nextURL = await client.emailOtpValidate();
        console.log("  emailOtp →", nextURL);
    }

    if (!nextURL.includes("/add-phone")) {
        if (nextURL.includes("/consent") || nextURL.includes("localhost")) {
            console.log("[✅] 没有触发 add-phone！直接成功");
        } else {
            console.log("[?] 未知状态:", nextURL);
        }
        return;
    }

    console.log("[阶段1 完成] 已到 add-phone，session 已建立");

    // 从 cookie jar 导出 cookies
    const jarCookies = await client.jar.getCookies("https://auth.openai.com");
    console.log(`  cookies: ${jarCookies.map((c: any) => c.key).join(", ")}`);

    // ═══════════ 阶段 2: Playwright 前端重放 ═══════════
    console.log("\n[阶段2] 启动 Playwright...");

    const proxyArg = readArgValue("--proxy").trim() || "http://USER-region-US:PASS@PROXY_HOST:PORT";
    const proxyUrl = new URL(proxyArg.startsWith("http") ? proxyArg : `http://${proxyArg}`);

    const browser = await chromium.launch({
        headless,
        executablePath: resolveBrowserPath() || undefined,
        proxy: {
            server: `http://${proxyUrl.host}`,
            username: decodeURIComponent(proxyUrl.username),
            password: decodeURIComponent(proxyUrl.password),
        },
    });

    const context = await browser.newContext({
        userAgent: client.userAgent,
        viewport: {width: 1280, height: 800},
        ignoreHTTPSErrors: true,
    });

    // 注入 cookies
    const playwrightCookies = jarCookies.map((c: any) => ({
        name: c.key,
        value: c.value,
        domain: c.domain?.startsWith(".") ? c.domain : `.${c.domain || "auth.openai.com"}`,
        path: c.path || "/",
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? false,
        sameSite: "None" as const,
    }));
    await context.addCookies(playwrightCookies);
    console.log(`  注入 ${playwrightCookies.length} 个 cookies`);

    const page = await context.newPage();

    // ═══════════ 设置拦截规则 ═══════════
    const {url: oauthUrl, state, codeVerifier} = buildOAuthUrl();
    let callbackCode = "";
    let callbackResolve: (() => void) | null = null;
    const callbackPromise = new Promise<void>((resolve) => { callbackResolve = resolve; });

    // 核心拦截: session/select
    await page.route("**/api/accounts/session/select", async (route: Route) => {
        const response = await route.fetch();
        const body = await response.text();
        try {
            const json = JSON.parse(body);
            console.log(`[intercept] session/select: type="${json.page?.type}" url="${json.continue_url}"`);

            if (json.page?.type?.includes("phone") || json.continue_url?.includes("phone")) {
                // 改成 redirect 到 oauth2/auth 让 hydra 直接给 code
                const redirectUrl = `${AUTH_BASE_URL}/api/oauth/oauth2/auth?` + new URLSearchParams({
                    client_id: DEFAULT_CLIENT_ID,
                    code_challenge: pkceCodeChallenge(codeVerifier),
                    code_challenge_method: "S256",
                    codex_cli_simplified_flow: "true",
                    id_token_add_organizations: "true",
                    redirect_uri: DEFAULT_REDIRECT_URI,
                    response_type: "code",
                    scope: "openid email profile offline_access",
                    state,
                }).toString();

                const newJson = {
                    continue_url: redirectUrl,
                    method: "GET",
                    page: {type: "redirect", backstack_behavior: "default"},
                };
                console.log("[intercept] ✅ 改写 → oauth2/auth redirect");
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify(newJson),
                });
                return;
            }
        } catch (e) {
            console.log("[intercept] parse error:", (e as Error).message);
        }
        await route.fulfill({response});
    });

    // 拦截 localhost callback
    await page.route("http://localhost:1455/**", async (route: Route) => {
        const params = new URL(route.request().url()).searchParams;
        const code = params.get("code");
        if (code) {
            callbackCode = code;
            console.log(`[callback] ✅ code=${code.slice(0, 40)}...`);
            callbackResolve?.();
        }
        await route.fulfill({status: 200, contentType: "text/html", body: "<h1>OK</h1>"});
    });

    // 监听所有 request
    page.on("response", (resp) => {
        const url = resp.url();
        if (url.includes("auth.openai.com") && !url.includes("cdn") && !url.includes(".js") && !url.includes(".css")) {
            console.log(`  [resp] ${resp.status()} ${url.split("?")[0].slice(-60)}`);
        }
    });

    // ═══════════ 导航到 OAuth ═══════════
    console.log("\n[阶段2] 导航到 Codex OAuth...");
    console.log(`  URL: ${oauthUrl.slice(0, 100)}...`);

    try {
        await page.goto(oauthUrl, {waitUntil: "domcontentloaded", timeout: 30000});
    } catch (e) {
        console.log(`  goto error: ${(e as Error).message?.slice(0, 100)}`);
    }

    await page.waitForTimeout(3000);
    console.log(`  当前页: ${page.url().slice(0, 100)}`);

    // 如果到了 choose-an-account，选账号
    if (page.url().includes("choose-an-account")) {
        console.log("[pw] choose-an-account，点击账号...");
        await page.waitForTimeout(2000);
        // 点击任意账号按钮
        const btns = page.locator("button");
        const count = await btns.count();
        for (let i = 0; i < count; i++) {
            const text = await btns.nth(i).textContent().catch(() => "");
            if (text?.includes(email) || text?.includes("@")) {
                await btns.nth(i).click();
                console.log(`  点击了: ${text?.slice(0, 40)}`);
                break;
            }
        }
        await page.waitForTimeout(5000);
    }

    // 等 callback
    const timer = setTimeout(() => {
        console.log("[pw] ⏰ 超时 30s");
        callbackResolve?.();
    }, 30000);

    await callbackPromise;
    clearTimeout(timer);

    if (!callbackCode) {
        console.error("\n[❌] 没拿到 code");
        console.log(`  最终页: ${page.url()}`);
        await page.screenshot({path: "pw-debug.png"});
        await browser.close();
        process.exit(1);
    }

    // ═══════════ 阶段 3: 换 token ═══════════
    console.log("\n[阶段3] 换 token...");
    const tokenResp = await client.fetch("https://auth.openai.com/api/oauth/oauth2/token", {
        method: "POST",
        headers: {"content-type": "application/json", "user-agent": client.userAgent},
        body: JSON.stringify({
            grant_type: "authorization_code",
            code: callbackCode,
            redirect_uri: DEFAULT_REDIRECT_URI,
            client_id: DEFAULT_CLIENT_ID,
            code_verifier: codeVerifier,
        }),
    });

    const tokenText = await tokenResp.text();
    if (tokenResp.ok) {
        const data = JSON.parse(tokenText);
        console.log(`\n[✅] 成功！免 addphone 拿到 token！`);
        console.log(`  access_token=${(data.access_token || "").slice(0, 60)}...`);
        console.log(`  expires_in=${data.expires_in}`);
    } else {
        console.error(`\n[❌] token exchange 失败: ${tokenText.slice(0, 300)}`);
    }

    await browser.close();
}

main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
});
