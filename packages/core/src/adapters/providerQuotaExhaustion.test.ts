import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { DeepSeekAdapter } from "./deepseek.js";
import { serializeFallbackError } from "./imageFallback.js";
import { OpenAITextAdapter } from "./openai.js";
import {
  isProviderQuotaExhaustedError,
  isRecoverableNetworkError,
  isSpeechProviderFallbackError,
  isTextPrimaryRetryError,
  isTextProviderFallbackError,
  ProviderHttpError,
  withRecoverableNetworkRetry
} from "./retry.js";
import { withTextAttemptBudget } from "./textAttemptBudget.js";
import { FallbackTextModelAdapter, TextGenerationFallbackError, type TextFallbackEvent } from "./textFallback.js";
import { reportTextProviderRequest } from "./textProviderRequest.js";
import type { GenerateTextOptions, TextModelAdapter, TextResult } from "./types.js";

/**
 * The 2026-10-16 outage, end to end: the OpenAI account ran out of credits and
 * every gpt-6-luna call answered this 429. The fallback writer never ran,
 * because the 429 read as a waitable per-minute limit: the pair withheld the
 * hop for the network retry around it, and that retry asked luna again, three
 * times, before the call failed.
 */
const OPENAI_CREDITS_EXHAUSTED = {
  error: {
    type: "insufficient_quota",
    code: "credit_balance_exhausted",
    message: "You have no credits remaining. Add credits to your account to continue using the API.",
    param: null
  }
};

/** A transport that answers every request with one status and body, and counts them. */
function answering(status: number, body: unknown) {
  const requests: string[] = [];
  const fetch = async (url: string | URL | Request) => {
    requests.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-request-id": "req_quota" }
    });
  };
  return { fetch, requests };
}

/** The real adapter over the real SDK, so the SDK builds the error the worker sees. */
function lunaOver(transport: ReturnType<typeof answering>): OpenAITextAdapter {
  const adapter = new OpenAITextAdapter({ apiKey: "test-key", model: "gpt-6-luna" });
  (adapter as unknown as { client: OpenAI }).client = new OpenAI({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: transport.fetch as never
  });
  return adapter;
}

function deepSeekOver(transport: ReturnType<typeof answering>): DeepSeekAdapter {
  const adapter = new DeepSeekAdapter({ apiKey: "test-key", model: "deepseek-v4-pro" });
  (adapter as unknown as { client: OpenAI }).client = new OpenAI({
    apiKey: "test-key",
    baseURL: "https://api.deepseek.com",
    maxRetries: 0,
    fetch: transport.fetch as never
  });
  return adapter;
}

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
    async *streamText(options) {
      yield (await answer(options)).text;
    },
    generateWithTools: async (options) => ({ ...(await answer(options)), toolCalls: [] })
  };
}

/**
 * What `LoggingTextModelAdapter.runFallbackCall` and `createLiveGenerationTextModel`
 * build around one call: the production fallback policy, the call's attempt
 * budget, and three network passes that stop when the budget is spent. The
 * pauses are zero so the test does not sit out a real backoff.
 */
async function workerCall(primary: TextModelAdapter, observed: Pick<GenerateTextOptions, "onOutputTextChunk"> = {}) {
  const fallbackCalls: string[] = [];
  const events: TextFallbackEvent[] = [];
  const pair = new FallbackTextModelAdapter({
    primary: { selection: { provider: "openai", model: "gpt-6-luna" }, adapter: primary },
    fallback: { selection: { provider: "deepseek", model: "deepseek-v4-pro" }, adapter: answeringFallback(fallbackCalls) },
    shouldFallback: isTextProviderFallbackError,
    primaryRetryDelayMs: () => 0,
    onEvent: (event) => {
      events.push(event);
    }
  });
  const options: GenerateTextOptions = withTextAttemptBudget({ ...observed, messages: [{ role: "user", content: "Write chapter 3." }] });
  const outcome = await withRecoverableNetworkRetry(() => pair.generateText(options), {
    attempts: 3,
    delayMs: 0,
    shouldRetry: (error) => options.textAttemptBudget!.used < options.textAttemptBudget!.limit && isRecoverableNetworkError(error)
  }).then(
    (result) => ({ result }),
    (error: unknown) => ({ error })
  );
  return { outcome, fallbackCalls, events, budget: options.textAttemptBudget! };
}

