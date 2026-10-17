import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "./fake.js";
import { ProviderHttpError, ProviderStreamInterruptedError, isTextProviderFallbackError } from "./retry.js";
import { FallbackTextModelAdapter, TextGenerationFallbackError, type TextFallbackEvent } from "./textFallback.js";
import type { TextAttemptBudget } from "./textAttemptBudget.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  JsonResult,
  TextModelAdapter,
  TextResult,
  ToolCallsResult
} from "./types.js";

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
    },
    generateWithTools: unsupportedGenerateWithTools
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
    expect(events.map((event) => event.event)).toEqual(["fallback.start", "fallback.success"]);
    expect(events[0]).toEqual(
      expect.objectContaining({
        event: "fallback.start",
        operation: "generateJson",
        purpose: "generate-page",
        attempt: 1,
        maxAttempts: 1,
        primary: expect.objectContaining({ provider: "gemini", model: "gemini-primary" }),
        fallback: { provider: "deepseek", model: "deepseek-fallback" }
      })
    );
    expect(events[1]).toEqual(
      expect.objectContaining({
        event: "fallback.success",
        result: { provider: "deepseek-fallback", model: "deepseek-fallback" }
      })
    );
  });

  it("does not fall back when shouldFallback rejects the error", async () => {
    const adapter = fallbackAdapter({
      primaryFails: true,
      shouldFallback: (error) => !(error instanceof Error && error.message.includes("gemini-primary"))
    });

    await expect(adapter.generateText({ messages: [] })).rejects.toThrow("gemini-primary failed");
  });

  it("throws a structured combined error and emits terminal lifecycle state when both models fail", async () => {
    const events: TextFallbackEvent[] = [];
    const adapter = fallbackAdapter({
      primaryFails: true,
      fallbackFails: true,
      onEvent: (event) => events.push(event)
    });

    await expect(adapter.generateText({ messages: [] })).rejects.toMatchObject({
      name: "TextGenerationFallbackError",
      operation: "generateText",
      primary: expect.objectContaining({ error: expect.objectContaining({ message: "gemini-primary failed" }) }),
      fallback: expect.objectContaining({ error: expect.objectContaining({ message: "deepseek-fallback failed" }) })
    } satisfies Partial<TextGenerationFallbackError>);
    expect(events.map((event) => event.event)).toEqual(["fallback.start", "fallback.error"]);
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

type Operation = "generateText" | "generateJson" | "generateWithTools" | "streamText";

/**
 * A provider that answers from a script, one entry per request: an error is
 * thrown (after streaming `partial` into the caller's observer, as a cut
 * stream would have), anything else is the answer. `calls` records each
 * request by model, so a test reads which provider answered in what order.
 */
function scripted(model: string, script: Array<Error | "ok">, calls: string[], partial?: string): TextModelAdapter {
  async function next(options: GenerateTextOptions): Promise<TextResult> {
    calls.push(model);
    const step = script.shift();
    if (step === undefined) throw new Error(`Unexpected extra request to ${model}`);
    if (step instanceof Error) {
      if (partial) await options.onOutputTextChunk?.(partial);
      throw step;
    }
    return { text: model, model, provider: model };
  }
  return {
    generateText: next,
    async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
      return { ...(await next(options)), data: { model } as T };
    },
    async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
      yield (await next(options)).text;
    },
    async generateWithTools(options: GenerateWithToolsOptions): Promise<ToolCallsResult> {
      return { ...(await next(options)), toolCalls: [] };
    }
  };
}

function scriptedPair(options: {
  primary: Array<Error | "ok">;
  fallback?: Array<Error | "ok">;
  partial?: string;
  onEvent?: (event: TextFallbackEvent) => void | Promise<void>;
}) {
  const calls: string[] = [];
  const events: TextFallbackEvent[] = [];
  const adapter = new FallbackTextModelAdapter({
    primary: { selection: { provider: "openai", model: "luna" }, adapter: scripted("luna", options.primary, calls, options.partial) },
    fallback: { selection: { provider: "deepseek", model: "v4" }, adapter: scripted("v4", options.fallback ?? [], calls) },
    // The production policy, as `LiveGenerationTextModelAdapter` builds the pair.
    shouldFallback: isTextProviderFallbackError,
    primaryRetryDelayMs: () => 0,
    onEvent: async (event) => {
      events.push(event);
      await options.onEvent?.(event);
    }
  });
  return { adapter, calls, events };
}

async function run(adapter: TextModelAdapter, operation: Operation, options: GenerateTextOptions = { messages: [] }) {
  switch (operation) {
    case "generateText":
      return (await adapter.generateText(options)).model;
    case "generateJson":
      return (await adapter.generateJson({ ...options, schema: undefined as never })).model;
    case "generateWithTools":
      return (await adapter.generateWithTools({ ...options, tools: [] })).model;
    case "streamText": {
      const chunks: string[] = [];
      for await (const chunk of adapter.streamText(options)) chunks.push(chunk);
      return chunks.join("");
    }
  }
}

