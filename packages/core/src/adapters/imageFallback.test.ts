import { describe, expect, it } from "vitest";
import { FallbackImageAdapter, ImageGenerationFallbackError, type ImageFallbackEvent } from "./imageFallback.js";
import type { ImageAdapter, ImageRequest, ImageResult } from "./types.js";

describe("FallbackImageAdapter", () => {
  it("tries the fallback provider and preserves the primary error on success", async () => {
    const events: ImageFallbackEvent[] = [];
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "alibaba",
        model: "qwen-image-2.0",
        adapter: new FailingImageAdapter("Qwen unavailable")
      },
      fallback: {
        provider: "gemini",
        model: "gemini-2.5-flash-image",
        adapter: new StaticImageAdapter({
          provider: "gemini",
          model: "gemini-2.5-flash-image",
          mimeType: "image/png",
          data: Buffer.from("fallback")
        })
      },
      onEvent: (event) => {
        events.push(event);
      }
    });

    const result = await adapter.generateImage({ prompt: "paint a tiny house" });

    expect(result.provider).toBe("gemini");
    expect(result.fallback).toMatchObject({
      used: true,
      primary: {
        provider: "alibaba",
        model: "qwen-image-2.0",
        error: { message: "Qwen unavailable" }
      },
      fallback: {
        provider: "gemini",
        model: "gemini-2.5-flash-image"
      }
    });
    expect(events.map((event) => event.event)).toEqual(["fallback.start", "fallback.success"]);
  });

  it("throws a combined error when the fallback provider also fails", async () => {
    const events: ImageFallbackEvent[] = [];
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-2.5-flash-image",
        adapter: new FailingImageAdapter("Gemini unavailable")
      },
      fallback: {
        provider: "alibaba",
        model: "qwen-image-2.0",
        adapter: new FailingImageAdapter("Qwen unavailable")
      },
      onEvent: (event) => {
        events.push(event);
      }
    });

    await expect(adapter.generateImage({ prompt: "paint a tiny house" })).rejects.toMatchObject({
      name: "ImageGenerationFallbackError",
      primary: {
        provider: "gemini",
        model: "gemini-2.5-flash-image",
        error: { message: "Gemini unavailable" }
      },
      fallback: {
        provider: "alibaba",
        model: "qwen-image-2.0",
        error: { message: "Qwen unavailable" }
      }
    } satisfies Partial<ImageGenerationFallbackError>);
    expect(events.map((event) => event.event)).toEqual(["fallback.start", "fallback.error"]);
  });
});

class StaticImageAdapter implements ImageAdapter {
  constructor(private readonly result: ImageResult) {}

  async generateImage(_request: ImageRequest): Promise<ImageResult> {
    return this.result;
  }
}

class FailingImageAdapter implements ImageAdapter {
  constructor(private readonly message: string) {}

  async generateImage(_request: ImageRequest): Promise<ImageResult> {
    throw new Error(this.message);
  }
}
