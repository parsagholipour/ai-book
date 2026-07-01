import { describe, expect, it } from "vitest";
import { buildContextPack } from "./contextPack.js";
import { makeFallbackPlan } from "../prompting/templates.js";

describe("buildContextPack", () => {
  it("keeps memory inside the approximate token budget", () => {
    const plan = makeFallbackPlan({
      prompt: "A science book about volcanoes.",
      category: "SCIENCE",
      targetPages: 320,
      complexity: 6,
      temperature: 0.4,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    });

    const pack = buildContextPack({
      plan,
      chapter: plan.chapters[0],
      pageIndex: 200,
      targetPages: 320,
      previousSummaries: Array.from({ length: 320 }, (_, index) => `Summary ${index}: ${"detail ".repeat(80)}`),
      continuityNotes: Array.from({ length: 200 }, (_, index) => `Note ${index}: ${"rule ".repeat(60)}`),
      researchNotes: Array.from({ length: 50 }, (_, index) => `Research ${index}: ${"source ".repeat(100)}`),
      tokenBudget: 6000
    });

    expect(pack.budget.approximateTokens).toBeLessThan(6200);
    expect(pack.memory).toContain("Continuity notes:");
  });

  it("drops prompt-like research notes before building writer context", () => {
    const plan = makeFallbackPlan({
      prompt: "A science book about volcanoes.",
      category: "SCIENCE",
      targetPages: 12,
      complexity: 6,
      temperature: 0.4,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    });

    const pack = buildContextPack({
      plan,
      chapter: plan.chapters[0],
      pageIndex: 1,
      targetPages: 12,
      previousSummaries: [],
      continuityNotes: [],
      researchNotes: [
        "meetnewbooks.com: For an AI book outline exploring this topic, consider these works.",
        "USGS: Volcanoes form where magma reaches the surface."
      ],
      tokenBudget: 2000
    });

    expect(pack.research).toContain("USGS");
    expect(pack.research).not.toContain("For an AI book");
    expect(pack.research).not.toContain("meetnewbooks.com");
  });
});
