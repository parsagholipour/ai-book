import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAITextAdapter } from "./openai.js";
import { OPENAI_GPT_6_LUNA_MODEL, OPENAI_GPT_6_SOL_MODEL } from "./openaiModels.js";
import {
  isCancellationError,
  isRecoverableNetworkError,
  isStopOrAbortError,
  isTextPrimaryRetryError,
  isTextProviderFallbackError
} from "./retry.js";
import { withTextAttemptBudget } from "./textAttemptBudget.js";
import { FallbackTextModelAdapter, type TextFallbackEvent } from "./textFallback.js";
import { reportTextProviderRequest } from "./textProviderRequest.js";
import {
  PROVIDER_STALL_DEADLINE_CODE,
  ProviderStallDeadlineError,
  TextStallWatchdog,
  textStallDeadlineFor
} from "./textStallDeadline.js";
import type { GenerateTextOptions, TextModelAdapter, TextResult } from "./types.js";

/** One request's server side: it sends events when it likes, and may never finish. */
type Server = (send: (event: Record<string, unknown>) => void, finish: () => void) => void;

/**
 * A Responses endpoint over the real SDK, so the abort travels the way it does in
 * production: the SDK's own controller, a body read that ends on the abort, and an
 * iterator that swallows it and simply stops.
 */
function responsesEndpoint(servers: Server[]) {
  let requests = 0;
  const cacheKeys: unknown[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    requests += 1;
    cacheKeys.push(typeof init?.body === "string" ? (JSON.parse(init.body) as { prompt_cache_key?: unknown }).prompt_cache_key : undefined);
    const server = servers.shift();
    if (!server) throw new Error("Unexpected extra request");
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let open = true;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    init?.signal?.addEventListener("abort", () => {
      if (!open) return;
      open = false;
      controller.error(new DOMException("This operation was aborted", "AbortError"));
    }, { once: true });
    server(
      (event) => { if (open) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); },
      () => { if (open) { open = false; controller.close(); } }
    );
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, requests: () => requests, cacheKeys: () => cacheKeys };
}

function luna(endpoint: ReturnType<typeof responsesEndpoint>, model = OPENAI_GPT_6_LUNA_MODEL): OpenAITextAdapter {
  const adapter = new OpenAITextAdapter({ apiKey: "test-key", model, thinkingEffort: "none" });
  (adapter as unknown as { client: OpenAI }).client = new OpenAI({ apiKey: "test-key", maxRetries: 0, fetch: endpoint.fetch as never });
  return adapter;
}

const created = { type: "response.created", response: { id: "resp_1", model: OPENAI_GPT_6_LUNA_MODEL, status: "in_progress" } };
const delta = (text: string) => ({ type: "response.output_text.delta", delta: text });
const completed = (text: string) => ({
  type: "response.completed",
  response: { id: "resp_1", model: OPENAI_GPT_6_LUNA_MODEL, status: "completed", output_text: text, output: [],
    usage: { input_tokens: 10, output_tokens: 20 } }
});

/** Sends `count` one-token deltas at `perSecond`, then completes. */
function steady(perSecond: number, count: number): Server {
  return (send, finish) => {
    send(created);
    let sent = 0;
    const tick = () => {
      if (sent < count) {
        sent += 1;
        send(delta("word "));
        setTimeout(tick, 1_000 / perSecond);
        return;
      }
      send(completed("word ".repeat(count)));
      finish();
    };
    setTimeout(tick, 1_000 / perSecond);
  };
}

/** Starts answering, then goes silent for good. */
const goesSilent: Server = (send) => {
  send(created);
  for (const text of ["The ", "chapter ", "begins"]) send(delta(text));
};

const request = (extra: Partial<GenerateTextOptions> = {}): GenerateTextOptions => ({
  messages: [{ role: "user", content: "Write the chapter." }],
  purpose: "compose-chapter",
  maxTokens: 4_000,
  onOutputTextChunk: () => undefined,
  ...extra
});

