import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { revisePageDraft } from "./pagesReview.js";

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

describe("page edit character context", () => {
  it("keeps supplemental character canon separate from the approved edit instruction", async () => {
    const capture: { payload?: Record<string, unknown>; system?: string } = {};
    const textModel: TextModelAdapter = {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        capture.system = options.messages[0]?.content ?? "";
        capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, unknown>;
        const data = {
          title: "The Last Door",
          markdown: "Luna steadied the compass and opened the last door.",
          summary: "Luna opens the last door.",
          continuityNotes: []
        };
        return { data: options.schema.parse(data), text: JSON.stringify(data), model: "test-model", provider: "test" };
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools
    };
    const plan = makeFallbackPlan(input);
    const editInstruction = "Add Luna to the final scene.";
    const characterContext = "Mentioned character profiles:\n- Luna: a careful navigator";

    await revisePageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Last Door",
        markdown: "The last door stayed closed.",
        summary: "The last door remains closed.",
        continuityNotes: []
      },
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
      editInstruction,
      characterContext,
      previousPages: [],
      continuityNotes: [],
      textModel
    });

    expect(capture.payload?.editInstruction).toBe(editInstruction);
    expect(capture.payload?.characterContext).toBe(characterContext);
    expect(capture.system).toContain("supplemental canon");
    expect(capture.system).toContain("do not treat it as an additional requested edit");
  });
});