describe("an OpenAI account out of credits", () => {
  it.each([
    ["a plain request", {}],
    ["a streamed request", { onOutputTextChunk: () => undefined }]
  ] as const)("hops to the fallback writer after one primary request (%s)", async (_label, observed) => {
    const openai = answering(429, OPENAI_CREDITS_EXHAUSTED);

    const call = await workerCall(lunaOver(openai), observed);

    // Before the fix: three luna requests, no fallback request, and the 429 thrown.
    expect(openai.requests).toHaveLength(1);
    expect(call.fallbackCalls).toEqual(["deepseek-v4-pro"]);
    expect(call.outcome).toEqual({ result: expect.objectContaining({ provider: "deepseek", model: "deepseek-v4-pro" }) });
    expect(call.events.map((event) => event.event)).toEqual(["fallback.start", "fallback.success"]);
    expect(call.budget.used).toBe(2);
  });
});

describe("a DeepSeek account out of balance", () => {
  it("is refused at once, never retried on the same provider", async () => {
    // DeepSeek's own answer to an empty balance (api-docs.deepseek.com, error codes).
    const deepseek = answering(402, { error: { message: "Insufficient Balance", type: "unknown_error", param: null, code: "invalid_request_error" } });
    const adapter = deepSeekOver(deepseek);
    const options = withTextAttemptBudget({ messages: [{ role: "user" as const, content: "Write." }] });

    const error = await withRecoverableNetworkRetry(() => adapter.generateText(options), { attempts: 3, delayMs: 0 }).then(
      () => undefined,
      (caught: unknown) => caught
    );

    expect(error).toMatchObject({ status: 402 });
    expect(deepseek.requests).toHaveLength(1);
    expect(isTextProviderFallbackError(error)).toBe(true);
  });
});

/** How `@google/genai` raises a non-2xx answer: the status as a field, the body as the message. */
function geminiApiError(body: unknown) {
  return Object.assign(new Error(JSON.stringify(body)), { name: "ApiError", status: 429 });
}

