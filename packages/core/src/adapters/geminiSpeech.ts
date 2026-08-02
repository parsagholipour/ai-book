import { pcm16ChunkFromInlineAudio, pcm16DurationMs } from "../audio/pcm.js";
import { ProviderHttpError } from "./retry.js";
import type { SpeechAdapter, SpeechRequest, SpeechResult } from "./types.js";

/**
 * Single-speaker Gemini TTS for narration.
 *
 * Uses the REST endpoint rather than the SDK because `fetchImpl` is injectable,
 * which is what lets the audiobook tests exercise the whole synthesis path with
 * no network and no key.
 */

const GEMINI_TTS_API_VERSION = "v1beta";

export type GeminiSpeechAdapterOptions = {
  apiKey: string | undefined;
  model: string;
  fetchImpl?: typeof fetch | undefined;
};

export class GeminiSpeechAdapter implements SpeechAdapter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiSpeechAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("GEMINI_API_KEY is required for narration.");
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(request: SpeechRequest): Promise<SpeechResult> {
    if (!request.stylePrompt) {
      return this.speak(request.text, request.voice);
    }
    try {
      return await this.speak(`${request.stylePrompt}\n\n${request.text}`, request.voice);
    } catch (error) {
      if (!isInvalidArgument(error)) {
        throw error;
      }
      // The model refuses a small number of otherwise ordinary passages when the
      // performance direction is prefixed to them — a bare `INVALID_ARGUMENT`
      // with no detail, reproducible for that exact pairing and fine for either
      // half alone. Reading the passage plainly loses the direction for one
      // chunk; throwing loses the whole audiobook.
      const result = await this.speak(request.text, request.voice);
      return { ...result, stylePromptDropped: true };
    }
  }

  private async speak(text: string, voice: string): Promise<SpeechResult> {
    const response = await this.postGenerateContent({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice }
          }
        }
      }
    });

    const chunk = pcm16ChunkFromInlineAudio(inlineAudioFromResponse(response, this.model));
    return {
      provider: "gemini_tts",
      model: this.model,
      pcm: chunk.pcm,
      sampleRate: chunk.sampleRate,
      channels: chunk.channels,
      durationMs: pcm16DurationMs(chunk)
    };
  }

  private async postGenerateContent(body: Record<string, unknown>): Promise<unknown> {
    const url = `https://generativelanguage.googleapis.com/${GEMINI_TTS_API_VERSION}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      // The status travels as a field, not just in the message: that is what lets
      // a 429 be retried after the cooldown the response itself names.
      const retryAfterMs = retryAfterMsFromResponse(response, text);
      throw new ProviderHttpError(`Gemini TTS request failed (${response.status}): ${text.slice(0, 500)}`, {
        status: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs })
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Gemini TTS returned a non-JSON response: ${text.slice(0, 300)}`);
    }
  }
}

/** A refusal of this particular text — retrying it unchanged will fail the same way. */
function isInvalidArgument(error: unknown): boolean {
  return error instanceof ProviderHttpError && error.status === 400;
}

/**
 * Google names its own cooldown two ways: a `Retry-After` header, or a
 * `retryDelay` inside the error details ("38.3s"). Either beats guessing.
 */
function retryAfterMsFromResponse(response: Response, body: string): number | undefined {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) {
    return header * 1_000;
  }
  const match = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body) ?? /retry in ([\d.]+)s/i.exec(body);
  const seconds = match?.[1] ? Number(match[1]) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1_000) : undefined;
}

function inlineAudioFromResponse(response: unknown, model: string): { data: string; mimeType?: string | undefined } {
  const record = response as
    | { candidates?: Array<{ content?: { parts?: unknown[] } }>; parts?: unknown[] }
    | null
    | undefined;
  const parts = [...(record?.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? []), ...(record?.parts ?? [])];

  for (const part of parts) {
    const inline = (part as { inlineData?: { data?: unknown; mimeType?: unknown }; inline_data?: { data?: unknown; mime_type?: unknown } })
      ?.inlineData;
    const snakeInline = (part as { inline_data?: { data?: unknown; mime_type?: unknown } })?.inline_data;
    const data = typeof inline?.data === "string" ? inline.data : typeof snakeInline?.data === "string" ? snakeInline.data : undefined;
    if (!data) {
      continue;
    }
    const mimeType =
      typeof inline?.mimeType === "string" ? inline.mimeType : typeof snakeInline?.mime_type === "string" ? snakeInline.mime_type : undefined;
    return { data, ...(mimeType ? { mimeType } : {}) };
  }

  throw new Error(`Gemini TTS model ${model} did not return audio.`);
}
