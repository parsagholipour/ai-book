import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import type { TextModelSelection } from "../schemas/book.js";
import { createProviders, createSpeechAdapter, defaultImageModelSelection, imageModelOptions, resolveImageFallbackSelection } from "./factory.js";
import { GeminiEmbeddingAdapter, GeminiResearchAdapter } from "./gemini.js";
import { GeminiSpeechAdapter } from "./geminiSpeech.js";
import {
  compiledGenerationTextModelRouting,
  compiledGenerationTextRouteCandidates,
  GENERATION_TEXT_MODEL_TIERS,
  JEV_SELECTION,
  resolveGenerationTextModelRouting
} from "./generationTextModelRouting.js";
import { generationTextModelOptions } from "./factory.js";
import { premiumCoverImageSelection } from "./modelTiers.js";
import { PROVIDER_CREDENTIALS, providerConfigured, type ProviderAccount } from "./providerCredentials.js";
import {
  defaultRoutingProviderRequirements,
  FIXED_PROVIDER_USES,
  missingProviderCredentials,
  routedProvidersWithoutCredentials,
  unkeyedRoutedProviderMessage
} from "./providerRequirements.js";

const ALL_KEYS: NodeJS.ProcessEnv = {
  S3_BUCKET: "test-private-bucket",
  DEEPSEEK_API_KEY: "sk-SECRET-deepseek",
  DEEPINFRA_API_KEY: "SECRET-deepinfra",
  OPENROUTER_API_KEY: "SECRET-openrouter",
  GEMINI_API_KEY: "SECRET-gemini",
  ALIBABA_API_KEY: "sk-SECRET-alibaba",
  OPENAI_API_KEY: "sk-SECRET-openai",
  VERCEL_AI_GATEWAY_API_KEY: "SECRET-vercel",
  LOCAL_TEXT_BASE_URL: "http://127.0.0.1:11434/v1",
  LOCAL_TEXT_MODEL: "llama"
};

function configWithout(...providers: ProviderAccount[]) {
  const env = { ...ALL_KEYS };
  for (const provider of providers) {
    for (const variable of PROVIDER_CREDENTIALS[provider]) delete env[variable];
  }
  return loadConfig(env);
}

function requiredProviders(config = configWithout()): Set<ProviderAccount> {
  return new Set(defaultRoutingProviderRequirements(config).map((requirement) => requirement.provider));
}

describe("the providers the default routing can select", () => {
  it("are every provider the compiled text routes name, read off the routing table", () => {
    const config = configWithout();
    const required = requiredProviders(config);
    const candidates = compiledGenerationTextRouteCandidates(config);
    for (const list of Object.values(candidates) as Array<readonly TextModelSelection[]>) {
      for (const candidate of list) {
        expect(required).toContain(candidate.provider);
        // …and dropping its key is reported, which is what makes adding a
        // provider to a route require its key with no second list to edit.
        expect(missingProviderCredentials(configWithout(candidate.provider)).map((r) => r.provider)).toContain(
          candidate.provider
        );
      }
    }
  });

  it("include every image provider a book can be drawn with, and every fallback the image adapter falls to", () => {
    const config = configWithout();
    const required = requiredProviders(config);
    const primaries = [
      defaultImageModelSelection(config),
      ...GENERATION_TEXT_MODEL_TIERS.map((tier) => defaultImageModelSelection(config, tier)),
      premiumCoverImageSelection(),
      ...imageModelOptions(config)
    ];
    for (const primary of primaries) {
      expect(required).toContain(primary.provider);
      for (const premium of [false, true]) {
        expect(required).toContain(resolveImageFallbackSelection(config, primary, premium).provider);
      }
    }
  });

  it("pin the fixed-provider work to the adapters createProviders actually builds", () => {
    const providers = createProviders(configWithout());
    expect(providers.embedding).toBeInstanceOf(GeminiEmbeddingAdapter);
    expect(providers.research).toBeInstanceOf(GeminiResearchAdapter);
    expect(createSpeechAdapter(configWithout())).toBeInstanceOf(GeminiSpeechAdapter);
    expect(new Set(FIXED_PROVIDER_USES.map((use) => use.provider))).toEqual(new Set(["gemini"]));
  });

  it("are today's five: DeepSeek, DeepInfra, Gemini, Alibaba and OpenAI", () => {
    expect(requiredProviders()).toEqual(new Set(["deepseek", "deepinfra", "gemini", "alibaba", "openai"]));
    // Selectable in the Quality tab, never by default: warned about at boot, not required.
    for (const optional of ["openrouter", "vercel-ai-gateway", "openai-compatible"] as const) {
      expect(missingProviderCredentials(configWithout(optional))).toEqual([]);
    }
  });

  it("follow the voice provider the deployment picks", () => {
    const config = loadConfig({ ...ALL_KEYS, VOICE_CHAT_PROVIDER: "openai_realtime", AUDIOBOOK_OPENAI_FALLBACK_ENABLED: "false" });
    const openai = defaultRoutingProviderRequirements(config).find((requirement) => requirement.provider === "openai");
    expect(openai?.uses).toEqual(["character voice calls"]);
  });

  it("are not required under MOCK_AI, which calls none of them", () => {
    const env = { S3_BUCKET: "test-private-bucket", MOCK_AI: "true" };
    expect(missingProviderCredentials(loadConfig(env))).toEqual([]);
    expect(missingProviderCredentials(loadConfig({ S3_BUCKET: "test-private-bucket" })).length).toBeGreaterThan(0);
  });
});

