// sentinel-cli — 独立生成 ChatGPT openai-sentinel-token (POW + turnstile)。
//
// 给 pplink (Go) 调用: pplink 需要在 createCheckout / approve 时带这个 header,
// 否则被风控判 bot → blocked。本工具复用 src/sentinel.ts 的完整解算器。
//
// 用法:
//   tsx src/sentinel-cli.ts --flow chatgpt_checkout --device <oai-did> \
//        --proxy "socks5://user:pass@host:port" \
//        [--ua "<UA>"] [--endpoint https://chatgpt.com/backend-api/sentinel/req] \
//        [--st]   (走浏览器解算, 更稳但需 Playwright)
//
// stdout: 仅输出 token 字符串 (JSON: {"p":...,"t":...,"c":...,"id":...,"flow":...})
// stderr: 调试日志
//
// 退出码: 0 成功, 1 失败。

// 强制 console.log/warn/info 都写 stderr, 保证 stdout 只有 token 本体
const _origLog = console.log;
const _origWarn = console.warn;
const _origInfo = console.info;
console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
console.warn = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
console.info = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");

import * as net from "node:net";
import * as tls from "node:tls";
import {Agent, fetch as undiciFetch, type Dispatcher} from "undici";
import {SocksClient} from "socks";
import {fetchSentinelToken} from "./sentinel.js";
import {closeSentinelBrowser} from "./sentinel-browser.js";

function arg(name: string, def = ""): string {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
    return def;
}

const DEFAULT_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function isSocks(protocol: string): boolean {
    return ["socks4:", "socks4a:", "socks5:", "socks5h:"].includes(protocol);
}

async function createSocksSocket(proxyUrl: URL, options: Record<string, any>): Promise<net.Socket> {
    const destHost = String(options.hostname ?? "");
    const destPort =
        options.port == null || options.port === ""
            ? options.protocol === "https:"
                ? 443
                : 80
            : Number(options.port);
    const proxyPort = Number(proxyUrl.port || 1080);
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

function buildDispatcher(proxy: string): Dispatcher {
    if (!proxy) {
        return new Agent({connectTimeout: 20_000, headersTimeout: 30_000, bodyTimeout: 30_000});
    }
    const u = new URL(proxy);
    if (isSocks(u.protocol)) {
        return new Agent({
            connect: (opts: any, cb: any) => {
                createSocksSocket(u, opts)
                    .then((s) => cb(null, s))
                    .catch(cb);
            },
            connectTimeout: 20_000,
            headersTimeout: 30_000,
            bodyTimeout: 30_000,
        });
    }
    // http(s) 代理: 直接用 ProxyAgent 形式不在这里支持, socks 为主
    return new Agent({connectTimeout: 20_000, headersTimeout: 30_000, bodyTimeout: 30_000});
}

async function main() {
    const flow = arg("flow", "chatgpt_checkout");
    const device = arg("device") || crypto.randomUUID();
    const proxy = arg("proxy");
    const ua = arg("ua", DEFAULT_UA);
    const endpoint = arg("endpoint", "https://chatgpt.com/backend-api/sentinel/req");

    const dispatcher = buildDispatcher(proxy);

    // 包一层 fetch, 把 dispatcher 绑进去 (sentinel.ts 调用时不传 dispatcher)
    const boundFetch = ((input: any, init: any = {}) =>
        undiciFetch(input, {...init, dispatcher} as any)) as unknown as typeof fetch;

    process.stderr.write(`[sentinel-cli] flow=${flow} device=${device} endpoint=${endpoint} proxy=${proxy ? "yes" : "no"}\n`);

    const token = await fetchSentinelToken({
        flow,
        deviceID: device,
        fetch: boundFetch,
        reqEndpoint: endpoint,
        userAgent: ua,
    });

    // 只把 token 写到 stdout
    process.stdout.write(token);
    try {
        await (dispatcher as any).close?.();
    } catch {
        // ignore
    }
    await closeSentinelBrowser();
}

main().catch((err) => {
    process.stderr.write(`[sentinel-cli] ERROR: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    void closeSentinelBrowser().finally(() => process.exit(1));
});