describe("isProviderQuotaExhaustedError", () => {
  const exhausted: Array<[string, unknown]> = [
    [
      "OpenAI's 2026-10-16 answer as the SDK raised it",
      Object.assign(new Error("429 You have no credits remaining. Add credits to your account to continue using the API."), {
        status: 429,
        code: "credit_balance_exhausted",
        type: "insufficient_quota",
        error: OPENAI_CREDITS_EXHAUSTED.error
      })
    ],
    [
      "OpenAI's older insufficient_quota sentence, with a retry-after header beside it",
      new ProviderHttpError("429 You exceeded your current quota, please check your plan and billing details.", {
        status: 429,
        retryAfterMs: 1_000,
        code: "insufficient_quota",
        type: "insufficient_quota"
      })
    ],
    [
      "OpenAI's sentence with its code lost, and no wait named",
      new ProviderHttpError(
        "429 You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
        { status: 429 }
      )
    ],
    ["OpenAI's inactive billing", new ProviderHttpError("429 Your account is not active, please check your billing details on our website.", { status: 429, code: "billing_not_active" })],
    [
      "Gemini's depleted prepaid credit (2026-09-02)",
      geminiApiError({
        error: {
          code: 429,
          message: "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.",
          status: "RESOURCE_EXHAUSTED"
        }
      })
    ],
    ["DeepSeek's 402", Object.assign(new Error("402 Insufficient Balance"), { status: 402 })],
    ["DeepInfra's 402", Object.assign(new Error("402 status code (no body)"), { status: 402 })],
    [
      "OpenRouter's 402 for a balance that cannot cover the request",
      Object.assign(new Error("402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 1200."), { status: 402 })
    ],
    [
      "DashScope's arrearage",
      new ProviderHttpError("Alibaba Qwen API request failed (400): Access denied, please make sure your account is in good standing.", { status: 400 })
    ]
  ];

  it.each(exhausted)("reads %s as an empty account: no retry anywhere, a hop at once", (_label, error) => {
    expect(isProviderQuotaExhaustedError(error)).toBe(true);
    expect(isRecoverableNetworkError(error)).toBe(false);
    expect(isTextPrimaryRetryError(error)).toBe(false);
    expect(isTextProviderFallbackError(error)).toBe(true);
    expect(isSpeechProviderFallbackError(error)).toBe(true);
    // The fallback event and the cost row carry a serialized copy.
    expect(isProviderQuotaExhaustedError(serializeFallbackError(error))).toBe(true);
  });

  const waitable: Array<[string, unknown]> = [
    [
      "OpenAI's TPM window",
      new ProviderHttpError("Rate limit reached for gpt-6-luna on tokens per min (TPM). Please try again in 845ms.", {
        status: 429,
        retryAfterMs: 845,
        code: "rate_limit_exceeded",
        type: "tokens"
      })
    ],
    [
      "Gemini's per-minute quota, which opens with OpenAI's sentence",
      geminiApiError({
        error: {
          code: 429,
          message:
            "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count, limit: 1000000, model: gemini-2.5-flash\nPlease retry in 27.5s.",
          status: "RESOURCE_EXHAUSTED",
          details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "27s" }]
        }
      })
    ],
    ["a 429 that names no reason", new ProviderHttpError("quota", { status: 429 })]
  ];

  it.each(waitable)("leaves %s to the primary's cooldown", (_label, error) => {
    expect(isProviderQuotaExhaustedError(error)).toBe(false);
    expect(isRecoverableNetworkError(error)).toBe(true);
    expect(isTextProviderFallbackError(error)).toBe(false);
  });

  it("does not read a story about money as an empty account", () => {
    // An output error can quote the model; with no refusal status, a sentence is only prose.
    const quoted = new Error('Model returned invalid JSON near "the bank refused: insufficient funds, payment required"');
    expect(isProviderQuotaExhaustedError(quoted)).toBe(false);
    expect(isTextProviderFallbackError(quoted)).toBe(false);
  });

  it("judges a two-provider failure attempt by attempt", () => {
    const quota = serializeFallbackError(new ProviderHttpError("429 You have no credits remaining.", { status: 429 }));
    const pair = (fallbackError: Record<string, unknown>) =>
      new TextGenerationFallbackError({
        operation: "generateText",
        primary: { provider: "openai", model: "gpt-6-luna", error: quota },
        fallback: { provider: "deepseek", model: "deepseek-v4-pro", error: fallbackError }
      });

    // The next pass hops at once, so the fallback's 503 is still worth it.
    const unavailable = pair(serializeFallbackError(new ProviderHttpError("unavailable", { status: 503 })));
    expect(isRecoverableNetworkError(unavailable)).toBe(true);
    expect(isProviderQuotaExhaustedError(unavailable)).toBe(false);

    // Both accounts empty: nothing will answer, so nothing retries it.
    const bothEmpty = pair(serializeFallbackError(Object.assign(new Error("402 Insufficient Balance"), { status: 402 })));
    expect(isRecoverableNetworkError(bothEmpty)).toBe(false);
    expect(isProviderQuotaExhaustedError(bothEmpty)).toBe(true);

    // A refused request beside an empty account is not worth another pass either.
    const refused = pair(serializeFallbackError(new ProviderHttpError("bad request", { status: 400 })));
    expect(isRecoverableNetworkError(refused)).toBe(false);
  });

  it("waits on the attempt it retries, never on the other attempt's daily cap", async () => {
    const pair = new TextGenerationFallbackError({
      operation: "generateText",
      primary: {
        provider: "gemini",
        model: "gemini-2.5-flash",
        error: serializeFallbackError(new ProviderHttpError("quota", { status: 429, retryAfterMs: 20_698_000 }))
      },
      fallback: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        error: serializeFallbackError(new ProviderHttpError("unavailable", { status: 503 }))
      }
    });
    const delays: number[] = [];
    let calls = 0;

    const result = await withRecoverableNetworkRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw pair;
        return "written";
      },
      { attempts: 2, delayMs: 5, onRetry: ({ delayMs }) => void delays.push(delayMs) }
    );

    expect(result).toBe("written");
    expect(delays).toEqual([5]);
  });

  it("is never a stop", () => {
    const stop = Object.assign(new Error("Stopped by user: insufficient_quota"), { name: "StopRequestedError", status: 402 });
    expect(isProviderQuotaExhaustedError(stop)).toBe(false);
    expect(isTextProviderFallbackError(stop)).toBe(false);
  });
});

describe("OpenAITextAdapter on an empty account", () => {
  it("keeps OpenAI's own code and type on the error it raises", async () => {
    const openai = answering(429, OPENAI_CREDITS_EXHAUSTED);
    const error = await lunaOver(openai).generateText({ messages: [] }).then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 429, code: "credit_balance_exhausted", type: "insufficient_quota" });
  });
});
