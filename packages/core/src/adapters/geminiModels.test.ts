import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEMINI_IMAGE_MODEL,
  IMAGEN_4_FAST_IMAGE_MODEL,
  geminiImageModelOptions,
  geminiImageReferenceLimit,
  isGeminiNativeImageModel,
  normalizeGeminiImageModel
} from "./geminiModels.js";

describe("Gemini image model normalization", () => {
  it("uses the current native Gemini image default when no model is configured", () => {
    expect(normalizeGeminiImageModel(undefined)).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
    expect(normalizeGeminiImageModel("   ")).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
  });

  it("maps retired Imagen 4 preview models to GA model IDs", () => {
    expect(normalizeGeminiImageModel("imagen-4.0-generate-preview-06-06")).toBe("imagen-4.0-generate-001");
    expect(normalizeGeminiImageModel("imagen-4.0-ultra-generate-preview-06-06")).toBe("imagen-4.0-ultra-generate-001");
    expect(normalizeGeminiImageModel("imagen-4.0-fast-generate-preview-06-06")).toBe("imagen-4.0-fast-generate-001");
  });

  it("accepts model names copied from API error paths", () => {
    expect(normalizeGeminiImageModel("models/imagen-4.0-generate-preview-06-06")).toBe("imagen-4.0-generate-001");
  });

  it("detects Gemini native image models", () => {
    expect(isGeminiNativeImageModel("gemini-2.5-flash-image")).toBe(true);
    expect(isGeminiNativeImageModel("models/gemini-3-pro-image-preview")).toBe(true);
    expect(isGeminiNativeImageModel("imagen-4.0-generate-001")).toBe(false);
  });

  it("reports reference image limits by model family", () => {
    expect(geminiImageReferenceLimit("gemini-2.5-flash-image")).toBe(3);
    expect(geminiImageReferenceLimit("gemini-3-pro-image-preview")).toBe(5);
    expect(geminiImageReferenceLimit("gemini-3.1-flash-image")).toBe(4);
    expect(geminiImageReferenceLimit("imagen-4.0-generate-001")).toBe(0);
  });

  it("lists native and cheaper Imagen image model options", () => {
    const options = geminiImageModelOptions();

    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: DEFAULT_GEMINI_IMAGE_MODEL,
          supportsReferenceImages: true,
          costUsd: 0.039
        }),
        expect.objectContaining({
          model: IMAGEN_4_FAST_IMAGE_MODEL,
          supportsReferenceImages: false,
          costUsd: 0.02
        })
      ])
    );
  });

  it("keeps an env-configured custom image model selectable", () => {
    expect(geminiImageModelOptions("models/gemini-3-pro-image-preview")[0]).toMatchObject({
      model: "gemini-3-pro-image-preview",
      supportsReferenceImages: true
    });
  });
});
