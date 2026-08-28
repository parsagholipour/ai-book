import { describe, expect, it } from "vitest";
import {
  EDIT_RUN_FAILED,
  EDIT_START_FAILED,
  EDIT_START_NEEDS_CREDITS,
  ReaderEditFailure,
  classifyEditFailure,
  failedEditOperationData,
  imageLimitReachedMessage
} from "./editFailure.js";

/**
 * The refusals arrive here as whatever `packages/db` threw, and this module may
 * not import that package — so the rungs are keyed on the wire `code` each
 * class declares. The shapes below are those classes as this module can see
 * them; `packages/db/src/generationAttempts.test.ts` is what pins the codes to
 * the real ones.
 */
const quotaRefusal = (limit: unknown) => ({
  name: "GenerationQuotaExceededError",
  code: "IMAGE_LIMIT_REACHED",
  message: "The illustrated-book limit has been reached for this period.",
  claim: { allowed: false, used: 3, limit }
});

describe("classifyEditFailure", () => {
  it("says what to do next for every rung, because the chat may not dead-end", () => {
    const sentences = [
      classifyEditFailure(quotaRefusal(3), "start"),
      classifyEditFailure({ code: "INSUFFICIENT_CREDITS" }, "start"),
      classifyEditFailure(new Error("anything else"), "start"),
      classifyEditFailure(new Error("anything else"), "settlement")
    ];

    for (const { message } of sentences) {
      expect(message).toMatch(/Send it again|Add credits|Upgrade for unlimited/);
    }
  });

  it("gives the spent image slot the count and the way out, not the class's own words", () => {
    expect(classifyEditFailure(quotaRefusal(3), "start")).toEqual({
      message: imageLimitReachedMessage(3),
      internal: false
    });
    expect(imageLimitReachedMessage(3)).toBe(
      "Free plans include 3 illustrated books a month. Upgrade for unlimited, or turn visuals off."
    );
  });

  it("still answers when the claim carries no usable count", () => {
    for (const limit of [undefined, null, "3", Number.NaN]) {
      const { message, internal } = classifyEditFailure(quotaRefusal(limit), "start");

      expect(internal).toBe(false);
      expect(message).toBe(imageLimitReachedMessage(null));
      expect(message).not.toMatch(/\bnull\b|\bundefined\b|NaN/);
    }
  });

  it("keeps a conflict's own sentence, and falls back when it has none", () => {
    expect(classifyEditFailure({ code: "GENERATION_COMMAND_CONFLICT", message: "  " }, "start")).toEqual({
      message: EDIT_START_FAILED,
      internal: false
    });
    expect(
      classifyEditFailure(
        Object.assign(new Error("That command has different settings."), { code: "GENERATION_COMMAND_CONFLICT" }),
        "start"
      )
    ).toEqual({ message: "That command has different settings.", internal: false });
  });

  it("names no number for a credits refusal, because the reply beside it already does", () => {
    const { message, internal } = classifyEditFailure({ code: "INSUFFICIENT_CREDITS" }, "start");

    expect(message).toBe(EDIT_START_NEEDS_CREDITS);
    expect(message).not.toMatch(/\d/);
    expect(internal).toBe(false);
  });

  /**
   * The whole point: `BookEditOperation.error` is copied onto the mobile DTO,
   * so anything this does not recognise becomes the generic sentence and the
   * cause becomes the caller's log line.
   */
  it("never lets an unrecognised cause become reader copy", () => {
    for (const cause of [
      new Error("Generation attempt attempt-2 may not claim generation job job-1 … spent dedupeKey."),
      new TypeError("Cannot read properties of undefined (reading 'index')"),
      { code: "P2024", message: "Timed out fetching a new connection from the connection pool." },
      { code: "P2028", message: "Transaction already closed" },
      "not an Error at all",
      null,
      undefined
    ]) {
      expect(classifyEditFailure(cause, "start")).toEqual({ message: EDIT_START_FAILED, internal: true });
      expect(classifyEditFailure(cause, "settlement")).toEqual({ message: EDIT_RUN_FAILED, internal: true });
    }
  });

  /**
   * A start committed nothing, so its sentence may say so. A settlement's work
   * *was* charged and the card reports the refund on its own, so that sentence
   * makes no claim about money.
   */
  it("keeps the two generic sentences apart on what they can honestly claim", () => {
    expect(EDIT_START_FAILED).toMatch(/nothing was charged/);
    expect(EDIT_RUN_FAILED).not.toMatch(/charge|credit|refund/i);
  });

  it("passes deliberate reader copy through untouched", () => {
    expect(classifyEditFailure(new ReaderEditFailure("Stopped by user"), "settlement")).toEqual({
      message: "Stopped by user",
      internal: false
    });
  });
});

describe("failedEditOperationData", () => {
  it("is the one FAILED verdict every writer of that row shares", () => {
    expect(failedEditOperationData(new Error("model outage"))).toEqual({
      status: "FAILED",
      error: EDIT_RUN_FAILED,
      structuralLeaseToken: null,
      structuralLeaseExpiresAt: null
    });
  });
});
