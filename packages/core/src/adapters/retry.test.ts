import { describe, expect, it } from "vitest";
import { TextGenerationFallbackError } from "./textFallback.js";
import { isRecoverableNetworkError } from "./retry.js";

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
});
