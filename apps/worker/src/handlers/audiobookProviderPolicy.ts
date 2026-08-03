import type { SpeechModelSelection } from "@book-maker/core";

export type AudiobookProviderPolicyInput = {
  persistedProvider?: string | null | undefined;
  persistedModel?: string | null | undefined;
  persistedFallbackReason?: string | null | undefined;
  recentGeminiCalls: number;
  plannedChunks: number;
  safeGeminiBudget: number;
  fallbackAvailable: boolean;
  geminiModel: string;
  openAIModel: string;
};

export type SelectedAudiobookSpeechProvider = SpeechModelSelection & {
  fallbackReason?: string | undefined;
};

/** Pure policy kept separate from provider I/O so its boundary cases stay pinned down. */
export function selectAudiobookSpeechProvider(
  input: AudiobookProviderPolicyInput
): SelectedAudiobookSpeechProvider {
  // Once a run crosses providers it must never spend another Gemini request,
  // even when fallback is later disabled or the worker is restarted.
  if (input.persistedProvider === "openai_tts") {
    return {
      provider: "openai_tts",
      model: input.persistedModel ?? input.openAIModel,
      ...(input.persistedFallbackReason ? { fallbackReason: input.persistedFallbackReason } : {})
    };
  }

  if (
    input.fallbackAvailable &&
    input.recentGeminiCalls + input.plannedChunks > input.safeGeminiBudget
  ) {
    return {
      provider: "openai_tts",
      model: input.openAIModel,
      fallbackReason: "gemini_quota_preflight"
    };
  }

  return {
    provider: "gemini_tts",
    model:
      input.persistedProvider === "gemini_tts" && input.persistedModel
        ? input.persistedModel
        : input.geminiModel
  };
}
