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

const SMSBOWER_DEFAULT_BASE_URL =
  "https://smsbower.online/stubs/handler_api.php";
const SMSBOWER_DEFAULT_POLL_ATTEMPTS = 24;
const SMSBOWER_DEFAULT_POLL_INTERVAL_MS = 5000;
const SMSBOWER_DEFAULT_ACTIVATION_TTL_MS = 20 * 60 * 1000;
const SMSBOWER_CODE_PATTERN = /(?<!\d)(\d{4,8})(?!\d)/;

export interface SmsBowerProviderConfig {
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;
  activationTtlMs?: number;
  defaultRequestOptions?: SmsBowerNumberRequestOptions;
  defaultWaitForCodeOptions?: SmsBowerWaitForCodeOptions;
}

export interface SmsBowerNumberRequestOptions {
  service: string;
  country: number;
  maxPrice?: number;
  ref?: string;
  providerIds?: string | string[] | number | number[];
  exceptProviderIds?: string | string[] | number | number[];
  phoneException?: string | string[] | number | number[];
}

export interface SmsBowerActivation extends SmsActivation {
  activationId: string;
  phoneNumber: string;
  activationCost?: number;
  countryCode?: number;
  canGetAnotherSms?: boolean;
  activationTime?: Date;
  activationOperator?: string;
}

export interface SmsBowerVerificationCode extends SmsVerificationCode {
  code: string;
  source: "sms" | "status";
  text?: string;
  receivedAt?: Date;
  rawStatus: unknown;
}

export interface SmsBowerWaitForCodeOptions {
  markReady?: boolean;
  completeOnCode?: boolean;
  pollAttempts?: number;
  pollIntervalMs?: number;
}

export interface SmsBowerProvider extends SmsProvider<
  SmsBowerActivation,
  SmsBowerVerificationCode
> {
  requestActivation(): Promise<SmsBowerActivation>;
  requestPhoneNumber(
    options: SmsBowerNumberRequestOptions,
  ): Promise<SmsBowerActivation>;
  markActivationReady(activationId: string | number): Promise<string>;
  completeActivation(activationId: string | number): Promise<string>;
  cancelAndWithdraw(activationId: string | number): Promise<string>;
  cancelActivation(activationId: string | number): Promise<string>;
  getActivationStatus(activationId: string | number): Promise<string>;
  waitForVerificationCode(
    activationId: string | number,
    options?: SmsBowerWaitForCodeOptions,
  ): Promise<SmsBowerVerificationCode>;
}

interface SmsBowerApiErrorPayload {
  status?: unknown;
  message?: string;
  data?: unknown;
}

export class SmsBowerApiError extends Error {
  readonly action: string;
  readonly httpStatus?: number;
  readonly payload: unknown;

