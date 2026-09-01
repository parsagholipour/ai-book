import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { evidenceLedgerFields, evidenceLedgerRules, usesEvidenceLedger } from "./evidenceLedger.js";

function inputFor(category: CreateProjectInput["category"], prompt = "A book."): CreateProjectInput {
  return {
    prompt,
    category,
    targetPages: 8,
    complexity: 5,
    temperature: 0.7,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral"
    }
  };
}

describe("evidence ledger gate", () => {
  it("applies to analytical and instructional books and to nothing narrative", () => {
    expect(usesEvidenceLedger(inputFor("HISTORY"), makeFallbackPlan(inputFor("HISTORY")))).toBe(true);
    expect(usesEvidenceLedger(inputFor("BUSINESS"), makeFallbackPlan(inputFor("BUSINESS")))).toBe(true);
    expect(usesEvidenceLedger(inputFor("STORY"), makeFallbackPlan(inputFor("STORY")))).toBe(false);
    expect(usesEvidenceLedger(inputFor("KIDS"), makeFallbackPlan(inputFor("KIDS")))).toBe(false);
  });

  it("lets a plan's own writing mode override the inference", () => {
    const input = inputFor("STORY");
    expect(usesEvidenceLedger(input, { ...makeFallbackPlan(input), writingMode: "analytical-history" })).toBe(true);
    expect(evidenceLedgerRules(input, makeFallbackPlan(input), "writer")).toEqual([]);
  });

  it("hands each audience its own sentences, none of which trip the prompt sweep's markers", () => {
    const input = inputFor("HISTORY");
    const plan = makeFallbackPlan(input);
    for (const audience of ["producer", "repair", "critic", "writer", "reviewer"] as const) {
      const rules = evidenceLedgerRules(input, plan, audience);
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.join(" ")).not.toMatch(/throat-clearing|openingHook/);
    }
    expect(evidenceLedgerRules(input, plan, "repair").length).toBeGreaterThan(evidenceLedgerRules(input, plan, "producer").length);
  });

  it("carries only a ledger that is actually there, trimmed", () => {
    expect(evidenceLedgerFields({ claim: "  A claim. ", evidenceAnchors: [" one ", "", "two"] })).toEqual({
      claim: "A claim.",
      evidenceAnchors: ["one", "two"]
    });
    expect(evidenceLedgerFields({ claim: "   ", evidenceAnchors: [] })).toEqual({});
    expect(evidenceLedgerFields({})).toEqual({});
  });
});
