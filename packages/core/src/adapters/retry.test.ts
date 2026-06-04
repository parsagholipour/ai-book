import { describe, expect, it } from "vitest";
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

  it("does not mistake JSON syntax errors for network failures", () => {
    expect(isRecoverableNetworkError(new Error("Model returned invalid JSON. Unterminated string"))).toBe(false);
  });
});