const interrupted = () => new ProviderStreamInterruptedError("OpenAI response stream ended without a completion event.");

describe.each<Operation>(["generateText", "generateJson", "generateWithTools", "streamText"])(
  "FallbackTextModelAdapter same-model retry (%s)",
  (operation) => {
    it("answers on the primary when a stream interrupted once, without touching the fallback", async () => {
      const pair = scriptedPair({ primary: [interrupted(), "ok"] });

      await expect(run(pair.adapter, operation)).resolves.toBe("luna");

      expect(pair.calls).toEqual(["luna", "luna"]);
      expect(pair.events.map((event) => event.event)).toEqual(["fallback.primary_retry"]);
      expect(pair.events[0]).toMatchObject({
        operation,
        primary: { provider: "openai", model: "luna", error: expect.objectContaining({ code: "PROVIDER_STREAM_INTERRUPTED" }) },
        fallback: { provider: "deepseek", model: "v4" },
        delayMs: 0,
        errorClass: "ProviderStreamInterruptedError(PROVIDER_STREAM_INTERRUPTED)"
      });
    });

    it("falls back only when the fresh primary request is interrupted too", async () => {
      const pair = scriptedPair({ primary: [interrupted(), interrupted()], fallback: ["ok"] });

      await expect(run(pair.adapter, operation)).resolves.toBe("v4");

      expect(pair.calls).toEqual(["luna", "luna", "v4"]);
      expect(pair.events.map((event) => event.event)).toEqual(["fallback.primary_retry", "fallback.start", "fallback.success"]);
    });

    it("falls back at once on a provider's content filter", async () => {
      const refused = new Error(
        '400 data: {"error":{"code":"data_inspection_failed","message":"Input text data may contain inappropriate content."}}'
      );
      const pair = scriptedPair({ primary: [refused], fallback: ["ok"] });

      await expect(run(pair.adapter, operation)).resolves.toBe("v4");

      expect(pair.calls).toEqual(["luna", "v4"]);
      expect(pair.events.map((event) => event.event)).toEqual(["fallback.start", "fallback.success"]);
    });

    it("never retries or falls back from a stop, and rethrows it", async () => {
      const stop = Object.assign(new Error("Generation stopped"), { name: "StopRequestedError" });
      const pair = scriptedPair({ primary: [stop], fallback: ["ok"] });

      await expect(run(pair.adapter, operation)).rejects.toBe(stop);

      expect(pair.calls).toEqual(["luna"]);
      expect(pair.events).toEqual([]);
    });

    it("leaves a waitable 429 to the caller's cooldown, and hops at once over a spent daily cap", async () => {
      const waitable = new ProviderHttpError("quota", { status: 429, retryAfterMs: 845 });
      const held = scriptedPair({ primary: [waitable], fallback: ["ok"] });
      await expect(run(held.adapter, operation)).rejects.toBe(waitable);
      expect(held.calls).toEqual(["luna"]);
      expect(held.events).toEqual([]);

      const daily = new ProviderHttpError("quota", { status: 429, retryAfterMs: 20_698_000 });
      const hopped = scriptedPair({ primary: [daily], fallback: ["ok"] });
      await expect(run(hopped.adapter, operation)).resolves.toBe("v4");
      expect(hopped.calls).toEqual(["luna", "v4"]);
    });
  }
);

