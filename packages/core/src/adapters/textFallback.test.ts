import { describe, expect, it } from "vitest";
import { FallbackTextModelAdapter, type TextFallbackEvent } from "./textFallback.js";
import type { GenerateJsonOptions, GenerateTextOptions, JsonResult, TextModelAdapter, TextResult } from "./types.js";

function stubAdapter(name: string, options?: { fail?: boolean }): TextModelAdapter {
  const result: TextResult = { text: name, model: name, provider: name };
  return {
    async generateText(): Promise<TextResult> {
      if (options?.fail) {
        throw new Error(`${name} failed`);
      }
      return result;
    },
    async generateJson<T>(_options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
      if (options?.fail) {
        throw new Error(`${name} failed`);
      }
      return { ...result, data: undefined as T };
    },
    async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
      if (options?.fail) {
        throw new Error(`${name} failed`);
      }
      yield name;
    }
  };
}

function fallbackAdapter(options: {
  primaryFails?: boolean;
  fallbackFails?: boolean;
  shouldFallback?: (error: unknown) => boolean;
  onEvent?: (event: TextFallbackEvent) => void;
  lazyFallback?: () => TextModelAdapter;
}) {
  return new FallbackTextModelAdapter({
    primary: {
      selection: { provider: "gemini", model: "gemini-primary" },
      adapter: stubAdapter("gemini-primary", { fail: options.primaryFails ?? false })
    },
    fallback: {
      selection: { provider: "deepseek", model: "deepseek-fallback" },
      adapter: options.lazyFallback ?? stubAdapter("deepseek-fallback", { fail: options.fallbackFails ?? false })
    },
    ...(options.shouldFallback ? { shouldFallback: options.shouldFallback } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {})
  });
}

describe("FallbackTextModelAdapter", () => {
  it("returns the primary result when the primary succeeds", async () => {
    const adapter = fallbackAdapter({});

    const result = await adapter.generateText({ messages: [], purpose: "generate-page" });

    expect(result.model).toBe("gemini-primary");
  });

  it("falls back and reports the fallback's own provider/model on primary failure", async () => {
    const events: TextFallbackEvent[] = [];
    const adapter = fallbackAdapter({ primaryFails: true, onEvent: (event) => events.push(event) });

    const result = await adapter.generateJson({ messages: [], purpose: "generate-page", schema: undefined as never });

    expect(result.provider).toBe("deepseek-fallback");
    expect(result.model).toBe("deepseek-fallback");
    expect(events).toEqual([
      expect.objectContaining({
        event: "fallback.start",
        operation: "generateJson",
        purpose: "generate-page",
        primary: expect.objectContaining({ provider: "gemini", model: "gemini-primary" }),
        fallback: { provider: "deepseek", model: "deepseek-fallback" }
      })
    ]);
  });

  it("does not fall back when shouldFallback rejects the error", async () => {
    const adapter = fallbackAdapter({
      primaryFails: true,
      shouldFallback: (error) => !(error instanceof Error && error.message.includes("gemini-primary"))
    });

    await expect(adapter.generateText({ messages: [] })).rejects.toThrow("gemini-primary failed");
  });

  it("throws the fallback error when both models fail", async () => {
    const adapter = fallbackAdapter({ primaryFails: true, fallbackFails: true });

    await expect(adapter.generateText({ messages: [] })).rejects.toThrow("deepseek-fallback failed");
  });

  it("builds the fallback adapter lazily and reuses it", async () => {
    let built = 0;
    const adapter = fallbackAdapter({
      primaryFails: true,
      lazyFallback: () => {
        built += 1;
        return stubAdapter("deepseek-fallback");
      }
    });

    expect(built).toBe(0);
    await adapter.generateText({ messages: [] });
    await adapter.generateText({ messages: [] });
    expect(built).toBe(1);
  });

  it("falls back on streamText only before any chunk is yielded", async () => {
    const preStreamFailure = fallbackAdapter({ primaryFails: true });
    const chunks: string[] = [];
    for await (const chunk of preStreamFailure.streamText({ messages: [] })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["deepseek-fallback"]);

    const midStreamFailure = new FallbackTextModelAdapter({
      primary: {
        selection: { provider: "gemini", model: "gemini-primary" },
        adapter: {
          ...stubAdapter("gemini-primary"),
          async *streamText() {
            yield "partial";
            throw new Error("mid-stream failure");
          }
        }
      },
      fallback: {
        selection: { provider: "deepseek", model: "deepseek-fallback" },
        adapter: stubAdapter("deepseek-fallback")
      }
    });
    await expect(async () => {
      for await (const _chunk of midStreamFailure.streamText({ messages: [] })) {
        // drain
      }
    }).rejects.toThrow("mid-stream failure");
  });
});
