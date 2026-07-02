/**
 * 测试 --skip-phone: 用一个已注册的邮箱+密码直接走 OAuth 登录
 * 看遇到 add-phone 时能否跳过直接走 email-otp
 *
 * 用法: node dist/test-skip-phone.js --email xxx@gmail.com --password xxx --skip-phone
 */
import {generateRandomDeviceProfile} from "./device-profile.js";
import {OpenAIClient} from "./openai.js";
import {appConfig} from "./config.js";

function readArgValue(flag: string): string {
    const index = process.argv.indexOf(flag);
    if (index === -1) return "";
    return process.argv[index + 1] ?? "";
}

async function main() {
    const email = readArgValue("--email").trim();
    const password = readArgValue("--password").trim() || appConfig.defaultPassword;

    if (!email) {
        console.error("用法: node dist/test-skip-phone.js --email xxx@gmail.com [--password xxx] --skip-phone");
        process.exit(1);
    }

    console.log(`[test-skip-phone] email=${email} password=${password.slice(0, 3)}***`);
    console.log(`[test-skip-phone] --skip-phone=${process.argv.includes("--skip-phone")}`);

    const deviceProfile = generateRandomDeviceProfile();
    const client = new OpenAIClient({
        email,
        password,
        deviceProfile,
        manualMode: true, // 手动模式，email OTP 需要手动输入
    });

    try {
        const result = await client.authLoginHTTP();
        console.log(`[test-skip-phone] ✅ 登录成功！`);
        console.log(`  code=${result.code?.slice(0, 20)}...`);
        console.log(`  authFile=${result.authFile}`);
    } catch (e) {
        console.error(`[test-skip-phone] ❌ 登录失败:`, (e as Error).message);
        process.exit(1);
    }
}

main();
