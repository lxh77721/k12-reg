import {
  Agent,
  ProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from "undici";
import type {
  SmsActivation,
  SmsProvider,
  SmsVerificationCode,
} from "./provider.js";

const HERO_SMS_DEFAULT_BASE_URL = "https://hero-sms.com/stubs/handler_api.php";
const HERO_SMS_DEFAULT_POLL_ATTEMPTS = 24;
const HERO_SMS_DEFAULT_POLL_INTERVAL_MS = 5000;
const HERO_SMS_CODE_PATTERN = /(?<!\d)(\d{4,8})(?!\d)/;

interface DeliveredActivationSnapshot {
  activationStatus: string;
  smsCode?: string;
  smsText?: string;
  repeated?: number;
}

interface HeroSmsActiveActivation {
  activationId?: string | number;
  activationStatus?: string;
  smsCode?: string;
  smsText?: string;
  repeated?: string | number;
  canGetAnotherSms?: string | number | boolean;
}

interface HeroSmsActiveActivationsPayload {
  status?: string;
  data?: HeroSmsActiveActivation[];
}

export type HeroSmsActivationStatusCode = 1 | 3 | 6 | 8;

export interface HeroSmsProviderConfig {
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;
  defaultRequestOptions?: HeroSmsNumberRequestOptions;
  defaultWaitForCodeOptions?: HeroSmsWaitForCodeOptions;
}

export interface HeroSmsNumberRequestOptions {
  service: string;
  country: number;
  operator?: string | string[];
  maxPrice?: number;
  fixedPrice?: boolean;
  ref?: string;
  phoneException?: string | string[];
}

export interface HeroSmsActivation extends SmsActivation {
  activationId: string;
  phoneNumber: string;
  expiresAt?: Date;
  activationCost?: number;
  currency?: number;
  countryCode?: number;
  countryPhoneCode?: number;
  canGetAnotherSms?: boolean;
  activationTime?: Date;
  activationEndTime?: Date;
  activationOperator?: string;
}

export interface HeroSmsStatusPayload {
  verificationType?: number;
  sms?: {
    dateTime?: string;
    code?: string;
    text?: string;
  };
  call?: {
    from?: string;
    text?: string;
    code?: string;
    dateTime?: string;
    url?: string;
    parsingCount?: number;
  };
}

export interface HeroSmsVerificationCode extends SmsVerificationCode {
  code: string;
  source: "sms" | "call" | "status";
  text?: string;
  receivedAt?: Date;
  verificationType?: number;
  rawStatus: unknown;
}

export interface HeroSmsWaitForCodeOptions {
  markReady?: boolean;
  completeOnCode?: boolean;
  pollAttempts?: number;
  pollIntervalMs?: number;
}

export interface HeroSmsAcquireAndWaitOptions extends HeroSmsWaitForCodeOptions {
  cancelOnError?: boolean;
}

export interface HeroSmsProvider extends SmsProvider<
  HeroSmsActivation,
  HeroSmsVerificationCode
> {
  requestActivation(): Promise<HeroSmsActivation>;
  requestPhoneNumber(
    options: HeroSmsNumberRequestOptions,
  ): Promise<HeroSmsActivation>;
  markActivationReady(activationId: string | number): Promise<string>;
  completeActivation(activationId: string | number): Promise<string>;
  cancelAndWithdraw(activationId: string | number): Promise<string>;
  cancelActivation(activationId: string | number): Promise<string>;
  getActivationStatus(activationId: string | number): Promise<string>;
  getActivationStatusV2(
    activationId: string | number,
  ): Promise<string | HeroSmsStatusPayload>;
  waitForVerificationCode(
    activationId: string | number,
    options?: HeroSmsWaitForCodeOptions,
  ): Promise<HeroSmsVerificationCode>;
}

interface HeroSmsApiErrorPayload {
  title?: string;
  details?: string;
  info?: unknown;
}

export class HeroSmsApiError extends Error {
  readonly action: string;
  readonly httpStatus?: number;
  readonly payload: unknown;

  constructor(
    action: string,
    message: string,
    options: { httpStatus?: number; payload?: unknown } = {},
  ) {
    super(message);
    this.name = "HeroSmsApiError";
    this.action = action;
    this.httpStatus = options.httpStatus;
    this.payload = options.payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ensureApiKeyConfigured(config: HeroSmsProviderConfig): string {
  const apiKey = String(config.apiKey ?? "").trim();
  if (!apiKey) {
    throw new Error("HeroSMS apiKey 未配置");
  }
  return apiKey;
}

function ensureDefaultRequestOptionsConfigured(
  config: HeroSmsProviderConfig,
): HeroSmsNumberRequestOptions {
  if (!config.defaultRequestOptions) {
    throw new Error(
      "HeroSMS defaultRequestOptions 未配置，无法通过通用 SmsProvider 接口申请 activation",
    );
  }

  return config.defaultRequestOptions;
}

function normalizeBaseUrl(config: HeroSmsProviderConfig): string {
  const baseUrl = String(config.baseUrl ?? HERO_SMS_DEFAULT_BASE_URL).trim();
  if (!baseUrl) {
    throw new Error("HeroSMS baseUrl 未配置");
  }
  return baseUrl;
}

function buildDispatcher(config: HeroSmsProviderConfig): Dispatcher {
  const proxyUrl = String(config.proxyUrl ?? "").trim();
  return proxyUrl
    ? new ProxyAgent({
      uri: proxyUrl,
      requestTls: { rejectUnauthorized: false },
    })
    : new Agent({
      connect: { rejectUnauthorized: false },
    });
}

async function heroSmsFetch(
  config: HeroSmsProviderConfig,
  input: string | URL,
  init: UndiciRequestInit = {},
) {
  return undiciFetch(input, {
    ...init,
    dispatcher: buildDispatcher(config),
  } satisfies UndiciRequestInit);
}

function normalizeListValue(value?: string | string[]): string | undefined {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean);
    return items.length > 0 ? items.join(",") : undefined;
  }

  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function setOptionalQuery(
  searchParams: URLSearchParams,
  key: string,
  value: unknown,
) {
  if (value == null) {
    return;
  }

  if (typeof value === "boolean") {
    searchParams.set(key, value ? "true" : "false");
    return;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return;
  }

  searchParams.set(key, normalized);
}

async function readResponseBody(response: UndiciResponse): Promise<unknown> {
  const text = (await response.text()).trim();
  if (!text) {
    return "";
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "true" || normalized === "1") {
    return true;
  }

  if (normalized === "false" || normalized === "0") {
    return false;
  }

  return undefined;
}

function isApiErrorPayload(value: unknown): value is HeroSmsApiErrorPayload {
  return isRecord(value) && ("title" in value || "details" in value);
}

function isFailureString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  if (normalized.startsWith("ACCESS_") || normalized.startsWith("STATUS_")) {
    return false;
  }

  return (
    normalized.startsWith("BAD_") ||
    normalized.startsWith("NO_") ||
    normalized.startsWith("WRONG_") ||
    normalized.startsWith("ERROR_") ||
    normalized.startsWith("BANNED") ||
    normalized === "CHANNELS_LIMIT" ||
    normalized === "OPERATORS_NOT_FOUND" ||
    normalized === "EARLY_CANCEL_DENIED"
  );
}

function formatPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (isApiErrorPayload(payload)) {
    const title = String(payload.title ?? "").trim();
    const details = String(payload.details ?? "").trim();
    return [title, details].filter(Boolean).join(": ");
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function createApiError(
  action: string,
  payload: unknown,
  httpStatus?: number,
): HeroSmsApiError {
  const message = `HeroSMS ${action} 请求失败: ${formatPayload(payload)}`;
  return new HeroSmsApiError(action, message, { httpStatus, payload });
}

async function requestHeroSmsApi(
  config: HeroSmsProviderConfig,
  action: string,
  query: Record<string, unknown> = {},
): Promise<unknown> {
  const url = new URL(normalizeBaseUrl(config));
  url.searchParams.set("api_key", ensureApiKeyConfigured(config));
  url.searchParams.set("action", action);

  for (const [key, value] of Object.entries(query)) {
    setOptionalQuery(url.searchParams, key, value);
  }

  const response = await heroSmsFetch(config, url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    },
  });

  const payload = await readResponseBody(response);

  if (!response.ok) {
    throw createApiError(action, payload, response.status);
  }

  if (isApiErrorPayload(payload) || isFailureString(payload)) {
    throw createApiError(action, payload, response.status);
  }

  return payload;
}

