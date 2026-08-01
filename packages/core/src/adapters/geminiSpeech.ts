import { pcm16ChunkFromInlineAudio, pcm16DurationMs } from "../audio/pcm.js";
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
    const text = request.stylePrompt ? `${request.stylePrompt}\n\n${request.text}` : request.text;
    const response = await this.postGenerateContent({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: request.voice }
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
      throw new Error(`Gemini TTS request failed (${response.status}): ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Gemini TTS returned a non-JSON response: ${text.slice(0, 300)}`);
    }
  }
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
