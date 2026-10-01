import { describe, expect, it } from "vitest";
import { chapterOutputBudget } from "./chapterOutputBudget.js";

describe("chapterOutputBudget", () => {
  // Quick Draft, 2026-09-30: gpt-6-luna at medium planned an 8-chapter book's
  // forms in 8,571 tokens (4,171 reasoning) after the 7,100 request truncated,
  // and a 7-chapter book truncated at 6,400 and again at the widened 9,600
  // (5,632 reasoning), so the book was drafted from the rotated fallback forms.
  it("leaves the forms planner room for medium-effort reasoning beside its JSON", () => {
    expect(chapterOutputBudget({ purpose: "plan-chapter-forms", messages: [], maxTokens: 7_100 }, "medium")).toBeGreaterThanOrEqual(12_000);
    expect(chapterOutputBudget({ purpose: "plan-chapter-forms", messages: [], maxTokens: 6_400 }, "low")).toBeGreaterThanOrEqual(8_000);
  });

  it("leaves the excerpt extractor room for its reasoning", () => {
    // Same runs: extract-excerpts asked for 4,000 and spent up to 5,371 reasoning
    // tokens, truncating in four calls across three of six books.
    expect(chapterOutputBudget({ purpose: "extract-excerpts", messages: [], maxTokens: 4_000 }, "medium")).toBeGreaterThanOrEqual(8_000);
  });

  it("keeps the voice calls' fuse at effort none and lifts it for reasoning", () => {
    // 2026-09-30: an unfused extraction at effort none ran to 128,000 tokens.
    expect(chapterOutputBudget({ purpose: "extract-voice-character-candidates", messages: [], maxTokens: 4_000 }, "none")).toBe(4_000);
    expect(chapterOutputBudget({ purpose: "extract-voice-character-candidates", messages: [], maxTokens: 4_000 }, "medium")).toBe(8_000);
    expect(chapterOutputBudget({ purpose: "build-voice-character-persona", messages: [], maxTokens: 8_000 }, "high")).toBe(16_000);
  });

  it("never lowers an explicit budget and leaves effortless calls on their own fuse", () => {
    expect(chapterOutputBudget({ purpose: "read-manuscript", messages: [], maxTokens: 20_000 }, "medium")).toBe(20_000);
    expect(chapterOutputBudget({ purpose: "compose-chapter", messages: [], maxTokens: 9_000 }, "none")).toBe(9_000);
    expect(chapterOutputBudget({ purpose: "compose-chapter", messages: [], maxTokens: 9_000 }, undefined)).toBe(9_000);
    expect(chapterOutputBudget({ purpose: "plan-book", messages: [] }, "medium")).toBeUndefined();
  });
});
