// 在 phone signup 之后、绑邮箱/OAuth 之前探测试用资格。
// 思路：
//   1. signupClient 已经持有 phone signup callbackURL，用 signupClient.fetch GET 一下
//      让 OAuth 回调把 chatgpt.com cookie 写进 jar；
//   2. signupClient.getChatGPTAccessToken() 拿到 ChatGPT access_token；
//   3. 用 access_token + 单独的 JP 代理 dispatcher 打
//      chatgpt.com/backend-api/payments/checkout，看返回里的 amount_due。
//      返回 0 → 有试用；非 0 / 400 checkout_amount_mismatch → 无试用。
//
// 设计要点：探测请求绝不能走 codex 的 US 代理（IP 决定试用资格），
// 用一个本函数私有的 JP dispatcher，调用一次后立即销毁。
// 全局 dispatcher（US）保留不动，方便后续 OAuth 继续走 US。

import {Agent, ProxyAgent, type Dispatcher} from "undici";

export interface ProbeTrialOptions {
    accessToken: string;
    /** JP 代理 URL，比如 socks5://user:pass@host:port 或 http://... */
    proxyJP: string;
    /** 可选超时（ms），默认 30s */
    timeoutMs?: number;
}

export interface ProbeTrialResult {
    hasTrial: boolean;
    reason: string;
    amount?: number;
    currency?: string;
    rawStatus?: number;
    rawSnippet?: string;
}

const CHECKOUT_URL = "https://chatgpt.com/backend-api/payments/checkout";
const STRIPE_INIT_TPL = (csID: string) => `https://api.stripe.com/v1/payment_pages/${csID}/init`;
const STRIPE_PK = "pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRacViovU3kLKvpkjh7IqkW00iXQsjo3n";
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

function buildJPDispatcher(proxyJP: string): Dispatcher {
    if (proxyJP) {
        return new ProxyAgent({
            uri: proxyJP,
            requestTls: {rejectUnauthorized: true},
            connectTimeout: 30_000,
            bodyTimeout: 60_000,
            headersTimeout: 30_000,
        });
    }
    return new Agent({
        connectTimeout: 30_000,
        bodyTimeout: 60_000,
        headersTimeout: 30_000,
    });
}

/**
 * 用 JP 代理打一次 chatgpt.com checkout，返回试用资格判定。
 * 成功（返回 cs_xxx + amount_due=0）= 有试用；非 0 / 报错 = 无试用。
 */
