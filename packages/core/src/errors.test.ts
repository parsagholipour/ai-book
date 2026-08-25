import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors.js";

describe("errorMessage", () => {
  it("returns an Error's message, including an empty message", () => {
    expect(errorMessage(new Error("Provider unavailable"))).toBe("Provider unavailable");
    expect(errorMessage(new Error(""))).toBe("");
  });

  it("falls back for non-Error thrown values", () => {
    expect(errorMessage("Provider unavailable")).toBe("Unknown error");
    expect(errorMessage({ message: "Provider unavailable" })).toBe("Unknown error");
    expect(errorMessage(null)).toBe("Unknown error");
  });
});
