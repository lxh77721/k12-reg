/**
 * 测试：完成 email-otp 后到 add-phone，然后直接调 oauth2/auth 看能否拿到 code
 */
import crypto from "node:crypto";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {OpenAIClient} from "./openai.js";
import {appConfig} from "./config.js";
import {AUTH_BASE_URL, DEFAULT_CLIENT_ID, DEFAULT_REDIRECT_URI} from "./constants.js";

async function main() {
    const email = "neighborkemps64@outlook.com";
    const password = appConfig.defaultPassword;
    const deviceProfile = generateRandomDeviceProfile();
    const client = new OpenAIClient({email, password, deviceProfile, manualMode: false});

    // Step 1: authorize
    console.log("[1] authorize");
    const oauthUrl = client.prepareManualLogin("login");
    await client.fetch(oauthUrl, {redirect: "follow", headers: {"user-agent": client.userAgent, "sec-fetch-dest": "document", "sec-fetch-mode": "navigate"}});

    // Step 2: authorize/continue
    console.log("[2] authorize/continue");
    let nextURL = await client.authorizeContinue();
    console.log("  →", nextURL);

    // Step 3: email-otp (自动)
    if (nextURL.includes("/email-verification")) {
        console.log("[3] email-otp (auto)");
        nextURL = await client.emailOtpValidate();
        console.log("  →", nextURL);
    }

    console.log("[状态]", nextURL);
    if (!nextURL.includes("/add-phone")) {
        console.log("不是 add-phone，退出");
        return;
    }

    // 关键测试：直接调 oauth2/auth
    console.log("[4] 直接调 api/oauth/oauth2/auth (绕过 add-phone)...");
    const codeChallenge = crypto.createHash("sha256").update(client.codeVerifier).digest("base64url");
    const authUrl = `${AUTH_BASE_URL}/api/oauth/oauth2/auth?` + new URLSearchParams({
        client_id: DEFAULT_CLIENT_ID,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        codex_cli_simplified_flow: "true",
        id_token_add_organizations: "true",
        redirect_uri: DEFAULT_REDIRECT_URI,
        response_type: "code",
        scope: "openid email profile offline_access",
        state: client.state,
    }).toString();

    const r1 = await client.fetch(authUrl, {method: "GET", redirect: "manual", headers: {"user-agent": client.userAgent}});
    console.log("  status=" + r1.status);
    const loc1 = r1.headers.get("location") || "";
    console.log("  location=" + loc1.slice(0, 200));

    // 跟 redirect chain
    if (loc1 && !loc1.includes("localhost")) {
        console.log("[5] follow: " + loc1.slice(0, 100));
        const r2 = await client.fetch(loc1.startsWith("http") ? loc1 : `${AUTH_BASE_URL}${loc1}`, {method: "GET", redirect: "manual", headers: {"user-agent": client.userAgent}});
        console.log("  status=" + r2.status);
        const loc2 = r2.headers.get("location") || "";
        console.log("  location=" + loc2.slice(0, 200));

        if (loc2 && !loc2.includes("localhost")) {
            console.log("[6] follow: " + loc2.slice(0, 100));
            const r3 = await client.fetch(loc2.startsWith("http") ? loc2 : `${AUTH_BASE_URL}${loc2}`, {method: "GET", redirect: "manual", headers: {"user-agent": client.userAgent}});
            console.log("  status=" + r3.status);
            const loc3 = r3.headers.get("location") || "";
            console.log("  location=" + loc3.slice(0, 200));

            if (loc3.includes("localhost")) {
                console.log("\n[✅] 拿到 callback！code=" + new URL(loc3).searchParams.get("code")?.slice(0, 40) + "...");
            }
        }
        if (loc2.includes("localhost")) {
            console.log("\n[✅] 拿到 callback！code=" + new URL(loc2).searchParams.get("code")?.slice(0, 40) + "...");
        }
    }
    if (loc1.includes("localhost")) {
        console.log("\n[✅] 直接拿到 callback！code=" + new URL(loc1).searchParams.get("code")?.slice(0, 40) + "...");
    }
}

main().catch((e) => { console.error("ERROR:", (e as Error).message); process.exit(1); });