export async function probeTrial(opts: ProbeTrialOptions): Promise<ProbeTrialResult> {
    const dispatcher = buildJPDispatcher(opts.proxyJP);
    const timeoutMs = opts.timeoutMs ?? 30_000;

    const body = JSON.stringify({
        entry_point: "all_plans_pricing_modal",
        plan_name: "chatgptplusplan",
        billing_details: {country: "ID", currency: "IDR"},
        promo_campaign: {
            promo_campaign_id: "plus-1-month-free",
            is_coupon_from_query_param: false,
        },
        checkout_ui_mode: "hosted",
        cancel_url: "https://chatgpt.com/#pricing",
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
        const resp = await fetch(CHECKOUT_URL, {
            method: "POST",
            headers: {
                authorization: `Bearer ${opts.accessToken}`,
                "content-type": "application/json",
                "user-agent": DEFAULT_UA,
            },
            body,
            // @ts-ignore – undici dispatcher
            dispatcher,
            signal: ctrl.signal,
        });

        const text = await resp.text();
        const snippet = text.slice(0, 200);

        if (resp.status >= 400) {
            // 400 + already paid / amount_mismatch 都视为无试用
            const lower = text.toLowerCase();
            if (lower.includes("already paid") || lower.includes("amount_mismatch") || lower.includes("amount mismatch")) {
                return {
                    hasTrial: false,
                    reason: `checkout ${resp.status}: ${snippet}`,
                    rawStatus: resp.status,
                    rawSnippet: snippet,
                };
            }
            return {
                hasTrial: false,
                reason: `checkout ${resp.status}: ${snippet}`,
                rawStatus: resp.status,
                rawSnippet: snippet,
            };
        }

        let data: any = {};
        try {
            data = JSON.parse(text);
        } catch {
            return {
                hasTrial: false,
                reason: `checkout 响应非 JSON: ${snippet}`,
                rawStatus: resp.status,
                rawSnippet: snippet,
            };
        }

        const csID = String(data.checkout_session_id ?? data.session_id ?? data.id ?? "");
        if (!csID.startsWith("cs_")) {
            return {
                hasTrial: false,
                reason: `checkout 无 cs_id: ${snippet}`,
                rawStatus: resp.status,
                rawSnippet: snippet,
            };
        }

        // checkout 创建成功 → 紧跟一发 stripe init 拿 amount_due（精确判定）。
        // 同样走 JP 代理（OpenAI 在 Stripe 那边按 IP 关联 checkout session）。
        const initBody = new URLSearchParams({
            "browser_locale": "en-US",
            "browser_timezone": "Asia/Shanghai",
            "elements_session_client[client_betas][0]": "custom_checkout_server_updates_1",
            "elements_session_client[client_betas][1]": "custom_checkout_manual_approval_1",
            "elements_session_client[elements_init_source]": "custom_checkout",
            "elements_session_client[referrer_host]": "chatgpt.com",
            "elements_session_client[stripe_js_id]": cryptoRandomUuid(),
            "elements_session_client[locale]": "en",
            "elements_session_client[is_aggregation_expected]": "false",
            "key": STRIPE_PK,
        }).toString();

        const initResp = await fetch(STRIPE_INIT_TPL(csID), {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                "user-agent": DEFAULT_UA,
            },
            body: initBody,
            // @ts-ignore – undici dispatcher
            dispatcher,
            signal: ctrl.signal,
        });
        const initText = await initResp.text();
        const initSnippet = initText.slice(0, 200);

        let initData: any = {};
        try {
            initData = JSON.parse(initText);
        } catch {
            // init 返回非 JSON 视为模糊成功，让 Go charger 兜底
            return {
                hasTrial: true,
                reason: `checkout 创建成功 cs=${csID.slice(0, 28)}（stripe init 非 JSON: ${initSnippet}）—— 由 Go charger 兜底判定`,
                rawStatus: resp.status,
            };
        }

        const currency = String(initData.currency ?? "").toLowerCase();
        let amount: number | undefined;
        for (const key of ["amount_due", "amount_total", "total_amount_due"]) {
            if (typeof initData[key] === "number") {
                amount = initData[key];
                break;
            }
        }
        if (amount === undefined && initData.invoice && typeof initData.invoice === "object") {
            const v = initData.invoice.amount_due;
            if (typeof v === "number") amount = v;
        }

        if (amount === undefined) {
            return {
                hasTrial: true,
                reason: `stripe init 没暴露金额（cs=${csID.slice(0, 28)}, currency=${currency}），交给 Go charger 兜底`,
                rawStatus: resp.status,
            };
        }
        if (amount === 0) {
            return {
                hasTrial: true,
                reason: `stripe init amount=${amount} ${currency} = 有试用`,
                amount,
                currency,
                rawStatus: resp.status,
            };
        }
        return {
            hasTrial: false,
            reason: `stripe init amount=${amount} ${currency} != 0 = 无试用`,
            amount,
            currency,
            rawStatus: resp.status,
        };
    } finally {
        clearTimeout(timer);
        try {
            await (dispatcher as any).close?.();
        } catch {
            // ignore
        }
    }
}


function cryptoRandomUuid(): string {
    // Node 19+ 有 globalThis.crypto.randomUUID
    const g: any = globalThis;
    if (g?.crypto?.randomUUID) return g.crypto.randomUUID();
    // 兜底：48bit + 64bit hex 拼一个 v4 风格的串
    const hex = (n: number) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, "0");
    return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}
