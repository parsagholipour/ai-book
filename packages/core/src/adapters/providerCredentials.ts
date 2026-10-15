import type { AppConfig } from "../config.js";
import type { ImageModelSelection, TextModelSelection } from "../schemas/book.js";

/**
 * Every outside account a model call can be billed to, spelled the way the
 * routing selections spell their `provider` — plus Jev's gateway, which is the
 * `provider` of `JEV_SELECTION`. Speech and voice name their own provider ids
 * (`gemini_tts`, `openai_realtime`, …); `providerRequirements.ts` maps those
 * onto these accounts.
 */
export type ProviderAccount =
  | TextModelSelection["provider"]
  | ImageModelSelection["provider"]
  | "vercel-ai-gateway";

/**
 * The settings each account cannot be called without. Exhaustive on purpose:
 * a provider added to `textModelSelectionSchema` or `imageModelSelectionSchema`
 * is a compile error here until its key is named, and once it is named the
 * production check (`productionConfig.ts`) requires it wherever routing can
 * select it.
 */
export const PROVIDER_CREDENTIALS = {
  deepseek: ["DEEPSEEK_API_KEY"],
  deepinfra: ["DEEPINFRA_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  alibaba: ["ALIBABA_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "openai-compatible": ["LOCAL_TEXT_BASE_URL", "LOCAL_TEXT_MODEL"],
  "vercel-ai-gateway": ["VERCEL_AI_GATEWAY_API_KEY"]
} as const satisfies Record<ProviderAccount, readonly (keyof AppConfig)[]>;

export const PROVIDER_LABELS: Record<ProviderAccount, string> = {
  deepseek: "DeepSeek",
  deepinfra: "DeepInfra",
  openrouter: "OpenRouter",
  gemini: "Gemini",
  alibaba: "Alibaba (Qwen)",
  openai: "OpenAI",
  "openai-compatible": "the local OpenAI-compatible server",
  "vercel-ai-gateway": "Jev (Vercel AI Gateway)"
};

export function providerCredentialVariables(provider: ProviderAccount): readonly string[] {
  return PROVIDER_CREDENTIALS[provider];
}

/** True when every setting the account needs is present and not blank. */
export function providerConfigured(config: Partial<AppConfig>, provider: ProviderAccount): boolean {
  return PROVIDER_CREDENTIALS[provider].every((variable) => {
    const value = config[variable];
    return typeof value === "string" && value.trim().length > 0;
  });
}