describe("a saved routing that names a provider with no key", () => {
  function savedRouting(config: ReturnType<typeof loadConfig>, models: Record<string, unknown>) {
    const compiled = compiledGenerationTextModelRouting(config, generationTextModelOptions(config));
    return resolveGenerationTextModelRouting({ models }, compiled);
  }

  it("is found wherever it is routed: tier fields, stages and the fast decisions", () => {
    const keyed = configWithout();
    const routing = savedRouting(keyed, {
      fastDecisions: { ...JEV_SELECTION },
      balanced: { writer: { provider: "openrouter", model: "moonshotai/kimi-k2" } }
    });
    expect(routedProvidersWithoutCredentials(keyed, routing)).toEqual([]);

    const unkeyed = configWithout("openrouter", "vercel-ai-gateway");
    const gaps = routedProvidersWithoutCredentials(unkeyed, routing);
    const byProvider = new Map(gaps.map((gap) => [gap.provider, gap]));
    expect(byProvider.get("openrouter")?.routes).toContain("balanced.writer");
    expect(byProvider.get("openrouter")?.variables).toEqual(["OPENROUTER_API_KEY"]);
    expect(byProvider.get("vercel-ai-gateway")?.routes).toEqual(
      expect.arrayContaining(["fastDecisions", "balanced.stages.judge-page-drafts.primary"])
    );
  });

  it("is named in a warning that shows a few routes and no key", () => {
    const config = configWithout("alibaba");
    const routing = savedRouting(configWithout(), {
      fast: { writer: { provider: "alibaba", model: "qwen-flash" }, judgment: { provider: "alibaba", model: "qwen-flash" } }
    });
    const [gap] = routedProvidersWithoutCredentials(config, routing);
    expect(gap?.provider).toBe("alibaba");
    const message = unkeyedRoutedProviderMessage(gap!);
    expect(message).toContain("ALIBABA_API_KEY is not set");
    expect(message).toMatch(/and \d+ more/);
    expect(message).not.toMatch(/SECRET/);
  });

  it("is nothing under MOCK_AI", () => {
    const config = loadConfig({ S3_BUCKET: "test-private-bucket", MOCK_AI: "true" });
    const routing = savedRouting(configWithout(), { balanced: { writer: { provider: "openrouter", model: "x/y" } } });
    expect(routedProvidersWithoutCredentials(config, routing)).toEqual([]);
  });
});

describe("providerConfigured", () => {
  it("treats a blank key as missing and needs both local-server settings", () => {
    expect(providerConfigured({ GEMINI_API_KEY: "  " }, "gemini")).toBe(false);
    expect(providerConfigured({ LOCAL_TEXT_BASE_URL: "http://127.0.0.1:1/v1" }, "openai-compatible")).toBe(false);
    expect(providerConfigured({ LOCAL_TEXT_BASE_URL: "http://127.0.0.1:1/v1", LOCAL_TEXT_MODEL: "m" }, "openai-compatible")).toBe(true);
  });
});
