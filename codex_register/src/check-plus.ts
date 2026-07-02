// 独立脚本: 检查 ChatGPT access_token 的邮箱和订阅套餐。
// 走代理调 chatgpt.com/backend-api/accounts/check, 支持 socks5。
//
// 用法:
//   tsx src/check-plus.ts <token>          单 token
//   tsx src/check-plus.ts -f <file>        批量
//   tsx src/check-plus.ts -                从 stdin
//
// 输出格式: <email>  <plan>
//   plan 可能值: free / plus / pro / team / enterprise / expired / blocked / error / invalid
//
// 环境变量:
//   PROBE_PROXY            代理 URL (默认从 ../config.json 读 proxy_jp)
//   CHECK_PLUS_DEBUG=1     打印 API 原始响应
//   JWT_ONLY=1             只解 JWT 不调 API

import {readFileSync} from "node:fs";
import path from "node:path";
import {Agent} from "undici";
import {SocksClient} from "socks";
import * as net from "node:net";
import * as tls from "node:tls";

interface JwtView {
    plan: string;
    email: string;
    exp: number;
}

function decodeJwt(tok: string): JwtView | null {
    const parts = tok.split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    try {
        const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
        const auth = payload["https://api.openai.com/auth"] ?? {};
        const prof = payload["https://api.openai.com/profile"] ?? {};
        return {
            plan: String(auth.chatgpt_plan_type ?? "unknown").toLowerCase(),
            email: String(prof.email ?? auth.email ?? "unknown"),
            exp: Number(payload.exp ?? 0),
        };
    } catch {
        return null;
    }
}

function isSocks(protocol: string): boolean {
    return ["socks4:", "socks4a:", "socks5:", "socks5h:"].includes(protocol);
}

async function createSocksSocket(proxyUrl: URL, options: Record<string, any>): Promise<net.Socket> {
    const destHost = String(options.hostname ?? "");
    const destPort = options.port == null || options.port === ""
        ? (options.protocol === "https:" ? 443 : 80)
        : Number(options.port);
    const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol.startsWith("socks5") ? 1080 : 1080));
    const proxyType: 4 | 5 = proxyUrl.protocol.startsWith("socks4") ? 4 : 5;

    const conn = await SocksClient.createConnection({
        proxy: {
            host: proxyUrl.hostname,
            port: proxyPort,
            type: proxyType,
            userId: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined,
        },
        command: "connect",
        destination: {host: destHost, port: destPort},
    });

    if (options.protocol !== "https:") return conn.socket;

    return await new Promise<net.Socket>((resolve, reject) => {
        const tlsSocket = tls.connect({
            socket: conn.socket,
            host: String(options.servername ?? destHost),
            servername: String(options.servername ?? destHost),
            rejectUnauthorized: true,
        });
        tlsSocket.once("secureConnect", () => resolve(tlsSocket));
        tlsSocket.once("error", reject);
    });
}

function buildDispatcher(proxy: string): Agent {
    if (!proxy) {
        return new Agent({connectTimeout: 20_000, headersTimeout: 20_000, bodyTimeout: 30_000});
    }
    const u = new URL(proxy);
    if (isSocks(u.protocol)) {
        return new Agent({
            connect: (opts: any, cb: any) => {
                createSocksSocket(u, opts).then((s) => cb(null, s)).catch(cb);
            },
            connectTimeout: 20_000,
            headersTimeout: 20_000,
            bodyTimeout: 30_000,
        });
    }
    return new Agent({connectTimeout: 20_000, headersTimeout: 20_000, bodyTimeout: 30_000});
}

interface ApiResult {
    plan: string;       // "plus" | "pro" | "team" | "enterprise" | "free" | "blocked" | "error"
    raw?: string;       // 原始 plan 字符串
    expiresAt?: string; // 订阅过期时间 ISO
    willRenew?: boolean | null; // 是否会自动续订
    cancelsAt?: string | null;  // 计划取消时间(若已设)
    delinquent?: boolean;       // 是否欠费
    error?: string;
}

const ACCOUNTS_CHECK_URL = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480";

async function fetchPlan(token: string, proxy: string): Promise<ApiResult> {
    const dispatcher = buildDispatcher(proxy);
    const debug = process.env.CHECK_PLUS_DEBUG === "1";

    try {
        const res = await fetch(ACCOUNTS_CHECK_URL, {
            method: "GET",
            headers: {
                authorization: `Bearer ${token}`,
                "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
                "oai-language": "en-US",
                accept: "*/*",
            },
            // @ts-ignore  undici 的 dispatcher 选项
            dispatcher,
        });
        const body = await res.text();
        if (debug) {
            console.error(`[DEBUG] /accounts/check status=${res.status}`);
            console.error(`[DEBUG] body (first 2000): ${body.slice(0, 2000)}`);
        }

        if (res.status === 401 || res.status === 403) {
            const lower = body.toLowerCase();
            if (lower.includes("<html") || lower.includes("challenge") || lower.includes("cloudflare")) {
                return {plan: "blocked", error: `${res.status} cloudflare`};
            }
            return {plan: "error", error: `${res.status} ${body.slice(0, 120)}`};
        }

        let data: any;
        try {
            data = JSON.parse(body);
        } catch {
            const lower = body.toLowerCase();
            if (lower.includes("<html") || lower.includes("challenge")) {
                return {plan: "blocked", error: "non-JSON cloudflare"};
            }
            return {plan: "error", error: `non-JSON: ${body.slice(0, 120)}`};
        }

        const raw = extractPlan(data);
        const meta = extractSubMeta(data);
        if (debug) console.error(`[DEBUG] extractedPlan=${raw ?? "(none)"} meta=${JSON.stringify(meta)}`);

        if (!raw) return {plan: "free", raw: "", ...meta};

        const norm = normalizePlan(raw);
        return {plan: norm, raw, ...meta};
    } catch (e) {
        return {plan: "error", error: (e as Error).message};
    }
}

