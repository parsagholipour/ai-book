import { describe, expect, it, vi } from "vitest";
import { InvalidDecisionError, type DecisionRequest } from "./decisions.js";
import { JevDecisionAdapter } from "./jevDecision.js";
import { isRecoverableNetworkError, ProviderHttpError } from "./retry.js";

const request: DecisionRequest = {
  purpose: "test-choice",
  context: "Full source and candidate context",
  instructions: "Choose the stronger option",
  options: [{ id: "a", description: "A" }, { id: "b", description: "B" }]
};

describe("JevDecisionAdapter HTTP errors", () => {
  it("wraps a Gateway 503 as ProviderHttpError so retries see the status field", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: "Service unavailable" }, { status: 503, headers: { "Retry-After": "12.5" } })
    );
    const error = await new JevDecisionAdapter("key", fetch).choose(request).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 503, retryAfterMs: 12_500 });
    expect(isRecoverableNetworkError(error)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("parses an HTTP-date Retry-After header", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        new Response("unavailable", { status: 503, headers: { "Retry-After": "Mon, 03 Aug 2026 00:00:30 GMT" } })
      );
      const error = await new JevDecisionAdapter("key", fetch).choose(request).catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({ status: 503, retryAfterMs: 30_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat a 400 as recoverable", async () => {
    const error = await new JevDecisionAdapter("key", async () =>
      Response.json({ error: "bad request" }, { status: 400 })
    ).choose(request).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 400 });
    expect(isRecoverableNetworkError(error)).toBe(false);
  });

  it("keeps cancellation identity even when the Gateway answers 503", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      controller.abort();
      return Response.json({ error: "Service unavailable" }, { status: 503 });
    });
    await expect(new JevDecisionAdapter("key", fetch).choose({ ...request, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not wrap an invalid evaluation as ProviderHttpError", async () => {
    const body = { answers: { choice: { type: "choice", choice: "unknown", probabilities: { a: 0.8, b: 0.2 } } }, usage: { inputTokens: 1000, outputTokens: 0 } };
    const error = await new JevDecisionAdapter("key", async () => Response.json(body)).choose(request).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(InvalidDecisionError);
    expect(error).toMatchObject({ result: { usage: { promptTokens: 1000, outputTokens: 0 } } });
  });

  it("omits salvaged promptTokens when a 200 body has answers but no inputTokens", async () => {
    const body = { answers: { choice: { type: "choice", choice: "unknown", probabilities: { a: 0.8, b: 0.2 } } } };
    const error = await new JevDecisionAdapter("key", async () => Response.json(body)).choose(request).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(InvalidDecisionError);
    expect(error).toMatchObject({ result: { usage: { outputTokens: 0 } } });
    expect((error as InvalidDecisionError).result.usage).not.toHaveProperty("promptTokens");
  });
});
