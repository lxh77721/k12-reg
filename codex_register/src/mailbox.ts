import {appConfig, type MailProviderName} from "./config.js";
import {create2925Provider} from "./mail/2925.js";
import {createCloudflareProvider} from "./mail/cloudflare.js";
import {createDdgCfProvider, createDdgImapProvider} from "./mail/ddg.js";
import {createGmailProvider} from "./mail/gmail.js";
import {createGPTMailProvider} from "./mail/gptmail.js";
import {createHotmailProvider} from "./mail/hotmail.js";
import {createProxiedMailProvider} from "./mail/proxiedmail.js";

export interface EmailCodeProvider {
  getEmailAddress(): Promise<string>;
  getEmailVerificationCode(email: string, options?: {minTimestampMs?: number}): Promise<string>;
}

export const MAILBOX_CONFIG: {
  provider: MailProviderName;
} = new Proxy({} as {provider: MailProviderName}, {
  get(_target, property) {
    if (property === "provider") return appConfig.provider;
    return undefined;
  },
  ownKeys() {
    return ["provider"];
  },
  getOwnPropertyDescriptor(_target, property) {
    if (property !== "provider") return undefined;
    return {
      enumerable: true,
      configurable: true,
      value: appConfig.provider,
    };
  },
});

const providers = new Map<MailProviderName, EmailCodeProvider>();

function createProvider(provider: MailProviderName): EmailCodeProvider {
  switch (provider) {
    case "proxiedmail":
      return createProxiedMailProvider();
    case "gmail":
      return createGmailProvider();
    case "gptmail":
      return createGPTMailProvider();
    case "hotmail":
      return createHotmailProvider();
    case "2925":
      return create2925Provider();
    case "cloudflare":
      return createCloudflareProvider();
    case "ddg_mail":
      return createDdgCfProvider();
    case "imap_mail":
      return createDdgImapProvider();
    default:
      throw new Error(`Unsupported mailbox provider: ${provider}`);
  }
}

function getProvider(): EmailCodeProvider {
  const providerName = appConfig.provider;
  let provider = providers.get(providerName);
  if (!provider) {
    provider = createProvider(providerName);
    providers.set(providerName, provider);
  }
  return provider;
}

export async function getEmailAddress(): Promise<string> {
  return getProvider().getEmailAddress();
}

export async function getEmailVerificationCode(email: string): Promise<string> {
  return getProvider().getEmailVerificationCode(email);
}
