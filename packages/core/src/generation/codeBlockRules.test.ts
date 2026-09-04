import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { bookMentionsCode, codeBlockRules } from "./codeBlockRules.js";

const input = (prompt: string): CreateProjectInput => ({
  prompt,
  category: "EDUCATION",
  targetPages: 24,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
});

describe("codeBlockRules", () => {
  it("speaks only to a book about code, and then about the fence's language tag", () => {
    const history = input("A global history of aggression and its causes.");
    expect(bookMentionsCode(history, makeFallbackPlan(history))).toBe(false);
    expect(codeBlockRules(history, makeFallbackPlan(history))).toEqual([]);
    const algorithms = input("A practical guide to sorting algorithms in Python for working programmers.");
    expect(bookMentionsCode(algorithms, makeFallbackPlan(algorithms))).toBe(true);
    const [rule] = codeBlockRules(algorithms, makeFallbackPlan(algorithms));
    expect(rule).toContain("never tag a code block text");
    expect(rule).toContain("never indented with spaces");
  });
});