// 把 OpenAI 的 plan 字段挖出来,优先返回最具体的(plus/pro/team/...);否则返回 free
function extractPlan(data: any): string {
    if (!data || typeof data !== "object") return "";
    const candidates: string[] = [];

    const accs = data.accounts;
    if (accs && typeof accs === "object") {
        for (const key of Object.keys(accs)) {
            const a = accs[key];
            if (!a || typeof a !== "object") continue;
            // 直接 plan_type
            const acc = a.account;
            if (acc && typeof acc === "object") {
                if (typeof acc.plan_type === "string") candidates.push(acc.plan_type);
                if (typeof acc.subscription_plan === "string") candidates.push(acc.subscription_plan);
            }
            // entitlement
            const ent = a.entitlement;
            if (ent && typeof ent === "object") {
                if (typeof ent.subscription_plan === "string") candidates.push(ent.subscription_plan);
                if (typeof ent.plan_type === "string") candidates.push(ent.plan_type);
            }
            // last_active_subscription
            const last = a.last_active_subscription;
            if (last && typeof last === "object") {
                if (typeof last.subscription_plan === "string") candidates.push(last.subscription_plan);
                if (typeof last.plan_type === "string") candidates.push(last.plan_type);
            }
            // a.plan
            const planObj = a.plan;
            if (typeof planObj === "string") candidates.push(planObj);
            else if (planObj && typeof planObj === "object") {
                if (typeof planObj.name === "string") candidates.push(planObj.name);
                if (typeof planObj.type === "string") candidates.push(planObj.type);
            }
        }
    }
    if (typeof data.plan_type === "string") candidates.push(data.plan_type);
    if (typeof data.chatgpt_plan_type === "string") candidates.push(data.chatgpt_plan_type);

    // 找第一个非 free 的;否则返回第一个非空的
    const nonFree = candidates.find((s) => s && !/^free$/i.test(s) && !/^chatgptfree/i.test(s));
    return (nonFree || candidates.find((s) => s) || "").trim();
}

// 从 /accounts/check 里抽订阅的元信息(过期时间/续订/欠费等)
function extractSubMeta(data: any): {expiresAt?: string; willRenew?: boolean | null; cancelsAt?: string | null; delinquent?: boolean} {
    if (!data || typeof data !== "object") return {};
    const accs = data.accounts;
    if (!accs || typeof accs !== "object") return {};

    // 优先看有 active subscription 的 account,其次看 default,最后取第一个
    const candidates: any[] = [];
    for (const key of Object.keys(accs)) {
        const a = accs[key];
        if (!a || typeof a !== "object") continue;
        const ent = a.entitlement;
        if (ent && ent.has_active_subscription === true) candidates.unshift(a);
        else candidates.push(a);
    }
    const a = candidates[0];
    if (!a) return {};

    const ent = a.entitlement ?? {};
    const last = a.last_active_subscription ?? {};
    return {
        expiresAt: typeof ent.expires_at === "string" ? ent.expires_at : undefined,
        willRenew: typeof last.will_renew === "boolean" ? last.will_renew : null,
        cancelsAt: typeof ent.cancels_at === "string" ? ent.cancels_at : null,
        delinquent: ent.is_delinquent === true,
    };
}

// 把各种"chatgptplusplan" / "plus_subscription" / "plus" 等统一成 plus/pro/team/enterprise/free
function normalizePlan(raw: string): string {
    const s = raw.toLowerCase();
    if (s.includes("plus")) return "plus";
    if (s.includes("pro")) return "pro";
    if (s.includes("team")) return "team";
    if (s.includes("enterprise")) return "enterprise";
    if (s.includes("free")) return "free";
    return raw;
}

function loadDefaultProxy(): string {
    if (process.env.PROBE_PROXY) return process.env.PROBE_PROXY;
    try {
        const cwd = process.cwd();
        const projectRoot = path.basename(cwd) === "codex_register" && path.basename(path.dirname(cwd)) === "codexrigester"
            ? path.resolve(cwd, "..", "..")
            : path.resolve(cwd, "..");
        const cfgPath = path.join(projectRoot, "config.json");
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        return cfg.proxy_jp ?? cfg.proxy_us ?? "";
    } catch {
        return "";
    }
}

const COLORS = {
    green: "\x1b[32m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
};

