import { Mp3Encoder } from "@breezystack/lamejs";
import { DEFAULT_TTS_CHANNELS, DEFAULT_TTS_SAMPLE_RATE, DEFAULT_TTS_SAMPLE_WIDTH } from "../audio/pcm.js";

/**
 * PCM16 → MP3, in pure JavaScript.
 *
 * A chapter of raw 24 kHz mono WAV runs about 2.9 MB per minute, so a two-hour
 * book would be several hundred megabytes to download and store on a phone.
 * Mono MP3 at 64 kbps is roughly a sixth of that and is transparent for speech.
 * The encoder is JS rather than an ffmpeg binding so the worker keeps working in
 * plain `pnpm dev` and inside the Docker image with no native dependency.
 */

export const AUDIOBOOK_MP3_KBPS = 64;

const SAMPLES_PER_ENCODE_BLOCK = 1152 * 8;

export function encodePcm16ToMp3(
  pcm: Buffer,
  options: { sampleRate?: number | undefined; channels?: number | undefined; kbps?: number | undefined } = {}
): Buffer {
  const sampleRate = options.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
  const channels = options.channels ?? DEFAULT_TTS_CHANNELS;
  const kbps = options.kbps ?? AUDIOBOOK_MP3_KBPS;

  if (channels !== 1 && channels !== 2) {
    throw new Error(`Audiobook MP3 encoding supports mono or stereo, not ${channels} channels.`);
  }

  const samples = pcm16Samples(pcm);
  const encoder = new Mp3Encoder(channels, sampleRate, kbps);
  const parts: Buffer[] = [];
  const frameSize = SAMPLES_PER_ENCODE_BLOCK * channels;

  for (let offset = 0; offset < samples.length; offset += frameSize) {
    const block = samples.subarray(offset, Math.min(offset + frameSize, samples.length));
    const encoded =
      channels === 1 ? encoder.encodeBuffer(block) : encoder.encodeBuffer(...deinterleaveStereo(block));
    if (encoded.length > 0) {
      parts.push(Buffer.from(encoded));
    }
  }

  const tail = encoder.flush();
  if (tail.length > 0) {
    parts.push(Buffer.from(tail));
  }

  return Buffer.concat(parts);
}

/**
 * Reads the buffer as little-endian Int16 without copying when it is already
 * aligned, which it is for every PCM chunk we build ourselves.
 */
function pcm16Samples(pcm: Buffer): Int16Array {
  const usableLength = pcm.length - (pcm.length % DEFAULT_TTS_SAMPLE_WIDTH);
  if (pcm.byteOffset % DEFAULT_TTS_SAMPLE_WIDTH === 0) {
    return new Int16Array(pcm.buffer, pcm.byteOffset, usableLength / DEFAULT_TTS_SAMPLE_WIDTH);
  }
  const aligned = Buffer.from(pcm.subarray(0, usableLength));
  return new Int16Array(aligned.buffer, aligned.byteOffset, usableLength / DEFAULT_TTS_SAMPLE_WIDTH);
}

function deinterleaveStereo(block: Int16Array): [Int16Array, Int16Array] {
  const frames = Math.floor(block.length / 2);
  const left = new Int16Array(frames);
  const right = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = block[frame * 2] ?? 0;
    right[frame] = block[frame * 2 + 1] ?? 0;
  }
  return [left, right];
}
