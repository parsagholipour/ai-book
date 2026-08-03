import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TTS_SAMPLE_RATE } from "../audio/pcm.js";
import { OpenAISpeechAdapter } from "./openaiSpeech.js";
import { ProviderHttpError } from "./retry.js";

const pcm = Buffer.alloc(DEFAULT_TTS_SAMPLE_RATE * 2);

function audioResponse(bytes = pcm, init: ResponseInit = { status: 200 }) {
  return vi.fn(async () => new Response(bytes, init)) as unknown as typeof fetch;
}

describe("OpenAI speech adapter", () => {
  it("authorizes an audiobook PCM request with the configured model, voice, and instructions", async () => {
    const fetchImpl = audioResponse();
    const adapter = new OpenAISpeechAdapter({ apiKey: "secret", model: "tts-snapshot", fetchImpl });

    await adapter.synthesize({
      text: "Once upon a time.",
      voice: "marin",
      stylePrompt: "Read warmly."
    });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer secret",
      Accept: "audio/pcm",
      "Content-Type": "application/json"
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "tts-snapshot",
      voice: "marin",
      input: "Once upon a time.",
      instructions: "Read warmly.",
      response_format: "pcm"
    });
  });

  it("validates raw 24 kHz mono PCM and calculates its duration", async () => {
    const adapter = new OpenAISpeechAdapter({ apiKey: "k", model: "tts", fetchImpl: audioResponse() });
    await expect(adapter.synthesize({ text: "Hello.", voice: "coral" })).resolves.toMatchObject({
      provider: "openai_tts",
      model: "tts",
      sampleRate: 24_000,
      channels: 1,
      durationMs: 1_000
    });
  });

  it("guards the API's 4,096-character input limit before sending", async () => {
    const fetchImpl = audioResponse();
    const adapter = new OpenAISpeechAdapter({ apiKey: "k", model: "tts", fetchImpl });
    await expect(adapter.synthesize({ text: "x".repeat(4_097), voice: "coral" })).rejects.toThrow(/4096/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects empty and malformed PCM responses", async () => {
    const empty = new OpenAISpeechAdapter({ apiKey: "k", model: "tts", fetchImpl: audioResponse(Buffer.alloc(0)) });
    const odd = new OpenAISpeechAdapter({ apiKey: "k", model: "tts", fetchImpl: audioResponse(Buffer.alloc(3)) });
    await expect(empty.synthesize({ text: "Hi.", voice: "coral" })).rejects.toThrow(/empty audio/i);
    await expect(odd.synthesize({ text: "Hi.", voice: "coral" })).rejects.toThrow(/invalid PCM16/i);
  });

  it("surfaces HTTP status and numeric Retry-After metadata", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"slow down"}', { status: 429, headers: { "Retry-After": "12.5" } })
    ) as unknown as typeof fetch;
    const adapter = new OpenAISpeechAdapter({ apiKey: "k", model: "tts", fetchImpl });
    const error = await adapter.synthesize({ text: "Hi.", voice: "coral" }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 12_500 });
  });

  it("parses an HTTP-date Retry-After header", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response("unavailable", {
            status: 503,
            headers: { "Retry-After": "Mon, 03 Aug 2026 00:00:30 GMT" }
          })
      ) as unknown as typeof fetch;
      const adapter = new OpenAISpeechAdapter({ apiKey: "k", model: "tts", fetchImpl });
      const error = await adapter.synthesize({ text: "Hi.", voice: "coral" }).catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({ status: 503, retryAfterMs: 30_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to construct without an API key", () => {
    expect(() => new OpenAISpeechAdapter({ apiKey: undefined, model: "tts" })).toThrow(/OPENAI_API_KEY/);
  });
});
