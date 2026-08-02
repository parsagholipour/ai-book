import { describe, expect, it, vi } from "vitest";
import { TextGenerationFallbackError } from "./textFallback.js";
import { ProviderHttpError, isRecoverableNetworkError, withRecoverableNetworkRetry } from "./retry.js";

describe("isRecoverableNetworkError", () => {
  it("recognizes terminated transport failures", () => {
    expect(isRecoverableNetworkError(new TypeError("terminated"))).toBe(true);
  });

  it("recognizes nested undici socket failures", () => {
    expect(
      isRecoverableNetworkError({
        message: "fetch failed",
        cause: {
          name: "SocketError",
          code: "UND_ERR_SOCKET",
          message: "other side closed"
        }
      })
    ).toBe(true);
  });

  it("recognizes network failures nested in text fallback errors", () => {
    const error = new TextGenerationFallbackError({
      operation: "generateJson",
      primary: {
        provider: "primary",
        model: "primary-model",
        error: { name: "TypeError", message: "fetch failed", code: "ECONNRESET" }
      },
      fallback: {
        provider: "fallback",
        model: "fallback-model",
        error: { name: "SocketError", message: "other side closed", code: "UND_ERR_SOCKET" }
      }
    });

    expect(isRecoverableNetworkError(error)).toBe(true);
  });

  it("does not classify deterministic nested fallback failures as network errors", () => {
    const error = new TextGenerationFallbackError({
      operation: "generateJson",
      primary: {
        provider: "primary",
        model: "primary-model",
        error: { name: "Error", message: "invalid JSON" }
      },
      fallback: {
        provider: "fallback",
        model: "fallback-model",
        error: { name: "Error", message: "schema validation failed" }
      }
    });

    expect(isRecoverableNetworkError(error)).toBe(false);
  });

  it("does not mistake JSON syntax errors for network failures", () => {
    expect(isRecoverableNetworkError(new Error("Model returned invalid JSON. Unterminated string"))).toBe(false);
  });

  it("treats a throttled provider as recoverable", () => {
    expect(isRecoverableNetworkError(new ProviderHttpError("quota", { status: 429 }))).toBe(true);
  });

  it("still refuses a request the provider rejected outright", () => {
    expect(isRecoverableNetworkError(new ProviderHttpError("bad argument", { status: 400 }))).toBe(false);
  });

  it("refuses a cooldown measured in hours, which is a spent daily quota", () => {
    // Retrying inside it fails identically; the budget is better spent failing
    // fast so the charge is refunded and the reader is told the truth.
    expect(
      isRecoverableNetworkError(new ProviderHttpError("quota", { status: 429, retryAfterMs: 20_698_000 }))
    ).toBe(false);
  });

  it("sees a status carried as a field, not only in the message", () => {
    // The whole point of ProviderHttpError: `new Error("failed (503): ...")`
    // matches none of the message patterns and would never be retried.
    expect(isRecoverableNetworkError(new Error("Gemini TTS request failed (503): unavailable"))).toBe(false);
    expect(isRecoverableNetworkError(new ProviderHttpError("failed (503)", { status: 503 }))).toBe(true);
  });
});

describe("withRecoverableNetworkRetry", () => {
  it("waits at least as long as the provider asked, not the backoff curve", async () => {
    vi.useFakeTimers();
    try {
      const delays: number[] = [];
      let calls = 0;
      const promise = withRecoverableNetworkRetry(
        async () => {
          calls += 1;
          if (calls === 1) {
            throw new ProviderHttpError("quota", { status: 429, retryAfterMs: 38_000 });
          }
          return "done";
        },
        { delayMs: 2_000, onRetry: ({ delayMs }) => void delays.push(delayMs) }
      );

      await vi.advanceTimersByTimeAsync(60_000);
      await expect(promise).resolves.toBe("done");
      // Jitter is added on top, so this is a floor rather than an equality.
      expect(delays[0]).toBeGreaterThanOrEqual(38_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps plain exponential backoff when no cooldown was named", async () => {
    vi.useFakeTimers();
    try {
      const delays: number[] = [];
      const promise = withRecoverableNetworkRetry(
        async () => {
          throw new TypeError("terminated");
        },
        { attempts: 3, delayMs: 2_000, onRetry: ({ delayMs }) => void delays.push(delayMs) }
      );
      const settled = promise.catch(() => "failed");

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(settled).resolves.toBe("failed");
      expect(delays).toEqual([2_000, 4_000]);
    } finally {
      vi.useRealTimers();
    }
  });
});
