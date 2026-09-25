import { expect, it } from "vitest";
import { ProviderHttpError, ProviderStreamInterruptedError, TextAttemptBudgetExhaustedError } from "@book-maker/core";
import { isBoundedTextProviderFailure } from "./textProviderFailure.js";

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
