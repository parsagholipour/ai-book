import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { revisePageDraft, type RevisePageOptions } from "./pagesReview.js";

/**
 * A page drafted for an edit — a continuation's, an inserted one — is repaired
 * like any generated page, and only a reader's edit of finished prose keeps its
 * unnamed sentences byte for byte. A continuation's repair was told the second
 * and kept an opening that re-narrated the page before it (2026-10-02).
 */
const input: CreateProjectInput = {
  prompt: "A quiet literary story.",
  category: "STORY",
  targetPages: 15,
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

const FINISHED_PROSE = "reader-requested edit of finished prose";
const ADVANCE = "must advance beyond the prior pages";
const SEAM = "needs a new opening";

async function reviseSystem(overrides: Partial<RevisePageOptions>) {
  const capture: { system?: string; payload?: { previousPages?: Array<{ ending?: string }> } } = {};
  const textModel: TextModelAdapter = {
    async generateText() {
      return { text: "", model: "test-model", provider: "test" };
    },
    async generateJson(options) {
      capture.system = options.messages[0]?.content ?? "";
      capture.payload = JSON.parse(options.messages[1]?.content ?? "{}");
      const data = { title: "The Quay", markdown: "Nasser's letter came at noon.", summary: "A letter comes.", continuityNotes: [] };
      return { data: options.schema.parse(data), text: JSON.stringify(data), model: "test-model", provider: "test" };
    },
    async *streamText() {
      yield "";
    },
    generateWithTools: unsupportedGenerateWithTools
  };
  const plan = makeFallbackPlan(input);
  await revisePageDraft({
    input,
    plan,
    chapter: plan.chapters[0],
    pageIndex: 14,
    draft: { title: "The Quay", markdown: "Salim wiped oil from the brass.", summary: "Salim waits.", continuityNotes: [] },
    report: {
      approved: false,
      score: 60,
      issues: ["Repeats the previous page."],
      requiredRevisions: ["Advance the story."],
      notes: "Revise.",
      groundedOk: true,
      unsupportedClaims: [],
      checks: { placeholderFree: true, promptLeakFree: true, titleClean: true, repetitionOk: false, progressionOk: true, styleNatural: true }
    },
    previousPages: [
      {
        index: 13,
        title: "The Quay at Dawn",
        markdown: `${"Dawn over the inlet. ".repeat(60)}He wiped a bead of oil from the brass.`,
        summary: "Salim sends his answer."
      }
    ],
    continuityNotes: [],
    textModel,
    ...overrides
  });
  return capture;
}

describe("revising a page drafted for an edit", () => {
  it("repairs it like a generated page, told where the page before it ends", async () => {
    const { system, payload } = await reviseSystem({ editInstruction: "Write the next chapter.", draftedForEdit: true });
    expect(system).not.toContain(FINISHED_PROSE);
    expect(system).toContain(ADVANCE);
    expect(system).toContain(SEAM);
    expect(payload?.previousPages?.at(-1)?.ending).toMatch(/oil from the brass\.$/);
  });

  it("keeps a reader's edit of finished prose byte for byte, openings included", async () => {
    const { system } = await reviseSystem({ editInstruction: "Make Salim warmer." });
    expect(system).toContain(FINISHED_PROSE);
    expect(system).not.toContain(SEAM);
  });

  it("gives a generation-time repair the seam rule too", async () => {
    const { system } = await reviseSystem({});
    expect(system).toContain(ADVANCE);
    expect(system).toContain(SEAM);
  });
});
