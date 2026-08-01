/**
 * PCM16 / WAV plumbing shared by every place that touches synthesized speech:
 * voice conversations, the audiobook narrator, and the TTS adapter.
 *
 * Everything here is format arithmetic on buffers — no provider knowledge — so
 * it can be unit tested without a network and reused by callers that never
 * speak to Gemini.
 */

export type Pcm16AudioChunk = {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
};

export type InlineAudioPayload = {
  data: string;
  mimeType?: string | undefined;
};

export const DEFAULT_TTS_SAMPLE_RATE = 24000;
export const DEFAULT_TTS_CHANNELS = 1;
export const DEFAULT_TTS_SAMPLE_WIDTH = 2;

export function wavFromPcm16(
  pcm: Buffer,
  options: { sampleRate?: number | undefined; channels?: number | undefined } = {}
): Buffer {
  const sampleRate = options.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
  const channels = options.channels ?? DEFAULT_TTS_CHANNELS;
  const byteRate = sampleRate * channels * DEFAULT_TTS_SAMPLE_WIDTH;
  const blockAlign = channels * DEFAULT_TTS_SAMPLE_WIDTH;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(DEFAULT_TTS_SAMPLE_WIDTH * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export function wavDurationMs(wav: Buffer): number | null {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bitsPerSample = wav.readUInt16LE(34);
  const dataSize = wav.readUInt32LE(40);
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return null;
  }
  return Math.round((dataSize / bytesPerSecond) * 1000);
}

export function parsePcm16Wav(wav: Buffer): Pcm16AudioChunk | null {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let data: Buffer | null = null;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = Math.min(chunkStart + chunkSize, wav.length);
    if (chunkEnd < chunkStart) {
      return null;
    }

    if (chunkId === "fmt " && chunkSize >= 16 && chunkStart + 16 <= wav.length) {
      audioFormat = wav.readUInt16LE(chunkStart);
      channels = wav.readUInt16LE(chunkStart + 2);
      sampleRate = wav.readUInt32LE(chunkStart + 4);
      bitsPerSample = wav.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      data = wav.subarray(chunkStart, chunkEnd);
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || !channels || !sampleRate || !data) {
    return null;
  }
  return {
    pcm: data,
    sampleRate,
    channels
  };
}

/** Milliseconds of audio a raw PCM16 buffer holds at the given format. */
export function pcm16DurationMs(chunk: Pcm16AudioChunk): number {
  const bytesPerSecond = chunk.sampleRate * chunk.channels * DEFAULT_TTS_SAMPLE_WIDTH;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return 0;
  }
  return (chunk.pcm.length / bytesPerSecond) * 1000;
}

/** A run of digital silence in the same format as `reference`. */
export function silencePcm16(reference: Pick<Pcm16AudioChunk, "sampleRate" | "channels">, silenceMs: number): Buffer {
  const frames = Math.max(0, Math.round((reference.sampleRate * silenceMs) / 1000));
  return Buffer.alloc(frames * reference.channels * DEFAULT_TTS_SAMPLE_WIDTH);
}

export function concatPcm16ChunksWithSilence(chunks: Pcm16AudioChunk[], silenceMs: number): Buffer {
  if (chunks.length === 0) {
    return Buffer.alloc(0);
  }
  const sampleRate = chunks[0]?.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
  const channels = chunks[0]?.channels ?? DEFAULT_TTS_CHANNELS;
  const silence = silencePcm16({ sampleRate, channels }, silenceMs);
  const parts: Buffer[] = [];

  chunks.forEach((chunk, index) => {
    assertMatchingPcmFormat(chunk, { sampleRate, channels });
    if (index > 0 && silence.length > 0) {
      parts.push(silence);
    }
    parts.push(chunk.pcm);
  });

  return Buffer.concat(parts);
}

export function assertMatchingPcmFormat(
  chunk: Pcm16AudioChunk,
  expected: Pick<Pcm16AudioChunk, "sampleRate" | "channels">
): void {
  if (chunk.sampleRate !== expected.sampleRate || chunk.channels !== expected.channels) {
    throw new Error("Synthesized audio changed format mid-stream and cannot be joined.");
  }
}

export function isWavAudio(mimeType: string | undefined, bytes: Buffer): boolean {
  return /wav|wave/i.test(mimeType ?? "") || (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF");
}

export function sampleRateFromMimeType(mimeType: string | undefined): number | undefined {
  const match = /rate=(\d+)/i.exec(mimeType ?? "");
  const rate = match?.[1] ? Number(match[1]) : undefined;
  return rate && Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/** Decode a base64 inline-audio payload into PCM16, unwrapping a WAV container. */
export function pcm16ChunkFromInlineAudio(inlineAudio: InlineAudioPayload): Pcm16AudioChunk {
  const audioBytes = Buffer.from(inlineAudio.data, "base64");
  if (isWavAudio(inlineAudio.mimeType, audioBytes)) {
    const chunk = parsePcm16Wav(audioBytes);
    if (!chunk) {
      throw new Error("Speech response was a WAV container without readable PCM16 audio.");
    }
    return chunk;
  }
  return {
    pcm: audioBytes,
    sampleRate: sampleRateFromMimeType(inlineAudio.mimeType) ?? DEFAULT_TTS_SAMPLE_RATE,
    channels: DEFAULT_TTS_CHANNELS
  };
}

export function wavFromInlineAudio(inlineAudio: InlineAudioPayload): Buffer {
  const audioBytes = Buffer.from(inlineAudio.data, "base64");
  const sourceSampleRate = sampleRateFromMimeType(inlineAudio.mimeType) ?? DEFAULT_TTS_SAMPLE_RATE;
  return isWavAudio(inlineAudio.mimeType, audioBytes) ? audioBytes : wavFromPcm16(audioBytes, { sampleRate: sourceSampleRate });
}
