import { ActivationBroker } from "./activation-broker.js";
import { createHeroSmsProvider } from "./heroSMS.js";
import { createSmsBowerProvider } from "./smsbower.js";
import type {
  SmsActivation,
  SmsProvider,
  SmsVerificationCode,
} from "./provider.js";

export type SMSProviderName = "hero-sms" | "smsbower";

export type SMSBrokerOption = {
  provider?: SMSProviderName;
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
  service?: string;
  country: number;
  countries?: number[];
  maxPrice: number;
  pollAttempts: number;
  pollIntervalMs: number;
  priceTiers?: number[];
  requestRetryAttempts?: number;
  requestRetryIntervalMs?: number;
  providerIds?: string | string[] | number | number[];
  exceptProviderIds?: string | string[] | number | number[];
  phoneException?: string | string[] | number | number[];
};

const DEFAULT_REQUEST_RETRY_ATTEMPTS = 10;
const DEFAULT_REQUEST_RETRY_INTERVAL_MS = 3000;

type NumberRequestOptions = {
  service: string;
  country: number;
  maxPrice?: number;
  providerIds?: string | string[] | number | number[];
  exceptProviderIds?: string | string[] | number | number[];
  phoneException?: string | string[] | number | number[];
};

type ProviderBundle = {
  label: string;
  provider: SmsProvider<SmsActivation, SmsVerificationCode>;
  requestPhoneNumber(options: NumberRequestOptions): Promise<SmsActivation>;
};

function createProviderBundle(
  option: SMSBrokerOption,
  firstCountry: number,
  firstTier: number,
  service: string,
): ProviderBundle {
  if (option.provider === "smsbower") {
    const smsBowerProvider = createSmsBowerProvider({
      apiKey: option.apiKey,
      baseUrl: option.baseUrl || undefined,
      proxyUrl: option.proxyUrl || undefined,
      defaultRequestOptions: {
        service,
        country: firstCountry,
        maxPrice: firstTier,
        providerIds: option.providerIds,
        exceptProviderIds: option.exceptProviderIds,
        phoneException: option.phoneException,
      },
      defaultWaitForCodeOptions: {
        markReady: false,
        completeOnCode: false,
        pollAttempts: option.pollAttempts,
        pollIntervalMs: option.pollIntervalMs,
      },
    });

    return {
      label: "smsbower",
      provider: smsBowerProvider,
      requestPhoneNumber: (requestOptions) =>
        smsBowerProvider.requestPhoneNumber(requestOptions),
    };
  }

  const heroProvider = createHeroSmsProvider({
    apiKey: option.apiKey,
    baseUrl: option.baseUrl || undefined,
    proxyUrl: option.proxyUrl || undefined,
    defaultRequestOptions: {
      service,
      country: firstCountry,
      maxPrice: firstTier,
      fixedPrice: false,
      phoneException: option.phoneException as string | string[] | undefined,
    },
    defaultWaitForCodeOptions: {
      markReady: false,
      completeOnCode: false,
      pollAttempts: option.pollAttempts,
      pollIntervalMs: option.pollIntervalMs,
    },
  });

  return {
    label: "heroSMS",
    provider: heroProvider,
    requestPhoneNumber: (requestOptions) =>
      heroProvider.requestPhoneNumber({
        service: requestOptions.service,
        country: requestOptions.country,
        maxPrice: requestOptions.maxPrice,
        fixedPrice: false,
        phoneException: requestOptions.phoneException as
          | string
          | string[]
          | undefined,
      }),
  };
}

export const createSMSBroker = (option: SMSBrokerOption) => {
  const tiers = (option.priceTiers && option.priceTiers.length)
    ? [...option.priceTiers].sort((a, b) => a - b)
    : [option.maxPrice];

  const countries = (option.countries && option.countries.length)
    ? [...option.countries]
    : [option.country];

  const service = option.service?.trim() || "dr";
  const bundle = createProviderBundle(option, countries[0], tiers[0], service);
  const retryAttempts = option.requestRetryAttempts && option.requestRetryAttempts > 0
    ? Math.floor(option.requestRetryAttempts)
    : DEFAULT_REQUEST_RETRY_ATTEMPTS;
  const retryIntervalMs = option.requestRetryIntervalMs && option.requestRetryIntervalMs > 0
    ? Math.floor(option.requestRetryIntervalMs)
    : DEFAULT_REQUEST_RETRY_INTERVAL_MS;
  let cursorTier = 0;
  let cursorCountry = 0;

  const wrappedProvider: SmsProvider<SmsActivation, SmsVerificationCode> = {
    ...bundle.provider,
    async requestActivation(): Promise<SmsActivation> {
      let lastErr: unknown = null;

      for (let retry = 1; retry <= retryAttempts; retry += 1) {
        for (let ti = cursorTier; ti < tiers.length; ti += 1) {
          const tier = tiers[ti];

          for (let off = 0; off < countries.length; off += 1) {
            const ci = (cursorCountry + off) % countries.length;
            const country = countries[ci];

            try {
              console.log(
                `[${bundle.label}] try get number retry=${retry}/${retryAttempts} service=${service} country=${country} maxPrice<=${tier} (tier ${ti + 1}/${tiers.length})`,
              );
              const activation = await bundle.requestPhoneNumber({
                service,
                country,
                maxPrice: tier,
                providerIds: option.providerIds,
                exceptProviderIds: option.exceptProviderIds,
                phoneException: option.phoneException,
              });
              cursorTier = ti;
              cursorCountry = ci;
              const cost = "activationCost" in activation
                ? String(activation.activationCost ?? "?")
                : "?";
              console.log(
                `[${bundle.label}] get number success country=${country} phone=+${activation.phoneNumber} cost=${cost}`,
              );
              return activation;
            } catch (err) {
              lastErr = err;
              const message = String((err as Error)?.message ?? err);
              const upperMessage = message.toUpperCase();
              if (
                upperMessage.includes("NO_NUMBERS") ||
                upperMessage.includes("NO_NUMBER") ||
                upperMessage.includes("BAD_PRICE") ||
                upperMessage.includes("WRONG_MAX_PRICE") ||
                upperMessage.includes("BAD_KEY") ||
                upperMessage.includes("NO_BALANCE")
              ) {
                console.warn(
                  `[${bundle.label}] country=${country} tier=${tier} skipped (${message.slice(0, 120)})`,
                );
                continue;
              }
              throw err;
            }
          }

          cursorCountry = 0;
        }

        if (retry < retryAttempts) {
          console.warn(
            `[${bundle.label}] no numbers in retry ${retry}/${retryAttempts}; wait ${retryIntervalMs}ms then retry`,
          );
          cursorTier = 0;
          cursorCountry = 0;
          await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
        }
      }

      throw lastErr ?? new Error(
        `${bundle.label} no numbers after ${retryAttempts} retries for countries=[${countries.join(",")}] tiers=[${tiers.join(",")}]`,
      );
    },
  };

  return new ActivationBroker(wrappedProvider);
};