describe("FallbackTextModelAdapter same-model retry", () => {
  it("retries a 502/503/504 and a reset connection the same way", async () => {
    for (const error of [
      new ProviderHttpError("bad gateway", { status: 502 }),
      new ProviderHttpError("unavailable", { status: 503 }),
      new ProviderHttpError("Jev attempt deadline", { status: 504 }),
      Object.assign(new TypeError("terminated"), { cause: { name: "SocketError", code: "UND_ERR_SOCKET", message: "other side closed" } })
    ]) {
      const pair = scriptedPair({ primary: [error, "ok"] });
      await expect(pair.adapter.generateText({ messages: [] })).resolves.toMatchObject({ model: "luna" });
      expect(pair.calls).toEqual(["luna", "luna"]);
    }
  });

  it("retries once per logical call, so a retry loop around the pair does not multiply it", async () => {
    // The worker's network retry re-enters the pair with the same options and
    // therefore the same attempt budget; the second pass must hop at once.
    const pair = scriptedPair({ primary: [interrupted(), interrupted(), interrupted()], fallback: [interrupted(), "ok"] });
    const options: GenerateTextOptions = {
      messages: [],
      textAttemptBudget: { limit: 10, used: 0, outputWidened: false } satisfies TextAttemptBudget
    };

    await expect(pair.adapter.generateText(options)).rejects.toBeInstanceOf(TextGenerationFallbackError);
    await expect(pair.adapter.generateText(options)).resolves.toMatchObject({ model: "v4" });

    expect(pair.calls).toEqual(["luna", "luna", "v4", "luna", "v4"]);
    expect(pair.events.filter((event) => event.event === "fallback.primary_retry")).toHaveLength(1);
  });

  it("does not spend the last attempt of a budget on the primary again", async () => {
    const pair = scriptedPair({ primary: [interrupted()] });
    const options: GenerateTextOptions = {
      messages: [],
      textAttemptBudget: { limit: 5, used: 5, outputWidened: false }
    };

    await expect(pair.adapter.generateText(options)).rejects.toThrow("exhausted its 5 provider attempts");
    expect(pair.calls).toEqual(["luna"]);
  });

  it("reports the partial output the fresh request starts over from", async () => {
    const streamedEnglish = scriptedPair({ primary: [interrupted(), "ok"], partial: "x".repeat(4_000) });
    const seen: string[] = [];
    await streamedEnglish.adapter.generateText({ messages: [], onOutputTextChunk: (chunk) => void seen.push(chunk) });
    expect(streamedEnglish.events[0]).toMatchObject({ partialOutputTokens: 1_000, partialOutputEstimated: true });
    // The caller's own observer still saw the stream.
    expect(seen).toEqual(["x".repeat(4_000)]);

    const counted = Object.assign(interrupted(), { provider: "openai", model: "luna", usage: { outputTokens: 4_063 } });
    const reported = scriptedPair({ primary: [counted, "ok"] });
    await reported.adapter.generateText({ messages: [] });
    expect(reported.events[0]).toMatchObject({ partialOutputTokens: 4_063, partialOutputEstimated: false });

    const unobserved = scriptedPair({ primary: [interrupted(), "ok"] });
    await unobserved.adapter.generateText({ messages: [] });
    expect(unobserved.events[0]).toMatchObject({ partialOutputTokens: null, partialOutputEstimated: false });
  });

  it("ends the pause before a retry on a stop, and rethrows the stop instead of falling back", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const adapter = new FallbackTextModelAdapter({
      primary: { selection: { provider: "openai", model: "luna" }, adapter: scripted("luna", [interrupted(), "ok"], calls) },
      fallback: { selection: { provider: "deepseek", model: "v4" }, adapter: scripted("v4", ["ok"], calls) },
      shouldFallback: () => true,
      primaryRetryDelayMs: () => 60_000,
      onEvent: (event) => {
        if (event.event === "fallback.primary_retry") controller.abort();
      }
    });

    await expect(adapter.generateText({ messages: [], signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["luna"]);
  });

  it("hops at once when told not to retry the primary", async () => {
    const calls: string[] = [];
    const adapter = new FallbackTextModelAdapter({
      primary: { selection: { provider: "openai", model: "luna" }, adapter: scripted("luna", [interrupted()], calls) },
      fallback: { selection: { provider: "deepseek", model: "v4" }, adapter: scripted("v4", ["ok"], calls) },
      retryPrimary: false
    });

    await expect(adapter.generateText({ messages: [] })).resolves.toMatchObject({ model: "v4" });
    expect(calls).toEqual(["luna", "v4"]);
  });

  it("does not retry a streamText primary that already yielded", async () => {
    const calls: string[] = [];
    const adapter = new FallbackTextModelAdapter({
      primary: {
        selection: { provider: "openai", model: "luna" },
        adapter: {
          ...scripted("luna", [], calls),
          async *streamText() {
            calls.push("luna");
            yield "partial";
            throw interrupted();
          }
        }
      },
      fallback: { selection: { provider: "deepseek", model: "v4" }, adapter: scripted("v4", ["ok"], calls) },
      primaryRetryDelayMs: () => 0
    });

    await expect(async () => {
      for await (const _chunk of adapter.streamText({ messages: [] })) {
        // drain
      }
    }).rejects.toBeInstanceOf(ProviderStreamInterruptedError);
    expect(calls).toEqual(["luna"]);
  });
});

describe("FallbackTextModelAdapter diagnostics", () => {
  it("lets no failed event write decide the call", async () => {
    const failing = async () => {
      throw new Error("run log unavailable");
    };
    const retried = scriptedPair({ primary: [interrupted(), "ok"], onEvent: failing });
    await expect(retried.adapter.generateText({ messages: [] })).resolves.toMatchObject({ model: "luna" });

    // `fallback.success` is emitted inside the try around the fallback: a throw
    // there used to discard the fallback's answer as a fallback failure.
    const refused = new Error('400 data: {"error":{"code":"data_inspection_failed"}}');
    const hopped = scriptedPair({ primary: [refused], fallback: ["ok"], onEvent: failing });
    await expect(hopped.adapter.generateText({ messages: [] })).resolves.toMatchObject({ model: "v4" });
  });

  it("still lets a cancellation raised by an observer travel", async () => {
    const stop = Object.assign(new Error("Generation stopped"), { name: "StopRequestedError" });
    const pair = scriptedPair({
      primary: [interrupted(), "ok"],
      onEvent: () => {
        throw stop;
      }
    });
    await expect(pair.adapter.generateText({ messages: [] })).rejects.toBe(stop);
    expect(pair.calls).toEqual(["luna"]);
  });
});
