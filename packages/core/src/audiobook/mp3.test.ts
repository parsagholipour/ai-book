import { describe, expect, it } from "vitest";
import { DEFAULT_TTS_SAMPLE_RATE, wavFromPcm16 } from "../audio/pcm.js";
import { encodePcm16ToMp3 } from "./mp3.js";

function tone(seconds: number): Buffer {
  const frames = DEFAULT_TTS_SAMPLE_RATE * seconds;
  const pcm = Buffer.alloc(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((frame * 2 * Math.PI * 220) / DEFAULT_TTS_SAMPLE_RATE) * 6000), frame * 2);
  }
  return pcm;
}

describe("audiobook mp3 encoding", () => {
  it("produces a file that starts like an MP3", () => {
    const mp3 = encodePcm16ToMp3(tone(1));
    expect(mp3.length).toBeGreaterThan(0);
    // Either an ID3 tag or a frame sync; lamejs emits the latter.
    const startsWithFrameSync = mp3[0] === 0xff && (mp3[1]! & 0xe0) === 0xe0;
    const startsWithId3 = mp3.toString("ascii", 0, 3) === "ID3";
    expect(startsWithFrameSync || startsWithId3).toBe(true);
  });

  it("is dramatically smaller than the raw audio, which is the whole point", () => {
    const pcm = tone(10);
    const mp3 = encodePcm16ToMp3(pcm);
    // 64 kbps mono is about a sixth of 24 kHz 16-bit PCM.
    expect(mp3.length).toBeLessThan(pcm.length / 4);
    expect(mp3.length).toBeGreaterThan(1000);
  });

  it("scales with the length of the audio", () => {
    const short = encodePcm16ToMp3(tone(1));
    const long = encodePcm16ToMp3(tone(4));
    expect(long.length).toBeGreaterThan(short.length * 2);
  });

  it("accepts a PCM view that is not aligned to the start of its buffer", () => {
    // Buffers sliced out of a larger read can carry an odd byteOffset, which
    // Int16Array refuses to view directly.
    const padded = Buffer.concat([Buffer.alloc(1), tone(1)]);
    expect(() => encodePcm16ToMp3(padded.subarray(1))).not.toThrow();
  });

  it("encodes silence without complaint", () => {
    expect(encodePcm16ToMp3(Buffer.alloc(DEFAULT_TTS_SAMPLE_RATE * 2)).length).toBeGreaterThan(0);
  });

  it("refuses a channel count it cannot encode instead of writing nonsense", () => {
    expect(() => encodePcm16ToMp3(tone(1), { channels: 5 })).toThrow(/mono or stereo/i);
  });

  it("leaves the WAV helper untouched for callers that still want raw audio", () => {
    const wav = wavFromPcm16(tone(1));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  });
});
