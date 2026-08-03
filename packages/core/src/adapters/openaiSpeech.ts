import { DEFAULT_TTS_CHANNELS, DEFAULT_TTS_SAMPLE_RATE, pcm16DurationMs } from "../audio/pcm.js";
import { ProviderHttpError } from "./retry.js";
import type { SpeechAdapter, SpeechRequest, SpeechResult } from "./types.js";

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
export const OPENAI_TTS_MAX_INPUT_CHARACTERS = 4_096;

export type OpenAISpeechAdapterOptions = {
  apiKey: string | undefined;
  model: string;
  fetchImpl?: typeof fetch | undefined;
};

/** OpenAI's non-realtime speech endpoint, returning headerless PCM16 at 24 kHz. */
export class OpenAISpeechAdapter implements SpeechAdapter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAISpeechAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("OPENAI_API_KEY is required for backup narration.");
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(request: SpeechRequest): Promise<SpeechResult> {
    if (request.text.length > OPENAI_TTS_MAX_INPUT_CHARACTERS) {
      throw new Error(`OpenAI TTS input exceeds the ${OPENAI_TTS_MAX_INPUT_CHARACTERS}-character limit.`);
    }

    const response = await this.fetchImpl(OPENAI_SPEECH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "audio/pcm"
      },
      body: JSON.stringify({
        model: this.model,
        voice: request.voice,
        input: request.text,
        instructions:
          request.stylePrompt ??
          "Read aloud as an audiobook narrator: warm, unhurried, natural, and faithful to the supplied text.",
        response_format: "pcm"
      })
    });

    if (!response.ok) {
      const body = await response.text();
      const retryAfterMs = retryAfterMsFromResponse(response);
      throw new ProviderHttpError(`OpenAI TTS request failed (${response.status}): ${body.slice(0, 500)}`, {
        status: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs })
      });
    }

    const pcm = Buffer.from(await response.arrayBuffer());
    if (pcm.length === 0) {
      throw new Error(`OpenAI TTS model ${this.model} returned empty audio.`);
    }
    if (pcm.length % 2 !== 0) {
      throw new Error(`OpenAI TTS model ${this.model} returned invalid PCM16 audio.`);
    }

    const chunk = { pcm, sampleRate: DEFAULT_TTS_SAMPLE_RATE, channels: DEFAULT_TTS_CHANNELS };
    return {
      provider: "openai_tts",
      model: this.model,
      ...chunk,
      durationMs: pcm16DurationMs(chunk)
    };
  }
}

function retryAfterMsFromResponse(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1_000);
  }
  const at = Date.parse(value);
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : undefined;
}
