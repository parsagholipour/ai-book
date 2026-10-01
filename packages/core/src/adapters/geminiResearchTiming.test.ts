import { afterEach, expect, it, vi } from "vitest";
import { GeminiResearchAdapter, RESEARCH_REQUEST_TIMEOUT_MS } from "./gemini.js";
import { isRecoverableNetworkError, isStopOrAbortError } from "./retry.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["resolved", "unresolved", "direct"] as const)(
  "separates provider, local processing and redirect time for %s sources",
  async (outcome) => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const fetchMock = vi.fn(async () => {
      now += 300;
      if (outcome === "unresolved") throw new Error("redirect unavailable");
      return new Response(null, { status: 302, headers: { location: "https://example.com/source" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const sourceUrl = outcome === "direct" ? "https://example.com/source"
      : "https://vertexaisearch.cloud.google.com/grounding-api-redirect/timing";
    const adapter = new GeminiResearchAdapter({ apiKey: "fixture", textModel: "gemini-2.5-flash" });
    Object.assign(adapter, { ai: { models: { generateContent: async () => {
      now += 1_200;
      return {
        get text() { now += 25; return "Source-backed notes."; },
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
        candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: "Source", uri: sourceUrl } }] } }]
      };
    } } } });

    const result = await adapter.search({ query: "research timing" });

    expect(result).toMatchObject({
      timings: {
        providerRequestMs: 1_200,
        groundingRedirectsMs: outcome === "direct" ? 0 : 300,
        totalMs: outcome === "direct" ? 1_225 : 1_525
      },
      usage: { promptTokens: 100, outputTokens: 50, reasoningTokens: 30 }
    });
    expect(result.sources[0]?.url).toBe(outcome === "unresolved" ? sourceUrl : "https://example.com/source");
    expect(fetchMock).toHaveBeenCalledTimes(outcome === "direct" ? 0 : 1);
  }
);

it("gives up on a stalled grounded search as a retryable timeout, never as a stop", async () => {
  // Quick Draft, 2026-09-30: three of 124 searches took 243–250 s against a
  // median of 10.5 s, each holding a chapter's evidence loop the whole time.
  vi.useFakeTimers();
  try {
    const adapter = new GeminiResearchAdapter({ apiKey: "fixture", textModel: "gemini-2.5-flash" });
    let signal: AbortSignal | undefined;
    Object.assign(adapter, { ai: { models: { generateContent: (request: { config: { abortSignal?: AbortSignal } }) => {
      signal = request.config.abortSignal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))));
    } } } });
    const pending = adapter.search({ query: "stalled search" });
    const settled = pending.then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(RESEARCH_REQUEST_TIMEOUT_MS);
    const error = await settled;
    expect(signal?.aborted).toBe(true);
    expect(isStopOrAbortError(error)).toBe(false);
    expect(isRecoverableNetworkError(error)).toBe(true);
    expect(error).toMatchObject({ status: 504 });
  } finally {
    vi.useRealTimers();
  }
});
