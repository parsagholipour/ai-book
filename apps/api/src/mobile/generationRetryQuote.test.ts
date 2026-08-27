import { describe, expect, it } from "vitest";
import { generationRecoveryQuote } from "./generationRetryQuote.js";

const attempt = {
  id: "attempt-refunded",
  commandKey: "mobile:creation-build:draft-1:build-1",
  quotedCredits: 80
};

describe("mobile generation recovery quotes", () => {
  it("lets an initial-plan retry immediately reuse its refunded exact quote", () => {
    expect(generationRecoveryQuote({ ...attempt, operation: "PLAN_GENERATION" })).toEqual({
      credits: 80,
      retryToken: expect.any(String),
      requiresConfirmation: false
    });
  });

  it.each(["FULL_BOOK_GENERATION", "PLAN_REVISION"])(
    "keeps confirmation for %s retries",
    (operation) => {
      expect(generationRecoveryQuote({ ...attempt, operation }).requiresConfirmation).toBe(true);
    }
  );

  it("defaults legacy attempts with no operation to confirmation", () => {
    expect(generationRecoveryQuote(attempt).requiresConfirmation).toBe(true);
  });
});
