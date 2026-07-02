/**
 * 测试跳过 add-phone: 直接调 workspace/select
 */
import {generateRandomDeviceProfile} from "./device-profile.js";
import {OpenAIClient} from "./openai.js";
import {appConfig} from "./config.js";
import {AUTH_BASE_URL} from "./constants.js";

async function main() {
    const email = "neighborkemps64@outlook.com";
    const password = appConfig.defaultPassword;
    const deviceProfile = generateRandomDeviceProfile();
    const client = new OpenAIClient({
        email,
        password,
        deviceProfile,
        manualMode: true,
    });

    // Step 1: authorize
    console.log("[1] authorize");
    const oauthUrl = client.prepareManualLogin();
    await client.fetch(oauthUrl, {
        redirect: "follow",
        headers: {"user-agent": client.userAgent, "sec-fetch-dest": "document", "sec-fetch-mode": "navigate"},
    });

    // Step 2: authorize/continue
    console.log("[2] authorize/continue");
    let nextURL = await client.authorizeContinue();
    console.log("  → " + nextURL);

    // Step 3: email-otp if needed
    if (nextURL.includes("/email-verification")) {
        console.log("[3] email-otp");
        nextURL = await client.emailOtpValidate();
        console.log("  → " + nextURL);
    }

    console.log("[状态] " + nextURL);
    if (!nextURL.includes("/add-phone")) {
        console.log("没到 add-phone，退出");
        return;
    }

    // 跳过 add-phone
    console.log("[5] 跳过 add-phone，尝试 client_auth_session_dump");
    const dumpResp = await client.fetch(`${AUTH_BASE_URL}/api/accounts/client_auth_session_dump`, {
        method: "GET",
        headers: {"user-agent": client.userAgent, "accept": "application/json"},
    });
    console.log("  dump status=" + dumpResp.status);
    const dumpText = await dumpResp.text();
    console.log("  dump=" + dumpText.slice(0, 600));

    // 尝试几个 workspace_id
    const workspaceIds = ["personal", "default", ""];
    
    // 也试下解析 dump 拿 workspace
    try {
        const dumpData = JSON.parse(dumpText);
        if (dumpData.workspaces) {
            for (const ws of dumpData.workspaces) {
                if (ws.id) workspaceIds.unshift(ws.id);
            }
        }
        if (dumpData.workspace_id) workspaceIds.unshift(dumpData.workspace_id);
    } catch {}

    for (const wsId of workspaceIds) {
        console.log(`\n[6] POST workspace/select workspace_id="${wsId}"`);
        const wsResp = await client.fetch(`${AUTH_BASE_URL}/api/accounts/workspace/select`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "user-agent": client.userAgent,
                "origin": AUTH_BASE_URL,
                "referer": `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`,
            },
            body: JSON.stringify({workspace_id: wsId}),
        });
        console.log("  status=" + wsResp.status);
        const wsText = await wsResp.text();
        console.log("  body=" + wsText.slice(0, 400));

        if (wsResp.ok) {
            try {
                const wsData = JSON.parse(wsText);
                if (wsData.continue_url) {
                    console.log("\n[7] followOAuthRedirects → " + wsData.continue_url.slice(0, 120));
                    const result = await client.followOAuthRedirects(wsData.continue_url);
                    console.log("[✅] 成功！code=" + (result.code || "").slice(0, 30) + "...");
                    return;
                }
            } catch (e) {
                console.log("  parse error:", (e as Error).message);
            }
        }
    }

    console.log("\n[❌] 所有 workspace/select 尝试都失败");
}

main().catch((e) => {
    console.error("FATAL:", (e as Error).message);
    process.exit(1);
});
