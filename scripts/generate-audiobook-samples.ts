import {
  AUDIOBOOK_MP3_KBPS,
  AUDIOBOOK_NARRATORS,
  AUDIOBOOK_SAMPLE_PASSAGE,
  createSpeechAdapter,
  encodePcm16ToMp3,
  loadConfig,
  narrationStylePrompt
} from "../packages/core/src/index.js";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const outputDir = fileURLToPath(new URL("../apps/api/assets/audiobook-samples/", import.meta.url));
const config = { ...loadConfig(), MOCK_AI: false };

if (!config.GEMINI_API_KEY?.trim()) {
  throw new Error("GEMINI_API_KEY is required to generate narrator samples.");
}

await mkdir(outputDir, { recursive: true });
const speech = createSpeechAdapter(config);

for (const narrator of AUDIOBOOK_NARRATORS) {
  const result = await speech.synthesize({
    text: AUDIOBOOK_SAMPLE_PASSAGE,
    voice: narrator.voice,
    stylePrompt: narrationStylePrompt()
  });
  const mp3 = encodePcm16ToMp3(result.pcm, {
    sampleRate: result.sampleRate,
    channels: result.channels,
    kbps: AUDIOBOOK_MP3_KBPS
  });
  const path = join(outputDir, `${narrator.voice}.mp3`);
  await writeFile(`${path}.part`, mp3);
  await rename(`${path}.part`, path);
  console.log(`${narrator.displayName}: ${result.durationMs} ms, ${mp3.byteLength} bytes`);
}
