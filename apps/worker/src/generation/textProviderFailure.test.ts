import { expect, it } from "vitest";
import { ProviderHttpError, ProviderStreamInterruptedError, TextAttemptBudgetExhaustedError, TextGenerationFallbackError } from "@book-maker/core";
import { isBoundedTextProviderFailure, isTextProviderFailure } from "./textProviderFailure.js";

it.each([
  new TextAttemptBudgetExhaustedError(5),
  new ProviderStreamInterruptedError("stream ended"),
  new ProviderHttpError("gateway unavailable", { status: 503 }),
  Object.assign(new Error("OpenAI response was incomplete: max_output_tokens."), { name: "OpenAIResponseError" }),
  Object.assign(new Error("invalid model JSON"), { name: "OpenAIJsonValidationError" })
])("allows saved-prose fallback for a bounded model failure: %s", (error) => {
  expect(isBoundedTextProviderFailure(error)).toBe(true);
});

it.each([
  new Error("database connection closed"),
  Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
  Object.assign(new Error("storage unavailable"), { name: "PrismaClientKnownRequestError", code: "P2024" }),
  new ProviderHttpError("invalid credentials", { status: 401 }),
  new ProviderHttpError("invalid request", { status: 400 }),
  Object.assign(new Error("stopped"), { name: "StopRequestedError" }),
  Object.assign(new Error("aborted"), { name: "AbortError" })
])("preserves permanent, cancellation and infrastructure failures: %s", (error) => {
  expect(isBoundedTextProviderFailure(error)).toBe(false);
});

it("keeps saved prose when a provider's account is empty, on either attempt of a pair", () => {
  const empty = new ProviderHttpError("429 You have no credits remaining.", { status: 429, code: "credit_balance_exhausted" });
  const deepSeekBalance = Object.assign(new Error("402 Insufficient Balance"), { name: "Error", status: 402 });
  expect(isBoundedTextProviderFailure(empty)).toBe(true);
  expect(isBoundedTextProviderFailure(deepSeekBalance)).toBe(true);
  expect(isTextProviderFailure(deepSeekBalance)).toBe(true);
  // The pair's error as the fallback adapter builds it, each attempt serialized: an empty
  // primary beside a fallback that refused the request outright.
  const pair = new TextGenerationFallbackError({
    operation: "generateText",
    primary: { provider: "openai", model: "gpt-6-luna", error: { name: "ProviderHttpError", message: empty.message, status: 429 } },
    fallback: { provider: "deepseek", model: "deepseek-v4-pro", error: { name: "ProviderHttpError", message: "bad request", status: 400 } }
  });
  expect(isBoundedTextProviderFailure(pair)).toBe(true);
});
