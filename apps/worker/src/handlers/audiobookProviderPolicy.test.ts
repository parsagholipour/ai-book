import { describe, expect, it } from "vitest";
import { selectAudiobookSpeechProvider } from "./audiobookProviderPolicy.js";

const defaults = {
  persistedProvider: null,
  persistedModel: null,
  persistedFallbackReason: null,
  recentGeminiCalls: 0,
  plannedChunks: 20,
  safeGeminiBudget: 90,
  fallbackAvailable: true,
  geminiModel: "gemini-tts",
  openAIModel: "openai-tts"
};

describe("audiobook speech provider policy", () => {
  it("uses Gemini while the projected request count is inside the safe budget", () => {
    expect(selectAudiobookSpeechProvider(defaults)).toEqual({ provider: "gemini_tts", model: "gemini-tts" });
  });

  it("sends a 110-chunk audiobook directly to OpenAI without a Gemini request", () => {
    expect(selectAudiobookSpeechProvider({ ...defaults, plannedChunks: 110 })).toEqual({
      provider: "openai_tts",
      model: "openai-tts",
      fallbackReason: "gemini_quota_preflight"
    });
  });

  it("includes successful calls made by every project in the projected budget", () => {
    expect(selectAudiobookSpeechProvider({ ...defaults, recentGeminiCalls: 75 })).toMatchObject({
      provider: "openai_tts"
    });
  });

  it("does not preflight to an unavailable or disabled backup", () => {
    expect(
      selectAudiobookSpeechProvider({ ...defaults, plannedChunks: 110, fallbackAvailable: false })
    ).toMatchObject({ provider: "gemini_tts" });
  });

  it("always resumes a persisted OpenAI switch and never returns to Gemini", () => {
    expect(
      selectAudiobookSpeechProvider({
        ...defaults,
        persistedProvider: "openai_tts",
        persistedModel: "openai-snapshot",
        persistedFallbackReason: "gemini_rate_limit",
        fallbackAvailable: false
      })
    ).toEqual({
      provider: "openai_tts",
      model: "openai-snapshot",
      fallbackReason: "gemini_rate_limit"
    });
  });
});