function ensureServiceConfigured(options: HeroSmsNumberRequestOptions): string {
  const service = String(options.service ?? "").trim();
  if (!service) {
    throw new Error("HeroSMS service 未配置");
  }
  return service;
}

function ensureCountryConfigured(options: HeroSmsNumberRequestOptions): number {
  const country = Number(options.country);
  if (!Number.isFinite(country)) {
    throw new Error("HeroSMS country 未配置或格式不正确");
  }
  return country;
}

function normalizeActivationId(activationId: string | number): string {
  const normalized = String(activationId ?? "").trim();
  if (!normalized) {
    throw new Error("HeroSMS activationId 不能为空");
  }
  return normalized;
}

function parseHeroSmsDate(value: unknown): Date | undefined {
  if (value == null) {
    return undefined;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? new Date(value.getTime())
      : undefined;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return undefined;
    }

    const timestamp = Math.abs(value) < 1e12 ? value * 1000 : value;
    const parsed = new Date(timestamp);
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return undefined;
  }

  if (/^\d+$/.test(normalized)) {
    const numericValue = Number(normalized);
    if (!Number.isFinite(numericValue)) {
      return undefined;
    }

    const timestamp =
      normalized.length <= 10 ? numericValue * 1000 : numericValue;
    const parsed = new Date(timestamp);
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
  }

  const heroUtcMatch = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
  );
  if (heroUtcMatch) {
    const [, year, month, day, hour, minute, second] = heroUtcMatch;
    return new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ),
    );
  }

  const parsedTimestamp = Date.parse(normalized);
  if (!Number.isFinite(parsedTimestamp)) {
    return undefined;
  }

  return new Date(parsedTimestamp);
}

