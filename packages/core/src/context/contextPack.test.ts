import { describe, expect, it } from "vitest";
import { CONTINUITY_NOTE_PROMPT_LIMITS, buildContextPack, continuityNotesForPrompt } from "./contextPack.js";
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
    // Both cuts on the way in — the window and then `trimToBudget` — keep the
    // tail, because `loadContinuityNotes` ranks ascending and the tail is also
    // the end nearest the model's attention. Note 199 is the one the page most
    // needs; note 171 is the first one outside the window.
    expect(pack.memory).toContain("Note 199:");
    expect(pack.memory).not.toContain("Note 171:");
  });

  it("keeps the tail of a continuity-note ranking, and nothing at a non-positive limit", () => {
    const notes = ["oldest", "middle", "newest"];
    expect(continuityNotesForPrompt(notes, 2)).toEqual(["middle", "newest"]);
    expect(continuityNotesForPrompt(notes, 9)).toEqual(notes);
    // `slice(-0)` is the whole array, which would quietly send every note.
    expect(continuityNotesForPrompt(notes, 0)).toEqual([]);
  });

  it("leaves the note the page most needs in every prompt's window", () => {
    // A full-size `loadContinuityNotes` result: ascending priority, so the last
    // entry is the best-scoring relevance hit about this page's own cast. Every
    // prompt takes at most this many notes, and each used to hand-roll
    // `slice(-N)` against a ranking that ran the other way, which spent the
    // difference dropping exactly those hits.
    const topHit = "Tomas still guards the vault, and the brass key opens it.";
    const ranked = [
      ...Array.from({ length: CONTINUITY_NOTE_PROMPT_LIMITS.draft - 1 }, (_, index) => `Recency note ${index}.`),
      topHit
    ];

    for (const limit of Object.values(CONTINUITY_NOTE_PROMPT_LIMITS)) {
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(ranked.length);
      const kept = continuityNotesForPrompt(ranked, limit);
      expect(kept).toHaveLength(limit);
      expect(kept.at(-1)).toBe(topHit);
    }
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
