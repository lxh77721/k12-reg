/**
 * 给已有 access_token 的账号开启 TOTP MFA
 * 
 * 用法: node dist/enroll-totp.js --token "eyJ..."
 * 
 * 流程:
 * 1. POST /backend-api/settings/mfa/enroll  → 拿到 totp_secret
 * 2. 用 secret 算出一个 TOTP code
 * 3. POST /backend-api/settings/mfa/verify  → 验证开启 MFA
 */
import crypto from "node:crypto";
import {appConfig} from "./config.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {OpenAIClient} from "./openai.js";

function readArgValue(flag: string): string {
    const index = process.argv.indexOf(flag);
    if (index === -1) return "";
    return process.argv[index + 1] ?? "";
}

// TOTP 算法实现
function generateTOTP(secret: string, timeStep = 30, digits = 6): string {
    const base32Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const secretUpper = secret.replace(/[\s=-]/g, "").toUpperCase();
    let bits = "";
    for (const char of secretUpper) {
        const idx = base32Chars.indexOf(char);
        if (idx === -1) continue;
        bits += idx.toString(2).padStart(5, "0");
    }
    const keyBytes = Buffer.alloc(Math.floor(bits.length / 8));
    for (let i = 0; i < keyBytes.length; i++) {
        keyBytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }

    const epoch = Math.floor(Date.now() / 1000);
    const counter = Math.floor(epoch / timeStep);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuffer.writeUInt32BE(counter & 0xFFFFFFFF, 4);

    const hmac = crypto.createHmac("sha1", keyBytes);
    hmac.update(counterBuffer);
    const hash = hmac.digest();

    const offset = hash[hash.length - 1] & 0x0f;
    const binary =
        ((hash[offset] & 0x7f) << 24) |
        ((hash[offset + 1] & 0xff) << 16) |
        ((hash[offset + 2] & 0xff) << 8) |
        (hash[offset + 3] & 0xff);
    
    const otp = binary % Math.pow(10, digits);
    return otp.toString().padStart(digits, "0");
}

async function main() {
    const token = readArgValue("--token").trim();
    if (!token) {
        console.error("用法: node dist/enroll-totp.js --token \"eyJ...\"");
        process.exit(1);
    }

    // 复用 OpenAIClient 的代理设置（它的 fetch 已经过了代理+cookie jar）
    const deviceProfile = generateRandomDeviceProfile();
    const client = new OpenAIClient({
        email: "dummy@test.com",
        password: "dummy",
        deviceProfile,
        manualMode: true,
    });

    const headers = {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": client.userAgent,
        "Origin": "https://chatgpt.com",
        "Referer": "https://chatgpt.com/",
    };

    // Step 1: Enroll TOTP
    console.log("[enroll-totp] Step 1: POST /backend-api/settings/mfa/enroll");
    const enrollResp = await client.fetch("https://chatgpt.com/backend-api/settings/mfa/enroll", {
        method: "POST",
        headers,
        body: JSON.stringify({type: "totp"}),
    });
    
    console.log(`[enroll-totp] enroll status=${enrollResp.status}`);
    const enrollText = await enrollResp.text();
    console.log(`[enroll-totp] enroll response: ${enrollText.slice(0, 800)}`);
    
    if (!enrollResp.ok) {
        console.error("[enroll-totp] ❌ enroll 失败");
        process.exit(1);
    }

    const enrollData = JSON.parse(enrollText);
    const secret = enrollData.secret || enrollData.totp_secret || enrollData.base32 || "";
    const provisioningUri = enrollData.provisioning_uri || enrollData.uri || enrollData.otpauth_url || "";
    
    if (!secret) {
        // 也许 secret 在 provisioning_uri 里
        const match = provisioningUri.match(/secret=([A-Z2-7]+)/i);
        if (match) {
            console.log(`[enroll-totp] 从 URI 提取 secret`);
        } else {
            console.error("[enroll-totp] ❌ 没拿到 secret，完整响应:", enrollText);
            process.exit(1);
        }
    }

    const finalSecret = secret || (provisioningUri.match(/secret=([A-Z2-7]+)/i)?.[1] ?? "");
    console.log(`[enroll-totp] ✅ TOTP secret: ${finalSecret}`);
    if (provisioningUri) console.log(`[enroll-totp] URI: ${provisioningUri}`);

    // Step 2: 生成验证码
    const code = generateTOTP(finalSecret);
    console.log(`[enroll-totp] Step 2: TOTP code=${code}`);

    // Step 3: Verify/Confirm
    console.log("[enroll-totp] Step 3: POST /backend-api/settings/mfa/verify");
    const verifyResp = await client.fetch("https://chatgpt.com/backend-api/settings/mfa/verify", {
        method: "POST",
        headers,
        body: JSON.stringify({code, type: "totp"}),
    });
    
    console.log(`[enroll-totp] verify status=${verifyResp.status}`);
    const verifyText = await verifyResp.text();
    console.log(`[enroll-totp] verify response: ${verifyText.slice(0, 500)}`);
    
    if (verifyResp.ok) {
        console.log(`\n[enroll-totp] ✅ MFA TOTP 开启成功！`);
        console.log(`[enroll-totp] ========================================`);
        console.log(`[enroll-totp] Secret (保存好): ${finalSecret}`);
        console.log(`[enroll-totp] ========================================`);
    } else {
        console.error("[enroll-totp] ❌ verify 失败");
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