function normalizeActivation(payload: unknown): HeroSmsActivation {
  if (!isRecord(payload)) {
    throw new Error(
      `HeroSMS getNumberV2 返回格式异常: ${formatPayload(payload)}`,
    );
  }

  const activationId = String(payload.activationId ?? "").trim();
  const phoneNumber = String(payload.phoneNumber ?? "").trim();

  if (!activationId || !phoneNumber) {
    throw new Error(
      `HeroSMS getNumberV2 返回缺少 activationId 或 phoneNumber: ${formatPayload(payload)}`,
    );
  }

  return {
    activationId,
    phoneNumber,
    expiresAt: parseHeroSmsDate(payload.activationEndTime),
    canRequestAnotherSms: parseOptionalBoolean(payload.canGetAnotherSms),
    activationCost:
      payload.activationCost == null
        ? undefined
        : Number(payload.activationCost),
    currency: payload.currency == null ? undefined : Number(payload.currency),
    countryCode:
      payload.countryCode == null ? undefined : Number(payload.countryCode),
    countryPhoneCode:
      payload.countryPhoneCode == null
        ? undefined
        : Number(payload.countryPhoneCode),
    canGetAnotherSms: parseOptionalBoolean(payload.canGetAnotherSms),
    activationTime: parseHeroSmsDate(payload.activationTime),
    activationEndTime: parseHeroSmsDate(payload.activationEndTime),
    activationOperator:
      payload.activationOperator == null
        ? undefined
        : String(payload.activationOperator),
  };
}

