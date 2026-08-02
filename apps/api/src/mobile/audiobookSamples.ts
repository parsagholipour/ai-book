import {
  AUDIOBOOK_MP3_KBPS,
  AUDIOBOOK_SAMPLE_PASSAGE,
  createSpeechAdapter,
  encodePcm16ToMp3,
  narrationStylePrompt,
  type loadConfig
} from "@book-maker/core";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Narrator previews.
 *
 * A sample is one short fixed passage per voice, shared by every book and every
 * user. Release builds ship pre-generated samples so opening this endpoint does
 * not depend on provider credentials or a live TTS request. The generated-audio
 * cache and provider fallback remain useful for local development and for a new
 * voice accidentally deployed before its bundled sample.
 *
 * The in-flight map matters more than it looks — a picker opening cold would
 * otherwise fire one request per voice card at the same time.
 */

const SAMPLE_TIMEOUT_MS = 15_000;
const BUNDLED_SAMPLE_DIR = fileURLToPath(new URL("../../assets/audiobook-samples/", import.meta.url));

const inFlight = new Map<string, Promise<Buffer>>();

export type AudiobookSampleConfig = Pick<ReturnType<typeof loadConfig>, "AUDIO_STORAGE_DIR" | "MOCK_AI" | "GEMINI_API_KEY" | "GEMINI_TTS_MODEL">;

export function voiceSampleDir(appConfig: { AUDIO_STORAGE_DIR: string }): string {
  return join(appConfig.AUDIO_STORAGE_DIR, "samples");
}

export async function ensureVoiceSample(appConfig: AudiobookSampleConfig, voice: string): Promise<Buffer> {
  const bundled = await readFile(join(BUNDLED_SAMPLE_DIR, `${voice}.mp3`)).catch(() => null);
  if (bundled) {
    return bundled;
  }

  const path = join(voiceSampleDir(appConfig), `${voice}.mp3`);
  const cached = await readFile(path).catch(() => null);
  if (cached) {
    return cached;
  }

  const pending = inFlight.get(voice);
  if (pending) {
    return pending;
  }

  const work = generateVoiceSample(appConfig, voice, path).finally(() => {
    inFlight.delete(voice);
  });
  inFlight.set(voice, work);
  return work;
}

async function generateVoiceSample(appConfig: AudiobookSampleConfig, voice: string, path: string): Promise<Buffer> {
  const speech = createSpeechAdapter(appConfig as Parameters<typeof createSpeechAdapter>[0]);
  const result = await withTimeout(
    speech.synthesize({
      text: AUDIOBOOK_SAMPLE_PASSAGE,
      voice,
      stylePrompt: narrationStylePrompt()
    }),
    SAMPLE_TIMEOUT_MS
  );

  const mp3 = encodePcm16ToMp3(result.pcm, {
    sampleRate: result.sampleRate,
    channels: result.channels,
    kbps: AUDIOBOOK_MP3_KBPS
  });

  await mkdir(voiceSampleDir(appConfig), { recursive: true });
  await writeFile(`${path}.part`, mp3);
  await rename(`${path}.part`, path);
  return mp3;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Narrator sample timed out.")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
