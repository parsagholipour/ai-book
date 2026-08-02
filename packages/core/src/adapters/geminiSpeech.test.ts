import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TTS_SAMPLE_RATE, wavFromPcm16 } from "../audio/pcm.js";
import { FakeSpeechAdapter } from "./fake.js";
import { GeminiSpeechAdapter } from "./geminiSpeech.js";
import { ProviderHttpError } from "./retry.js";

function respondWith(body: unknown, ok = true, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  ) as unknown as typeof fetch;
}

function inlineAudioResponse(data: string, mimeType?: string) {
  return {
    candidates: [{ content: { parts: [{ inlineData: { data, ...(mimeType ? { mimeType } : {}) } }] } }]
  };
}

const pcm = Buffer.alloc(DEFAULT_TTS_SAMPLE_RATE * 2); // one second of silence

describe("Gemini speech adapter", () => {
  it("asks for audio only, with the requested narrator", async () => {
    const fetchImpl = respondWith(
      inlineAudioResponse(pcm.toString("base64"), "audio/L16;rate=24000")
    );
    const adapter = new GeminiSpeechAdapter({ apiKey: "k", model: "tts-model", fetchImpl });

    await adapter.synthesize({ text: "Hello.", voice: "Zephyr", stylePrompt: "Read warmly." });

    const [, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Zephyr");
    // The style prompt is direction for the reading, so it precedes the text.
    expect(body.contents[0].parts[0].text).toBe("Read warmly.\n\nHello.");
  });

  it("returns PCM with its format, so consecutive chunks can be joined exactly", async () => {
    const adapter = new GeminiSpeechAdapter({
      apiKey: "k",
      model: "tts-model",
      fetchImpl: respondWith(inlineAudioResponse(pcm.toString("base64"), "audio/L16;rate=24000"))
    });

    const result = await adapter.synthesize({ text: "Hello.", voice: "Kore" });
    expect(result.sampleRate).toBe(24000);
    expect(result.channels).toBe(1);
    expect(result.durationMs).toBeCloseTo(1000, 0);
    expect(result.provider).toBe("gemini_tts");
  });

  it("unwraps a WAV container rather than treating the header as audio", async () => {
    const wav = wavFromPcm16(pcm);
    const adapter = new GeminiSpeechAdapter({
      apiKey: "k",
      model: "tts-model",
      fetchImpl: respondWith(inlineAudioResponse(wav.toString("base64"), "audio/wav"))
    });

    const result = await adapter.synthesize({ text: "Hello.", voice: "Kore" });
    expect(result.pcm.length).toBe(pcm.length);
    expect(result.durationMs).toBeCloseTo(1000, 0);
  });

  it("reads the snake_case shape too, because the REST API uses both", async () => {
    const adapter = new GeminiSpeechAdapter({
      apiKey: "k",
      model: "tts-model",
      fetchImpl: respondWith({
        candidates: [
          {
            content: {
              parts: [{ inline_data: { data: pcm.toString("base64"), mime_type: "audio/L16;rate=24000" } }]
            }
          }
        ]
      })
    });
    await expect(adapter.synthesize({ text: "Hi.", voice: "Kore" })).resolves.toMatchObject({
      sampleRate: 24000
    });
  });

  it("fails loudly when the response carries no audio", async () => {
    const adapter = new GeminiSpeechAdapter({
      apiKey: "k",
      model: "tts-model",
      fetchImpl: respondWith({ candidates: [{ content: { parts: [{ text: "sorry" }] } }] })
    });
    await expect(adapter.synthesize({ text: "Hi.", voice: "Kore" })).rejects.toThrow(/did not return audio/i);
  });

  it("surfaces an HTTP failure with its status", async () => {
    const adapter = new GeminiSpeechAdapter({
      apiKey: "k",
      model: "tts-model",
      fetchImpl: respondWith({ error: "rate limited" }, false, 429)
    });
    const error = await adapter.synthesize({ text: "Hi.", voice: "Kore" }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProviderHttpError);
    // A status only in the message is invisible to the retry policy.
    expect((error as ProviderHttpError).status).toBe(429);
  });

  it("carries the cooldown the provider named, so a retry does not land inside it", async () => {
    const adapter = new GeminiSpeechAdapter({
      apiKey: "k",
      model: "tts-model",
      fetchImpl: respondWith(
        { error: { code: 429, message: "Please retry in 12.8s.", details: [{ retryDelay: "12.8s" }] } },
        false,
        429
      )
    });
    const error = await adapter.synthesize({ text: "Hi.", voice: "Kore" }).catch((thrown: unknown) => thrown);
    expect((error as ProviderHttpError).retryAfterMs).toBe(12_800);
  });

  it("reads a refused passage without its style prompt rather than losing the chapter", async () => {
    // The model rejects a handful of ordinary passages when the performance
    // direction is prefixed to them; either half alone is accepted.
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      const sent = JSON.parse(String((init as { body?: unknown }).body)).contents[0].parts[0].text;
      if (sent.includes("Read warmly.")) {
        return new Response(JSON.stringify({ error: { code: 400 } }), { status: 400 });
      }
      return new Response(
        JSON.stringify(inlineAudioResponse(pcm.toString("base64"), "audio/L16;rate=24000")),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const adapter = new GeminiSpeechAdapter({ apiKey: "k", model: "tts-model", fetchImpl });

    const result = await adapter.synthesize({
      text: "Chapter 2. The Big News",
      voice: "Kore",
      stylePrompt: "Read warmly."
    });

    expect(result.durationMs).toBeCloseTo(1000, 0);
    expect(result.stylePromptDropped).toBe(true);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it("gives up when the bare text is refused too, rather than looping", async () => {
    const fetchImpl = respondWith({ error: { code: 400 } }, false, 400);
    const adapter = new GeminiSpeechAdapter({ apiKey: "k", model: "tts-model", fetchImpl });

    await expect(
      adapter.synthesize({ text: "Hi.", voice: "Kore", stylePrompt: "Read warmly." })
    ).rejects.toThrow(/400/);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it("does not retry a throttled call as if the style prompt were at fault", async () => {
    const fetchImpl = respondWith({ error: { code: 429 } }, false, 429);
    const adapter = new GeminiSpeechAdapter({ apiKey: "k", model: "tts-model", fetchImpl });

    await expect(
      adapter.synthesize({ text: "Hi.", voice: "Kore", stylePrompt: "Read warmly." })
    ).rejects.toThrow(/429/);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it("refuses to construct without a key rather than failing mid-book", () => {
    expect(() => new GeminiSpeechAdapter({ apiKey: undefined, model: "tts-model" })).toThrow(
      /GEMINI_API_KEY/
    );
  });
});

describe("fake speech adapter", () => {
  it("produces deterministic audio whose length tracks the text", async () => {
    const adapter = new FakeSpeechAdapter();
    const first = await adapter.synthesize({ text: "Hello there.", voice: "Zephyr" });
    const second = await adapter.synthesize({ text: "Hello there.", voice: "Zephyr" });

    expect(first.pcm.equals(second.pcm)).toBe(true);
    const longer = await adapter.synthesize({ text: "Hello there, and then some more.", voice: "Zephyr" });
    expect(longer.durationMs).toBeGreaterThan(first.durationMs);
  });

  it("stays inside a sane range for absurd input", async () => {
    const adapter = new FakeSpeechAdapter();
    expect((await adapter.synthesize({ text: "", voice: "Zephyr" })).durationMs).toBeGreaterThanOrEqual(400);
    expect(
      (await adapter.synthesize({ text: "x".repeat(100_000), voice: "Zephyr" })).durationMs
    ).toBeLessThanOrEqual(20_000);
  });
});