  constructor(
    action: string,
    message: string,
    options: { httpStatus?: number; payload?: unknown } = {},
  ) {
    super(message);
    this.name = "SmsBowerApiError";
    this.action = action;
    this.httpStatus = options.httpStatus;
    this.payload = options.payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ensureApiKeyConfigured(config: SmsBowerProviderConfig): string {
  const apiKey = String(config.apiKey ?? "").trim();
  if (!apiKey) {
    throw new Error("SmsBower apiKey is not configured");
  }
  return apiKey;
}

function ensureDefaultRequestOptionsConfigured(
  config: SmsBowerProviderConfig,
): SmsBowerNumberRequestOptions {
  if (!config.defaultRequestOptions) {
    throw new Error(
      "SmsBower defaultRequestOptions is not configured",
    );
  }

  return config.defaultRequestOptions;
}

function normalizeBaseUrl(config: SmsBowerProviderConfig): string {
  const baseUrl = String(config.baseUrl ?? SMSBOWER_DEFAULT_BASE_URL).trim();
  if (!baseUrl) {
    throw new Error("SmsBower baseUrl is not configured");
  }

  const url = new URL(baseUrl);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/stubs/handler_api.php";
  } else if (!url.pathname.endsWith("/handler_api.php")) {
    const pathname = url.pathname.replace(/\/+$/, "");
    url.pathname = pathname.endsWith("/stubs")
      ? `${pathname}/handler_api.php`
      : `${pathname}/stubs/handler_api.php`;
  }

  return url.toString();
}

function buildDispatcher(config: SmsBowerProviderConfig): Dispatcher {
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

async function smsBowerFetch(
  config: SmsBowerProviderConfig,
  input: string | URL,
  init: UndiciRequestInit = {},
) {
  return undiciFetch(input, {
    ...init,
    dispatcher: buildDispatcher(config),
  } satisfies UndiciRequestInit);
}

function normalizeListValue(
  value?: string | string[] | number | number[],
): string | undefined {
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

function isApiErrorPayload(value: unknown): value is SmsBowerApiErrorPayload {
  if (!isRecord(value)) {
    return false;
  }

  const status = value.status;
  return (
    status === 0 ||
    status === "0" ||
    status === false
  ) && ("message" in value || "data" in value);
}

function isFailureString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  if (
    normalized.startsWith("ACCESS_") ||
    normalized.startsWith("STATUS_")
  ) {
    return normalized === "SERVER_ERROR";
  }

  return (
    normalized.startsWith("BAD_") ||
    normalized.startsWith("NO_") ||
    normalized.startsWith("WRONG_") ||
    normalized.startsWith("ERROR_") ||
    normalized.startsWith("BANNED") ||
    normalized === "SERVER_ERROR" ||
    normalized === "EARLY_CANCEL_DENIED"
  );
}

function formatPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (isApiErrorPayload(payload)) {
    const message = String(payload.message ?? "").trim();
    return message || JSON.stringify(payload);
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
): SmsBowerApiError {
  const message = `SmsBower ${action} request failed: ${formatPayload(payload)}`;
  return new SmsBowerApiError(action, message, { httpStatus, payload });
}

async function requestSmsBowerApi(
  config: SmsBowerProviderConfig,
  action: string,
  query: Record<string, unknown> = {},
): Promise<unknown> {
  const url = new URL(normalizeBaseUrl(config));
  url.searchParams.set("api_key", ensureApiKeyConfigured(config));
  url.searchParams.set("action", action);

  for (const [key, value] of Object.entries(query)) {
    setOptionalQuery(url.searchParams, key, value);
  }

  const response = await smsBowerFetch(config, url, {
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

function ensureServiceConfigured(
  options: SmsBowerNumberRequestOptions,
): string {
  const service = String(options.service ?? "").trim();
  if (!service) {
    throw new Error("SmsBower service is not configured");
  }
  return service;
}

function ensureCountryConfigured(
  options: SmsBowerNumberRequestOptions,
): number {
  const country = Number(options.country);
  if (!Number.isFinite(country)) {
    throw new Error("SmsBower country is not configured or invalid");
  }
  return country;
}

function normalizeActivationId(activationId: string | number): string {
  const normalized = String(activationId ?? "").trim();
  if (!normalized) {
    throw new Error("SmsBower activationId cannot be empty");
  }
  return normalized;
}

function parseSmsBowerDate(value: unknown): Date | undefined {
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

  const utcMatch = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
  );
  if (utcMatch) {
    const [, year, month, day, hour, minute, second] = utcMatch;
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

function resolveActivationExpiresAt(
  config: SmsBowerProviderConfig,
  activationTime: unknown,
): Date | undefined {
  const ttlMs =
    config.activationTtlMs ?? SMSBOWER_DEFAULT_ACTIVATION_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return undefined;
  }

  const startedAt = parseSmsBowerDate(activationTime) ?? new Date();
  return new Date(startedAt.getTime() + ttlMs);
}

function normalizeActivation(
  config: SmsBowerProviderConfig,
  payload: unknown,
): SmsBowerActivation {
  if (typeof payload === "string") {
    const matched = payload.trim().match(/^ACCESS_NUMBER:([^:]+):(.+)$/);
    if (!matched) {
      throw new Error(
        `SmsBower getNumberV2 returned unexpected text: ${payload}`,
      );
    }

    const [, activationId, phoneNumber] = matched;
    return {
      activationId: activationId.trim(),
      phoneNumber: phoneNumber.trim(),
      expiresAt: resolveActivationExpiresAt(config, undefined),
      canRequestAnotherSms: true,
      canGetAnotherSms: true,
    };
  }

  if (!isRecord(payload)) {
    throw new Error(
      `SmsBower getNumberV2 returned unexpected payload: ${formatPayload(payload)}`,
    );
  }

  const activationId = String(payload.activationId ?? "").trim();
  const phoneNumber = String(payload.phoneNumber ?? "").trim();

  if (!activationId || !phoneNumber) {
    throw new Error(
      `SmsBower getNumberV2 returned no activationId or phoneNumber: ${formatPayload(payload)}`,
    );
  }

  return {
    activationId,
    phoneNumber,
    expiresAt: resolveActivationExpiresAt(config, payload.activationTime),
    canRequestAnotherSms: parseOptionalBoolean(payload.canGetAnotherSms),
    activationCost:
      payload.activationCost == null
        ? undefined
        : Number(payload.activationCost),
    countryCode:
      payload.countryCode == null ? undefined : Number(payload.countryCode),
    canGetAnotherSms: parseOptionalBoolean(payload.canGetAnotherSms),
    activationTime: parseSmsBowerDate(payload.activationTime),
    activationOperator:
      payload.activationOperator == null
        ? undefined
        : String(payload.activationOperator),
  };
}

function extractCodeFromText(text?: string): string | undefined {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return undefined;
  }

  const matched = normalized.match(SMSBOWER_CODE_PATTERN);
  return matched?.[1];
}

function extractCodeFromStatus(status: string): SmsBowerVerificationCode | null {
  if (!status.startsWith("STATUS_OK:")) {
    return null;
  }

  const text = status.slice("STATUS_OK:".length).trim();
  const code = extractCodeFromText(text) ?? text;
  if (!code) {
    return null;
  }

  return {
    code,
    source: "status",
    text,
    rawStatus: status,
  };
}

function resolvePollAttempts(
  config: SmsBowerProviderConfig,
  options?: SmsBowerWaitForCodeOptions,
): number {
  const attempts =
    options?.pollAttempts ??
    config.pollAttempts ??
    SMSBOWER_DEFAULT_POLL_ATTEMPTS;
  return attempts > 0
    ? Math.floor(attempts)
    : SMSBOWER_DEFAULT_POLL_ATTEMPTS;
}

function resolvePollIntervalMs(
  config: SmsBowerProviderConfig,
  options?: SmsBowerWaitForCodeOptions,
): number {
  const intervalMs =
    options?.pollIntervalMs ??
    config.pollIntervalMs ??
    SMSBOWER_DEFAULT_POLL_INTERVAL_MS;
  return intervalMs > 0
    ? Math.floor(intervalMs)
    : SMSBOWER_DEFAULT_POLL_INTERVAL_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createSmsBowerProvider(config: SmsBowerProviderConfig) {
  ensureApiKeyConfigured(config);

  const provider: SmsBowerProvider = {
    async requestActivation(): Promise<SmsBowerActivation> {
      return provider.requestPhoneNumber(
        ensureDefaultRequestOptionsConfigured(config),
      );
    },

    async requestPhoneNumber(
      options: SmsBowerNumberRequestOptions,
    ): Promise<SmsBowerActivation> {
      const payload = await requestSmsBowerApi(config, "getNumberV2", {
        service: ensureServiceConfigured(options),
        country: ensureCountryConfigured(options),
        ref: options.ref,
        maxPrice: options.maxPrice,
        providerIds: normalizeListValue(options.providerIds),
        exceptProviderIds: normalizeListValue(options.exceptProviderIds),
        phoneException: normalizeListValue(options.phoneException),
      });

      return normalizeActivation(config, payload);
    },

    async markActivationReady(activationId: string | number): Promise<string> {
      const payload = await requestSmsBowerApi(config, "setStatus", {
        id: normalizeActivationId(activationId),
        status: 1,
      });

      return String(payload);
    },

    async requestAnotherSms(activationId: string | number): Promise<string> {
      const payload = await requestSmsBowerApi(config, "setStatus", {
        id: normalizeActivationId(activationId),
        status: 3,
      });

      return String(payload);
    },

    async completeActivation(activationId: string | number): Promise<string> {
      const payload = await requestSmsBowerApi(config, "setStatus", {
        id: normalizeActivationId(activationId),
        status: 6,
      });

      return String(payload);
    },

    async cancelAndWithdraw(activationId: string | number): Promise<string> {
      const payload = await requestSmsBowerApi(config, "setStatus", {
        id: normalizeActivationId(activationId),
        status: 8,
      });

      return String(payload);
    },

    async cancelActivation(activationId: string | number): Promise<string> {
      return provider.cancelAndWithdraw(activationId);
    },

    async getActivationStatus(activationId: string | number): Promise<string> {
      const payload = await requestSmsBowerApi(config, "getStatus", {
        id: normalizeActivationId(activationId),
      });

      return String(payload).trim();
    },

    async waitForVerificationCode(
      activationId: string | number,
      options: SmsBowerWaitForCodeOptions = {},
    ): Promise<SmsBowerVerificationCode> {
      const normalizedActivationId = normalizeActivationId(activationId);
      const waitOptions = {
        ...config.defaultWaitForCodeOptions,
        ...options,
      };
      const shouldMarkReady = waitOptions.markReady ?? false;
      const shouldCompleteOnCode = waitOptions.completeOnCode ?? false;
      const pollAttempts = resolvePollAttempts(config, waitOptions);
      const pollIntervalMs = resolvePollIntervalMs(config, waitOptions);
      let lastStatus = "";

      if (shouldMarkReady) {
        await provider.markActivationReady(normalizedActivationId);
      }

      for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
        console.log(`[smsbower] pollSMSCode attempt=${attempt}/${pollAttempts}`);
        const status = await provider.getActivationStatus(normalizedActivationId);
        lastStatus = status;

        const verification = extractCodeFromStatus(status);
        if (verification) {
          if (shouldCompleteOnCode) {
            await provider.completeActivation(normalizedActivationId);
          }
          return verification;
        }

        if (status === "STATUS_CANCEL") {
          throw new Error(
            `SmsBower activation was cancelled: activationId=${normalizedActivationId}`,
          );
        }

        if (attempt < pollAttempts) {
          await delay(pollIntervalMs);
        }
      }

      throw new Error(
        `SmsBower timed out waiting for verification code: activationId=${normalizedActivationId} lastStatus=${lastStatus}`,
      );
    },
  };

  return provider;
}
