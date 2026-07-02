// 注册成功后把"已用"的 hotmail 卡密从池文件里删掉，append 到 history。
// 池文件查找顺序与 hotmail.ts 的 resolveTokensFile 对齐：
//   1. HOTMAIL_TOKENS_FILE 环境变量
//   2. codex_register/hotmail/tokens.txt
//   3. <项目根>/pool_emails.txt
//   4. <项目根>/hotmail_inbox.txt
// 找到第一个含目标 email 的文件，把那行从原文件移除，append 到 <projectRoot>/hotmail_inbox.history.txt。

import {existsSync, readFileSync, writeFileSync, appendFileSync} from "node:fs";
import path from "node:path";

const HOTMAIL_TOKEN_DIR = path.resolve(process.cwd(), "hotmail");

function projectRoot(): string {
    const cwd = process.cwd();
    if (path.basename(cwd) === "codex_register" && path.basename(path.dirname(cwd)) === "codexrigester") {
        return path.resolve(cwd, "..", "..");
    }
    return path.resolve(cwd, "..");
}

const PROJECT_ROOT = projectRoot();

function candidatePaths(): string[] {
    const out: string[] = [];
    if (process.env.HOTMAIL_TOKENS_FILE) {
        out.push(path.resolve(process.env.HOTMAIL_TOKENS_FILE));
    }
    out.push(path.join(HOTMAIL_TOKEN_DIR, "tokens.txt"));
    out.push(path.resolve(PROJECT_ROOT, "pool_emails.txt"));
    out.push(path.resolve(PROJECT_ROOT, "hotmail_inbox.txt"));
    // 去重保序
    const seen = new Set<string>();
    return out.filter((p) => {
        if (seen.has(p)) return false;
        seen.add(p);
        return true;
    });
}

function historyPath(): string {
    return path.resolve(PROJECT_ROOT, "hotmail_inbox.history.txt");
}

/**
 * 在 hotmail 池文件里找出与 emailLc 匹配的那行，把它移到 history。
 * 命中即返回 true（一个 email 在多个文件出现的极端情况下，本函数只处理第一个）。
 */
export function consumeHotmailLine(email: string): {ok: boolean; reason: string; file?: string} {
    const target = email.trim().toLowerCase();
    if (!target) {
        return {ok: false, reason: "email 为空"};
    }
    for (const file of candidatePaths()) {
        if (!existsSync(file)) continue;
        let raw: string;
        try {
            raw = readFileSync(file, "utf8");
        } catch (e) {
            continue;
        }
        const lines = raw.split(/\r?\n/);
        // 卡密格式：email----password----client_id----refresh_token
        // 兼容大小写、首尾空格
        let hitIdx = -1;
        for (let i = 0; i < lines.length; i += 1) {
            const ln = lines[i].trim();
            if (!ln || ln.startsWith("#")) continue;
            const head = ln.split("----", 1)[0].trim().toLowerCase();
            if (head === target) {
                hitIdx = i;
                break;
            }
        }
        if (hitIdx < 0) continue;

        const removed = lines[hitIdx];
        lines.splice(hitIdx, 1);
        // 写回（保留尾换行）
        const next = lines.filter((l) => l != null).join("\n").replace(/\n+$/g, "") + "\n";
        try {
            writeFileSync(file, next, "utf8");
        } catch (e) {
            return {ok: false, reason: `写回 ${file} 失败: ${(e as Error).message}`, file};
        }
        // append 到 history
        try {
            const ts = new Date().toISOString();
            appendFileSync(historyPath(), `# consumed at ${ts} from ${path.basename(file)}\n${removed}\n`, "utf8");
        } catch {
            // history 写失败不阻塞主流程
        }
        return {ok: true, reason: `已移除 1 行 from ${path.basename(file)}`, file};
    }
    return {ok: false, reason: `未在任何卡密池文件找到 email=${email}`};
}
