import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { CONTINUITY_NOTE_PROMPT_LIMITS } from "../context/contextPack.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { reviewPageDraft } from "./pagesReview.js";

const input: CreateProjectInput = {
  prompt: "Jack The Martyr, a character-led story about sacrifice and consequence.",
  category: "STORY",
  targetPages: 10,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral" as const
  }
};

const plan = makeFallbackPlan(input);

function goodMarkdown(): string {
  return [
    "The chapel door had been painted black so many times that the grain underneath looked bruised. Jack pressed two fingers to the iron latch and felt it tremble before anyone touched it from the other side.",
    "",
    '"You promised you would wait," Mara said from the stairwell.',
    "",
    "Jack did not turn. The folded warrant in his coat had already warmed against his ribs, and the red wax seal had cracked where his thumb kept worrying it. Inside the chapel, someone dragged a chair across stone. That small sound decided him. He lifted the latch, stepped through, and let Mara see the scar over his left eyebrow catch the candlelight."
  ].join("\n");
}

function capturingReviewModel(rawData: unknown): {
  model: TextModelAdapter;
  payload?: Record<string, unknown>;
} {
  const capture: { model: TextModelAdapter; payload?: Record<string, unknown> } = {
    model: {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, unknown>;
        return {
          data: options.schema.parse(rawData),
          text: JSON.stringify(rawData),
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools
    }
  };
  return capture;
}

describe("reviewPageDraft recency window", () => {
  it("keeps a 5-page recency window of 800-character excerpts", async () => {
    const capture = capturingReviewModel({
      approved: true,
      score: 92,
      issues: [],
      requiredRevisions: [],
      notes: "Approved.",
      checks: {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: true
      }
    });
    const previousPages = Array.from({ length: 6 }, (_, index) => ({
      index: index + 1,
      title: `Prior ${index + 1}`,
      markdown: `page-${index + 1} ${"x".repeat(1200)}`,
      summary: `Summary ${index + 1}`
    }));

    await reviewPageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 7,
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack crosses the threshold and commits to a dangerous choice.",
        continuityNotes: []
      },
      previousPages,
      continuityNotes: [],
      textModel: capture.model
    });

    const compacted = capture.payload?.previousPages as Array<{ index: number; excerpt: string }>;
    expect(compacted.map((page) => page.index)).toEqual([2, 3, 4, 5, 6]);
    expect(compacted.every((page) => page.excerpt.length === 800)).toBe(true);
  });
});

describe("reviewPageDraft continuity notes", () => {
  it("keeps the end of the producer's ranking when the full budget overflows the prompt", async () => {
    const capture = capturingReviewModel({
      approved: true,
      score: 92,
      issues: [],
      requiredRevisions: [],
      notes: "Approved.",
      checks: {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: true
      }
    });
    // `loadContinuityNotes` hands over its whole budget ranked ascending, so
    // the last entry is the best-scoring trigram hit about this page's own
    // cast. This prompt keeps fewer than that budget, and it used to keep the
    // wrong end: `slice(-20)` of a descending ranking dropped exactly the
    // eight hits the relevance arm exists to surface.
    const topHit = "Tomas still guards the vault, and the brass key opens it.";
    const continuityNotes = [
      ...Array.from({ length: CONTINUITY_NOTE_PROMPT_LIMITS.draft - 1 }, (_, index) => `Recency note ${index}.`),
      topHit
    ];

    await reviewPageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 7,
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack crosses the threshold and commits to a dangerous choice.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes,
      textModel: capture.model
    });

    const sent = capture.payload?.continuityNotes as string[];
    expect(sent).toHaveLength(CONTINUITY_NOTE_PROMPT_LIMITS.review);
    expect(sent.at(-1)).toBe(topHit);
    expect(sent[0]).toBe(`Recency note ${CONTINUITY_NOTE_PROMPT_LIMITS.draft - CONTINUITY_NOTE_PROMPT_LIMITS.review}.`);
  });
});
