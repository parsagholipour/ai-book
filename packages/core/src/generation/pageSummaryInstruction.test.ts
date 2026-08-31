import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput, PageDraft } from "../schemas/book.js";
import { generatePageDraft } from "./pages.js";
import { revisePageDraft } from "./pagesReview.js";

const strengthenedSummaryInstruction =
  "The page summary must be one or two compact sentences recording this page's outcome or conclusion, important facts or decisions, and any unresolved handoff.";
const legacySummaryInstruction =
  "The page summary must name the new beat or changed consequence introduced on this page.";

const input: CreateProjectInput = {
  prompt: "A character-led mystery.",
  category: "STORY",
  targetPages: 3,
  complexity: 5,
  temperature: 0.7,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "manual",
    includeCover: false,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

const draft: PageDraft = {
  title: "The Last Door",
  markdown: "Luna steadied the compass and opened the last door.",
  summary: "Luna opens the last door.",
  continuityNotes: []
};

function capturingModel(capture: { instruction?: string }): TextModelAdapter {
  return {
    async generateText() {
      return { text: "", model: "test-model", provider: "test" };
    },
    async generateJson(options) {
      const payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, unknown>;
      capture.instruction = String(payload.pageInstruction ?? payload.instruction ?? "");
      return {
        data: options.schema.parse(draft),
        text: JSON.stringify(draft),
        model: "test-model",
        provider: "test"
      };
    },
    async *streamText() {
      yield "";
    },
    generateWithTools: unsupportedGenerateWithTools
  };
}

describe("saved-page summary instruction scope", () => {
  it("strengthens the summary contract for an initial page draft", async () => {
    const capture: { instruction?: string } = {};
    const plan = makeFallbackPlan(input);

    await generatePageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 1,
      previousSummaries: [],
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capturingModel(capture)
    });

    expect(capture.instruction).toContain(strengthenedSummaryInstruction);
    expect(capture.instruction).not.toContain(legacySummaryInstruction);
  });

  it("retains the legacy summary contract for a QA revision", async () => {
    const capture: { instruction?: string } = {};
    const plan = makeFallbackPlan(input);

    await revisePageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 1,
      draft,
      report: {
        approved: false,
        score: 40,
        issues: ["Luna is absent."],
        requiredRevisions: ["Add Luna."],
        notes: "Revise.",
        groundedOk: true,
        unsupportedClaims: [],
        checks: {
          placeholderFree: true,
          promptLeakFree: true,
          titleClean: true,
          repetitionOk: true,
          progressionOk: true,
          styleNatural: true
        }
      },
      previousPages: [],
      continuityNotes: [],
      textModel: capturingModel(capture)
    });

    expect(capture.instruction).toContain(legacySummaryInstruction);
    expect(capture.instruction).not.toContain(strengthenedSummaryInstruction);
  });
});