/** The promise's state without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; error?: unknown; value?: T } = { settled: false };
  promise.then((value) => Object.assign(state, { settled: true, value }), (error: unknown) => Object.assign(state, { settled: true, error }));
  return state;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("the stall deadline on a streamed gpt-6-luna request", () => {
  it("ends a stream that goes 30 s without an event, as a 504 the same-model retry takes and no stop predicate claims", async () => {
    const endpoint = responsesEndpoint([goesSilent]);
    const call = track(luna(endpoint).generateText(request()));

    await vi.advanceTimersByTimeAsync(29_000);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(call.error).toBeInstanceOf(ProviderStallDeadlineError);
    expect(call.error).toMatchObject({
      status: 504,
      code: PROVIDER_STALL_DEADLINE_CODE,
      stall: { model: OPENAI_GPT_6_LUNA_MODEL, rule: "idle", outputTokens: 3, deadline: { idleMs: 30_000 } }
    });
    expect((call.error as ProviderStallDeadlineError).cause).toBeUndefined();
    expect(isTextPrimaryRetryError(call.error)).toBe(true);
    expect(isTextProviderFallbackError(call.error)).toBe(true);
    expect(isRecoverableNetworkError(call.error)).toBe(true);
    expect(isCancellationError(call.error)).toBe(false);
    expect(isStopOrAbortError(call.error)).toBe(false);
  });

  it("ends a trickle that falls behind 25 tokens a second, the shape both measured slow calls had", async () => {
    // 5 tokens a second never leaves a gap near 30 s, so only the pace can end it:
    // (t - t1) > 30 s + n / 25 with n = 5 (t - t1) lands about 37.5 s after the first token.
    const endpoint = responsesEndpoint([steady(5, 10_000)]);
    const call = track(luna(endpoint).generateText(request()));

    await vi.advanceTimersByTimeAsync(36_000);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(call.error).toBeInstanceOf(ProviderStallDeadlineError);
    const stall = (call.error as ProviderStallDeadlineError).stall;
    expect(stall.rule).toBe("pace");
    expect(stall.sinceLastEventMs).toBeLessThan(250);
    expect(stall.outputTokens).toBeGreaterThan(180);
    expect(stall.outputTokens).toBeLessThan(195);
  });

  it("lets a slow but steady stream finish: 30 tokens a second for a minute", async () => {
    const endpoint = responsesEndpoint([steady(30, 1_800)]);
    const call = track(luna(endpoint).generateText(request()));

    await vi.advanceTimersByTimeAsync(61_000);

    expect(call.error).toBeUndefined();
    expect((call.value as TextResult).text).toBe("word ".repeat(1_800));
  });

  it("is kept alive through a reasoning phase longer than the idle limit by the reasoning items it closes", async () => {
    const thinking: Server = (send, finish) => {
      send(created);
      for (let item = 0; item < 10; item += 1) {
        setTimeout(() => send({ type: "response.output_item.done", item: { type: "reasoning", id: `rs_${item}` } }), (item + 1) * 4_000);
      }
      setTimeout(() => {
        send(delta("Verdict."));
        send(completed("Verdict."));
        finish();
      }, 42_000);
    };
    const call = track(luna(responsesEndpoint([thinking])).generateText(request()));

    await vi.advanceTimersByTimeAsync(43_000);

    expect(call.error).toBeUndefined();
    expect((call.value as TextResult).text).toBe("Verdict.");
  });

  it("does not count the caller's own time between two chunks as the provider's silence", async () => {
    const fast: Server = (send, finish) => {
      send(created);
      for (let i = 0; i < 10; i += 1) send(delta("word "));
      send(completed("word ".repeat(10)));
      finish();
    };
    let first = true;
    const call = track(luna(responsesEndpoint([fast])).generateText(request({
      // A chunk observer that sits on the first chunk for 45 s — a slow database write, say.
      onOutputTextChunk: async () => {
        if (!first) return;
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 45_000));
      }
    })));

    await vi.advanceTimersByTimeAsync(46_000);

    expect(call.error).toBeUndefined();
    expect((call.value as TextResult).text).toBe("word ".repeat(10));
  });

  it("leaves a stop a stop: the caller's abort during a stall is never a 504, and nothing retries it", async () => {
    const endpoint = responsesEndpoint([goesSilent]);
    const stop = new AbortController();
    const fallbackCalls: string[] = [];
    const events: TextFallbackEvent[] = [];
    const pair = new FallbackTextModelAdapter({
      primary: { selection: { provider: "openai", model: OPENAI_GPT_6_LUNA_MODEL }, adapter: luna(endpoint) },
      fallback: { selection: { provider: "deepseek", model: "deepseek-v4-pro" }, adapter: answeringFallback(fallbackCalls) },
      shouldFallback: isTextProviderFallbackError,
      onEvent: (event) => { events.push(event); },
      primaryRetryDelayMs: () => 1_000
    });
    const call = track(pair.generateText(withTextAttemptBudget(request({ signal: stop.signal }))));

    await vi.advanceTimersByTimeAsync(10_000);
    stop.abort();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(call.settled).toBe(true);
    expect(call.error).not.toBeInstanceOf(ProviderStallDeadlineError);
    // The SDK ends an aborted stream quietly; the adapter answers it as the stop it was.
    expect(isCancellationError(call.error)).toBe(true);
    expect(endpoint.requests()).toBe(1);
    expect(fallbackCalls).toEqual([]);
    expect(events.map((event) => event.event)).not.toContain("stall_deadline");
  });

  it("answers a deadline that fired as the caller's stop when the caller cancelled before the adapter asked", async () => {
    const watchdog = TextStallWatchdog.start(OPENAI_GPT_6_LUNA_MODEL)!;
    const stop = new AbortController();
    const signal = watchdog.signalFor(stop.signal);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(signal.aborted).toBe(true);
    expect(watchdog.failure(stop.signal)).toBeInstanceOf(ProviderStallDeadlineError);
    stop.abort();
    expect(watchdog.failure(stop.signal)).toBeUndefined();
    watchdog.dispose();
  });

  it("is set per model in one table, and a model nobody measured has none", () => {
    expect(textStallDeadlineFor(OPENAI_GPT_6_LUNA_MODEL)).toEqual({ idleMs: 30_000, minTokensPerSecond: 25 });
    expect(textStallDeadlineFor(OPENAI_GPT_6_SOL_MODEL)).toBeUndefined();
    expect(textStallDeadlineFor("toString")).toBeUndefined();
    expect(TextStallWatchdog.start(OPENAI_GPT_6_SOL_MODEL)).toBeUndefined();
  });
});

describe("a stalled primary through the fallback pair", () => {
  function pairOver(endpoint: ReturnType<typeof responsesEndpoint>, fallbackCalls: string[], events: TextFallbackEvent[]) {
    return new FallbackTextModelAdapter({
      primary: { selection: { provider: "openai", model: OPENAI_GPT_6_LUNA_MODEL }, adapter: luna(endpoint) },
      fallback: { selection: { provider: "deepseek", model: "deepseek-v4-pro" }, adapter: answeringFallback(fallbackCalls) },
      shouldFallback: isTextProviderFallbackError,
      onEvent: (event) => { events.push(event); },
      primaryRetryDelayMs: () => 1_000
    });
  }

  it("gets one fresh request on the same model, which answers, and the stall is written down first", async () => {
    const endpoint = responsesEndpoint([goesSilent, steady(200, 20)]);
    const fallbackCalls: string[] = [];
    const events: TextFallbackEvent[] = [];
    const call = track(pairOver(endpoint, fallbackCalls, events).generateText(withTextAttemptBudget(request())));

    await vi.advanceTimersByTimeAsync(35_000);

    expect(call.error).toBeUndefined();
    expect(call.value).toMatchObject({ provider: "openai", text: "word ".repeat(20) });
    expect(endpoint.requests()).toBe(2);
    expect(fallbackCalls).toEqual([]);
    expect(events.map((event) => event.event)).toEqual(["stall_deadline", "fallback.primary_retry"]);
    expect(events[0]).toMatchObject({
      operation: "generateText",
      purpose: "compose-chapter",
      primary: { model: OPENAI_GPT_6_LUNA_MODEL, error: { name: "ProviderStallDeadlineError", status: 504 } },
      stall: { rule: "idle", outputTokens: 3 }
    });
    expect(events[1]).toMatchObject({ errorClass: `ProviderStallDeadlineError(${PROVIDER_STALL_DEADLINE_CODE})` });
  });

  it("lets a fresh request that trickles too finish on the same model, under another cache key, and never hops", async () => {
    // Both requests stream 5 tokens a second. The first is cut by the pace rule about
    // 37.5 s in; the second writes 300 tokens in 60 s, which the pace rule would have
    // ended at 42 s, and finishes because the request after a stall answers only to idle.
    const endpoint = responsesEndpoint([steady(5, 10_000), steady(5, 300)]);
    const fallbackCalls: string[] = [];
    const events: TextFallbackEvent[] = [];
    const call = track(pairOver(endpoint, fallbackCalls, events).generateText(withTextAttemptBudget(request())));

    await vi.advanceTimersByTimeAsync(105_000);

    expect(call.error).toBeUndefined();
    expect(call.value).toMatchObject({ provider: "openai", text: "word ".repeat(300) });
    expect(endpoint.requests()).toBe(2);
    expect(fallbackCalls).toEqual([]);
    expect(events.map((event) => event.event)).toEqual(["stall_deadline", "fallback.primary_retry"]);
    expect(events[0]).toMatchObject({ stall: { rule: "pace" } });
    const [first, second] = endpoint.cacheKeys();
    expect(typeof first).toBe("string");
    expect(typeof second).toBe("string");
    expect(second).not.toBe(first);
  });

  it("retries any other failure on the same cache key, with the pace rule still on", async () => {
    const cutShort: Server = (send, finish) => {
      send(created);
      send(delta("The "));
      finish();
    };
    const endpoint = responsesEndpoint([cutShort, steady(200, 20)]);
    const fallbackCalls: string[] = [];
    const events: TextFallbackEvent[] = [];
    const call = track(pairOver(endpoint, fallbackCalls, events).generateText(withTextAttemptBudget(request())));

    await vi.advanceTimersByTimeAsync(5_000);

    expect(call.value).toMatchObject({ provider: "openai", text: "word ".repeat(20) });
    expect(events.map((event) => event.event)).toEqual(["fallback.primary_retry"]);
    const [first, second] = endpoint.cacheKeys();
    expect(second).toBe(first);
  });

  it("hops to the fallback when the fresh request goes silent too, and still retries only once", async () => {
    const endpoint = responsesEndpoint([goesSilent, goesSilent]);
    const fallbackCalls: string[] = [];
    const events: TextFallbackEvent[] = [];
    const call = track(pairOver(endpoint, fallbackCalls, events).generateText(withTextAttemptBudget(request())));

    await vi.advanceTimersByTimeAsync(70_000);

    expect(call.error).toBeUndefined();
    expect(call.value).toMatchObject({ provider: "deepseek" });
    expect(endpoint.requests()).toBe(2);
    expect(fallbackCalls).toEqual(["deepseek-v4-pro"]);
    expect(events.map((event) => event.event)).toEqual([
      "stall_deadline", "fallback.primary_retry", "stall_deadline", "fallback.start", "fallback.success"
    ]);
  });
});

/** A fallback writer that answers, spending the shared attempt budget like a real adapter. */
function answeringFallback(calls: string[]): TextModelAdapter {
  const answer = async (options: GenerateTextOptions): Promise<TextResult> => {
    await reportTextProviderRequest(options, "deepseek", "deepseek-v4-pro", undefined);
    calls.push("deepseek-v4-pro");
    return { text: "The chapter, written by the fallback.", provider: "deepseek", model: "deepseek-v4-pro" };
  };
  return {
    generateText: answer,
    generateJson: async (options) => ({ ...(await answer(options)), data: {} as never }),
    generateWithTools: async (options) => ({ ...(await answer(options)), toolCalls: [] }),
    async *streamText(options) {
      yield (await answer(options)).text;
    }
  };
}