function colorPlan(plan: string): string {
    switch (plan) {
        case "plus":
        case "pro":
        case "team":
        case "enterprise":
            return `${COLORS.green}${COLORS.bold}${plan}${COLORS.reset}`;
        case "free":
            return `${COLORS.dim}free${COLORS.reset}`;
        case "expired":
            return `${COLORS.dim}expired${COLORS.reset}`;
        case "blocked":
            return `${COLORS.yellow}blocked${COLORS.reset}`;
        case "error":
            return `${COLORS.red}error${COLORS.reset}`;
        case "invalid":
            return `${COLORS.red}invalid${COLORS.reset}`;
        default:
            return `${COLORS.yellow}${plan}${COLORS.reset}`;
    }
}

interface CheckResult {
    email: string;
    plan: string;
    note?: string;
    expiresAt?: string;
    willRenew?: boolean | null;
    cancelsAt?: string | null;
    delinquent?: boolean;
}

async function checkOne(token: string, jwtOnly: boolean, proxy: string): Promise<CheckResult> {
    const jv = decodeJwt(token);
    if (!jv) return {email: "(invalid)", plan: "invalid"};

    const now = Math.floor(Date.now() / 1000);
    const expired = jv.exp > 0 && now > jv.exp;

    if (jwtOnly) {
        if (expired) return {email: jv.email, plan: "expired"};
        return {email: jv.email, plan: normalizePlan(jv.plan || "free")};
    }

    if (expired) return {email: jv.email, plan: "expired"};

    const api = await fetchPlan(token, proxy);
    if (api.plan === "error") return {email: jv.email, plan: "error", note: api.error};
    if (api.plan === "blocked") return {email: jv.email, plan: "blocked", note: api.error};
    return {
        email: jv.email,
        plan: api.plan,
        expiresAt: api.expiresAt,
        willRenew: api.willRenew,
        cancelsAt: api.cancelsAt,
        delinquent: api.delinquent,
    };
}

function formatLine(r: CheckResult, idx?: number): string {
    const idxLbl = idx != null ? `${COLORS.dim}#${idx}${COLORS.reset} ` : "";
    const note = r.note ? ` ${COLORS.dim}(${r.note})${COLORS.reset}` : "";
    const emailPad = r.email.padEnd(40);
    const planLbl = colorPlan(r.plan);

    // 如果有订阅信息,加 expires=YYYY-MM-DD (Nd)  willRenew/cancels/delinquent
    let suffix = "";
    if (r.expiresAt) {
        const date = formatDate(r.expiresAt);
        const days = daysUntil(r.expiresAt);
        const daysStr = days == null ? "" : ` ${daysColor(days)}`;
        suffix += ` ${COLORS.dim}exp=${COLORS.reset}${date}${daysStr}`;
    }
    if (r.cancelsAt) {
        suffix += ` ${COLORS.yellow}cancels=${formatDate(r.cancelsAt)}${COLORS.reset}`;
    } else if (r.willRenew === false) {
        suffix += ` ${COLORS.yellow}(不会续订)${COLORS.reset}`;
    }
    if (r.delinquent) {
        suffix += ` ${COLORS.red}DELINQUENT${COLORS.reset}`;
    }

    return `${idxLbl}${emailPad}  ${planLbl}${suffix}${note}`;
}

function formatDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function daysUntil(iso: string): number | null {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const ms = d.getTime() - Date.now();
    return Math.round(ms / 86_400_000);
}

function daysColor(days: number): string {
    if (days < 0) return `${COLORS.red}(已过期 ${Math.abs(days)}d)${COLORS.reset}`;
    if (days <= 3) return `${COLORS.red}(${days}d)${COLORS.reset}`;
    if (days <= 7) return `${COLORS.yellow}(${days}d)${COLORS.reset}`;
    return `${COLORS.dim}(${days}d)${COLORS.reset}`;
}

async function main() {
    const args = process.argv.slice(2);
    let file = "";
    let token = "";
    let jwtOnly = process.env.JWT_ONLY === "1";

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-f" || a === "--file") {
            file = args[++i] ?? "";
        } else if (a === "--jwt-only") {
            jwtOnly = true;
        } else if (a === "-") {
            token = readFileSync(0, "utf8").trim();
        } else {
            token = a;
        }
    }

    const proxy = loadDefaultProxy();

    if (file) {
        const raw = readFileSync(file, "utf8");
        const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
        const totals: Record<string, number> = {};
        let i = 0;
        for (const line of lines) {
            i += 1;
            const r = await checkOne(line, jwtOnly, proxy);
            console.log(formatLine(r, i));
            totals[r.plan] = (totals[r.plan] ?? 0) + 1;
        }
        const summary = Object.entries(totals)
            .sort()
            .map(([k, v]) => `${k}=${v}`)
            .join(" ");
        console.log(`\n${COLORS.dim}─── 共 ${i} 条 | ${summary} ───${COLORS.reset}`);
        return;
    }

    if (!token) {
        console.error("用法: tsx src/check-plus.ts <token>|-f <file>|-");
        process.exit(1);
    }
    console.log(formatLine(await checkOne(token, jwtOnly, proxy)));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