function normalizeStatusPayload(
  payload: unknown,
): string | HeroSmsStatusPayload {
  if (typeof payload === "string") {
    return payload.trim();
  }

  if (isRecord(payload)) {
    return payload as HeroSmsStatusPayload;
  }

  throw new Error(`HeroSMS 状态返回格式异常: ${formatPayload(payload)}`);
}

function extractCodeFromText(text?: string): string | undefined {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return undefined;
  }

  const matched = normalized.match(HERO_SMS_CODE_PATTERN);
  return matched?.[1];
}

function extractCodeFromStatusPayload(
  payload: string | HeroSmsStatusPayload,
): HeroSmsVerificationCode | null {
  if (typeof payload === "string") {
    if (payload.startsWith("STATUS_OK:")) {
      const text = payload.slice("STATUS_OK:".length).trim();
      const code = extractCodeFromText(text) ?? text;
      if (!code) {
        return null;
      }

      return {
        code,
        source: "status",
        text,
        rawStatus: payload,
      };
    }

    return null;
  }

  const smsCode =
    String(payload.sms?.code ?? "").trim() ||
    extractCodeFromText(payload.sms?.text);
  if (smsCode) {
    return {
      code: smsCode,
      source: "sms",
      text: payload.sms?.text,
      receivedAt: parseHeroSmsDate(payload.sms?.dateTime),
      verificationType: payload.verificationType,
      rawStatus: payload,
    };
  }

  const callCode =
    String(payload.call?.code ?? "").trim() ||
    extractCodeFromText(payload.call?.text);
  if (callCode) {
    return {
      code: callCode,
      source: "call",
      text: payload.call?.text,
      receivedAt: parseHeroSmsDate(payload.call?.dateTime),
      verificationType: payload.verificationType,
      rawStatus: payload,
    };
  }

  return null;
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeActiveActivationSnapshot(
  payload: HeroSmsActiveActivation,
): DeliveredActivationSnapshot {
  return {
    activationStatus: String(payload.activationStatus ?? "").trim(),
    smsCode: String(payload.smsCode ?? "").trim() || undefined,
    smsText: String(payload.smsText ?? "").trim() || undefined,
    repeated: parseOptionalInteger(payload.repeated),
  };
}

function isFreshActiveActivationSnapshot(
  previous: DeliveredActivationSnapshot | undefined,
  current: DeliveredActivationSnapshot,
): boolean {
  // Based on current HeroSMS web-app traffic:
  // activationStatus=2 means a code has been received,
  // activationStatus=3 means still waiting for a new code.
  if (current.activationStatus !== "2") {
    return false;
  }

  if (!current.smsCode && !current.smsText) {
    return false;
  }

  if (!previous) {
    return true;
  }

  if (
    current.repeated != null &&
    previous.repeated != null &&
    current.repeated > previous.repeated
  ) {
    return true;
  }

  if (current.smsCode && current.smsCode !== previous.smsCode) {
    return true;
  }

  if (current.smsText && current.smsText !== previous.smsText) {
    return true;
  }

  if (current.activationStatus !== previous.activationStatus) {
    return true;
  }

  return false;
}

function buildVerificationFromActiveActivation(
  activation: HeroSmsActiveActivation,
): HeroSmsVerificationCode | null {
  const snapshot = normalizeActiveActivationSnapshot(activation);
  if (!snapshot.smsCode && !snapshot.smsText) {
    return null;
  }

  const code = snapshot.smsCode ?? extractCodeFromText(snapshot.smsText);
  if (!code) {
    return null;
  }

  return {
    code,
    source: "sms",
    text: snapshot.smsText,
    rawStatus: activation,
  };
}

async function fetchActiveActivation(
  config: HeroSmsProviderConfig,
  activationId: string,
): Promise<HeroSmsActiveActivation | null> {
  const payload = await requestHeroSmsApi(config, "getActiveActivations", {
    start: 0,
    limit: 100,
  });

  if (!isRecord(payload)) {
    throw new Error(
      `HeroSMS getActiveActivations 返回格式异常: ${formatPayload(payload)}`,
    );
  }

  const data = (payload as HeroSmsActiveActivationsPayload).data;
  if (!Array.isArray(data)) {
    throw new Error(
      `HeroSMS getActiveActivations 返回缺少 data 数组: ${formatPayload(payload)}`,
    );
  }

  const matched = data.find((item) => {
    const itemActivationId = String(item?.activationId ?? "").trim();
    return itemActivationId === activationId;
  });

  return matched ?? null;
}

function resolvePollAttempts(
  config: HeroSmsProviderConfig,
  options?: HeroSmsWaitForCodeOptions,
): number {
  const attempts =
    options?.pollAttempts ??
    config.pollAttempts ??
    HERO_SMS_DEFAULT_POLL_ATTEMPTS;
  return attempts > 0 ? Math.floor(attempts) : HERO_SMS_DEFAULT_POLL_ATTEMPTS;
}

function resolvePollIntervalMs(
  config: HeroSmsProviderConfig,
  options?: HeroSmsWaitForCodeOptions,
): number {
  const intervalMs =
    options?.pollIntervalMs ??
    config.pollIntervalMs ??
    HERO_SMS_DEFAULT_POLL_INTERVAL_MS;
  return intervalMs > 0
    ? Math.floor(intervalMs)
    : HERO_SMS_DEFAULT_POLL_INTERVAL_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createHeroSmsProvider(config: HeroSmsProviderConfig) {
  ensureApiKeyConfigured(config);
  const deliveredActivationSnapshotById = new Map<
    string,
    DeliveredActivationSnapshot
  >();

  const provider: HeroSmsProvider = {
    async requestActivation(): Promise<HeroSmsActivation> {
      return provider.requestPhoneNumber(
        ensureDefaultRequestOptionsConfigured(config),
      );
    },

    async requestPhoneNumber(
      options: HeroSmsNumberRequestOptions,
    ): Promise<HeroSmsActivation> {
      const payload = await requestHeroSmsApi(config, "getNumberV2", {
        service: ensureServiceConfigured(options),
        country: ensureCountryConfigured(options),
        operator: normalizeListValue(options.operator),
        maxPrice: options.maxPrice,
        fixedPrice: options.fixedPrice,
        ref: options.ref,
        phoneException: normalizeListValue(options.phoneException),
      });

      return normalizeActivation(payload);
    },

    async markActivationReady(activationId: string | number): Promise<string> {
      const payload = await requestHeroSmsApi(config, "setStatus", {
        id: normalizeActivationId(activationId),
        status: 1,
      });

      return String(payload);
    },

    async requestAnotherSms(activationId: string | number): Promise<string> {
      const payload = await requestHeroSmsApi(config, "setStatus", {
        id: normalizeActivationId(activationId),
        status: 3,
      });

      return String(payload);
    },

    async completeActivation(activationId: string | number): Promise<string> {
      const normalizedActivationId = normalizeActivationId(activationId);
      const payload = await requestHeroSmsApi(config, "setStatus", {
        id: normalizedActivationId,
        status: 6,
      });
      deliveredActivationSnapshotById.delete(normalizedActivationId);

      return String(payload);
    },

    async cancelAndWithdraw(activationId: string | number): Promise<string> {
      const normalizedActivationId = normalizeActivationId(activationId);
      const payload = await requestHeroSmsApi(config, "setStatus", {
        id: normalizedActivationId,
        status: 8,
      });
      deliveredActivationSnapshotById.delete(normalizedActivationId);

      return String(payload);
    },

    async cancelActivation(activationId: string | number): Promise<string> {
      return provider.cancelAndWithdraw(activationId);
    },

    async getActivationStatus(activationId: string | number): Promise<string> {
      const payload = await requestHeroSmsApi(config, "getStatus", {
        id: normalizeActivationId(activationId),
      });

      return String(payload).trim();
    },

    async getActivationStatusV2(
      activationId: string | number,
    ): Promise<string | HeroSmsStatusPayload> {
      const payload = await requestHeroSmsApi(config, "getStatusV2", {
        id: normalizeActivationId(activationId),
      });

      return normalizeStatusPayload(payload);
    },

    async waitForVerificationCode(
      activationId: string | number,
      options: HeroSmsWaitForCodeOptions = {},
    ): Promise<HeroSmsVerificationCode> {
      const normalizedActivationId = normalizeActivationId(activationId);
      const lastDeliveredActivationSnapshot =
        deliveredActivationSnapshotById.get(normalizedActivationId);
      const waitOptions = {
        ...config.defaultWaitForCodeOptions,
        ...options,
      };
      const shouldMarkReady = waitOptions.markReady ?? false;
      const shouldCompleteOnCode = waitOptions.completeOnCode ?? false;
      const pollAttempts = resolvePollAttempts(config, waitOptions);
      const pollIntervalMs = resolvePollIntervalMs(config, waitOptions);
      let lastStatus: unknown;

      if (shouldMarkReady) {
        await provider.markActivationReady(normalizedActivationId);
      }

      for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
        console.log(`[pollSMSCode]: attempt:${attempt}/${pollAttempts}`);
        // 这基于一个假设，heroSMS 不会同时有太多正在激活的 activation（小于 20），这样可以精确获取状态
        const activeActivation = await fetchActiveActivation(
          config,
          normalizedActivationId,
        );
        lastStatus = activeActivation;
        const statusCode = activeActivation?.activationStatus
        console.log(`[pollSMSCode]: ${statusCode === '2' ? '已收到' : '等待验证码' }`,);
        if (activeActivation) {
          const activeSnapshot =
            normalizeActiveActivationSnapshot(activeActivation);
          if (
            isFreshActiveActivationSnapshot(
              lastDeliveredActivationSnapshot,
              activeSnapshot,
            )
          ) {
            const verification =
              buildVerificationFromActiveActivation(activeActivation);
            if (verification) {
              deliveredActivationSnapshotById.set(
                normalizedActivationId,
                activeSnapshot,
              );
              if (shouldCompleteOnCode) {
                await provider.completeActivation(normalizedActivationId);
              }
              return verification;
            }
          }
        }

        const statusV2 = await provider.getActivationStatusV2(
          normalizedActivationId,
        );
        const codeFromV2 = extractCodeFromStatusPayload(statusV2);
        if (codeFromV2 && !activeActivation) {
          if (!lastDeliveredActivationSnapshot) {
            deliveredActivationSnapshotById.set(normalizedActivationId, {
              activationStatus: "2",
              smsCode: codeFromV2.code,
              smsText: codeFromV2.text,
            });
            if (shouldCompleteOnCode) {
              await provider.completeActivation(normalizedActivationId);
            }
            return codeFromV2;
          }
        }

        const status = await provider.getActivationStatus(
          normalizedActivationId,
        );
        lastStatus = status;

        const codeFromStatus = extractCodeFromStatusPayload(status);
        if (codeFromStatus) {
          if (!lastDeliveredActivationSnapshot) {
            if (shouldCompleteOnCode) {
              await provider.completeActivation(normalizedActivationId);
            }
            return codeFromStatus;
          }
        }

        if (status === "STATUS_CANCEL") {
          throw new Error(
            `HeroSMS 激活已取消: activationId=${normalizedActivationId}`,
          );
        }

        if (attempt < pollAttempts) {
          await delay(pollIntervalMs);
        }
      }
      throw new Error(
        `HeroSMS 长时间未收到验证码: activationId=${normalizedActivationId} lastStatus=${formatPayload(lastStatus)}`,
      );
    },
  };

  return provider;
}
