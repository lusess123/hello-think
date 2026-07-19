import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is not configured`);
  }
  return normalized;
}

export function createGatewayModel(env: Env): LanguageModel {
  const baseURL = required(env.AI_GATEWAY_BASE_URL, "AI_GATEWAY_BASE_URL");
  const token = required(env.AI_GATEWAY_TOKEN, "AI_GATEWAY_TOKEN");
  const providerAlias = env.AI_GATEWAY_PROVIDER_ALIAS || "default";
  const model = env.LLM_DEFAULT_MODEL || "deepseek-v4-flash";

  const gatewayFetch: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);

    // The DeepSeek key is managed by Cloudflare Secrets Store. Authenticate
    // the gateway itself and prevent the OpenAI SDK placeholder key from being
    // forwarded to the provider.
    headers.delete("authorization");
    headers.set("cf-aig-authorization", `Bearer ${token}`);
    headers.set("cf-aig-byok-alias", providerAlias);

    return globalThis.fetch(input, { ...init, headers });
  };

  const gateway = createOpenAI({
    apiKey: "unused",
    baseURL,
    fetch: gatewayFetch
  });

  return gateway.chat(model);
}
