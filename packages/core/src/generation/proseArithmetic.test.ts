import { describe, expect, it } from "vitest";
import { evaluateExpression, verifiedFinding } from "./proseArithmetic.js";

// The three a blind panel caught on 2026-09-30.
const workbook = "Suppose the freelancer starts April with $800. After paying rent of $1,200 and electricity of $110, only $290 remains on April 5, which is why the buffer matters.";
const history = "Loading loose cargo cost $5.86 a ton, compared with 16 cents for a container, a 39-fold saving that ports could not ignore.";

describe("arithmetic in the prose", () => {
  it("evaluates plain arithmetic and nothing else", () => {
    expect(evaluateExpression("800 - 1,200 - 110")).toBe(-510);
    expect(evaluateExpression("(3 + 4) * 2 / 7")).toBe(2);
    expect(evaluateExpression("-5 + 2")).toBe(-3);
    expect(evaluateExpression("12 ÷ 4")).toBe(3);
    expect(evaluateExpression("process.exit()")).toBeUndefined();
    expect(evaluateExpression("2 +")).toBeUndefined();
    expect(evaluateExpression("(2")).toBeUndefined();
  });

  it("keeps a proposed error only when the quote, the stated number and the computation all agree it is one", () => {
    expect(verifiedFinding(workbook, "only $290 remains on April 5", "800 - 1200 - 110", 290)).toEqual({ quote: "only $290 remains on April 5", reason: "800 - 1200 - 110 = -510, not 290." });
    expect(verifiedFinding(history, "a 39-fold saving that ports could not ignore", "5.86 / 0.16", "39")).toMatchObject({ reason: "5.86 / 0.16 = 36.63, not 39." });
    // Right after all: the model's proposal is not the verdict.
    expect(verifiedFinding(history, "a 39-fold saving that ports could not ignore", "5.85 / 0.15", 39)).toBeUndefined();
    // A quote that is not in the chapter, or that does not carry the stated number.
    expect(verifiedFinding(workbook, "only $300 remains on April 5", "800 - 1200 - 110", 300)).toBeUndefined();
    expect(verifiedFinding(workbook, "which is why the buffer matters", "800 - 1200 - 110", 290)).toBeUndefined();
    // An unreadable computation, and a figure given as approximate within its rounding.
    expect(verifiedFinding(workbook, "only $290 remains on April 5", "rent minus bills", 290)).toBeUndefined();
    // A result spelled in words is no number: it used to read as 0 and always be "wrong".
    expect(verifiedFinding("A height of 2,100 millimetres, or six feet ten and a half inches.", "or six feet ten and a half inches", "(6*12+10.5)*25.4", "six feet ten and a half inches")).toBeUndefined();
    expect(verifiedFinding("A rate of about $43.75 per hour is the result.", "A rate of about $43.75 per hour", "50400 / 1152", 43.75)).toBeUndefined();
  });
});
