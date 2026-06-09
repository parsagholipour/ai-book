import { describe, expect, it } from "vitest";
import { decodePcm16Base64, encodePcm16Base64, resampleFloat32 } from "./BrowserVoiceCallClient.js";

describe("Gemini Live audio helpers", () => {
  it("encodes and decodes clipped PCM16 audio", () => {
    const encoded = encodePcm16Base64(new Float32Array([-2, -0.5, 0, 0.5, 2]), 16000, 16000);
    const decoded = decodePcm16Base64(encoded);

    expect(decoded).toHaveLength(5);
    expect(decoded[0]).toBeCloseTo(-1, 4);
    expect(decoded[1]).toBeCloseTo(-0.5, 3);
    expect(decoded[2]).toBeCloseTo(0, 4);
    expect(decoded[3]).toBeCloseTo(0.5, 3);
    expect(decoded[4]).toBeCloseTo(1, 3);
  });

  it("resamples browser-rate audio down to Gemini input rate", () => {
    const input = new Float32Array(480);
    input.fill(0.25);

    const output = resampleFloat32(input, 48000, 16000);

    expect(output).toHaveLength(160);
    expect(output[0]).toBeCloseTo(0.25, 4);
    expect(output.at(-1)).toBeCloseTo(0.25, 4);
  });
});
