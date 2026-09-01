import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput, PageQualityReport } from "../schemas/book.js";
import { repairPageBrief } from "./pagesPageMap.js";
import { revisePageDraft } from "./pagesReview.js";

const input: CreateProjectInput = {
  prompt: "A character-led story about a costly choice.",
  category: "STORY",
  targetPages: 6,
  complexity: 5,
  temperature: 0.7,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: false,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

describe("page QA rewrite call metadata", () => {
  it("does not classify a user-requested rewrite as a page-QA call", async () => {
    let request: GenerateJsonOptions<unknown> | undefined;
    const draft = {
      title: "The Warrant",
      markdown: "Jack unfolded the warrant and named the accusation.",
      summary: "Jack makes the accusation public.",
      continuityNotes: [] as string[]
    };
    const model: TextModelAdapter = {
      async generateText() {
        return { text: "", provider: "test", model: "test" };
      },
      async generateJson(options) {
        request = options;
        return { data: options.schema.parse(draft), text: JSON.stringify(draft), provider: "test", model: "test" };
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
      pageIndex: 4,
      draft,
      report: {
        approved: false,
        score: 50,
        issues: ["User requested this page edit: make the accusation clearer."],
        requiredRevisions: ["Apply the requested edit."],
        notes: "User-requested book edit.",
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
      editInstruction: "Make the accusation clearer.",
      previousPages: [],
      continuityNotes: [],
      textModel: model
    });

    expect(request?.purpose).toBe("revise-page");
    expect(request?.providerCallMetadata).toBeUndefined();
  });

  it("tags a full rewrite with every trigger and its candidate number", async () => {
    let request: GenerateJsonOptions<unknown> | undefined;
    const draft = {
      title: "The Warrant",
      markdown: "Jack unfolded the warrant and named the accusation.",
      summary: "Jack makes the accusation public.",
      continuityNotes: [] as string[]
    };
    const model: TextModelAdapter = {
      async generateText() {
        return { text: "", provider: "test", model: "test" };
      },
      async generateJson(options) {
        request = options;
        return { data: options.schema.parse(draft), text: JSON.stringify(draft), provider: "test", model: "test" };
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
      pageIndex: 4,
      qaCandidateNumber: 4,
      draft,
      report: {
        approved: false,
        score: 40,
        issues: ["Unsupported claim: an uncited date.", "The draft restages a reserved closing beat."],
        requiredRevisions: ["Ground or remove the date.", "Reserve the closing synthesis for the later page."],
        notes: "The factual and reserved-beat checks rejected the page.",
        groundedOk: false,
        unsupportedClaims: ["an uncited date"],
        stylePenalty: 15,
        checks: {
          placeholderFree: true,
          promptLeakFree: true,
          titleClean: true,
          repetitionOk: true,
          progressionOk: false,
          styleNatural: false
        }
      } as PageQualityReport & { stylePenalty: number },
      previousPages: [],
      continuityNotes: [],
      textModel: model
    });

    expect(request?.purpose).toBe("revise-page");
    expect(request?.providerCallMetadata).toEqual({
      qaTriggerReasons: ["claim_grounding", "style", "reserved_beat"],
      qaCandidateNumber: 4,
      qaRewriteNumber: 3
    });
  });

  it("tags a page-brief repair with its underlying trigger and next candidate", async () => {
    let request: GenerateJsonOptions<unknown> | undefined;
    const model: TextModelAdapter = {
      async generateText() {
        return { text: "", provider: "test", model: "test" };
      },
      async generateJson(options) {
        request = options;
        const data = {
          pageIndex: 4,
          chapterIndex: 1,
          purpose: "Introduce a new consequence.",
          beat: "The warrant becomes public.",
          requiredContinuity: [],
          endingPressure: "The accusation can no longer be hidden."
        };
        return { data: options.schema.parse(data), text: JSON.stringify(data), provider: "test", model: "test" };
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools
    };
    const plan = makeFallbackPlan(input);

    await repairPageBrief({
      input,
      plan,
      chapter: plan.chapters[0],
      pageBrief: {
        pageIndex: 4,
        chapterIndex: 1,
        purpose: "Repeat the checkpoint.",
        beat: "Restage the checkpoint decision.",
        requiredContinuity: [],
        endingPressure: "The same choice returns."
      },
      pageIndex: 4,
      qaCandidateNumber: 5,
      draft: {
        title: "The Checkpoint Again",
        markdown: "The same checkpoint choice happened again.",
        summary: "The prior beat repeats.",
        continuityNotes: []
      },
      report: {
        approved: false,
        score: 40,
        issues: ["The model review found a repeated beat."],
        requiredRevisions: ["Replace the repeated beat."],
        notes: "The assignment is stale.",
        groundedOk: true,
        unsupportedClaims: [],
        checks: {
          placeholderFree: true,
          promptLeakFree: true,
          titleClean: true,
          repetitionOk: false,
          progressionOk: false,
          styleNatural: true
        }
      },
      previousPages: [],
      continuityNotes: [],
      textModel: model
    });

    expect(request?.purpose).toBe("repair-page-brief");
    expect(request?.providerCallMetadata).toEqual({
      qaTriggerReasons: ["model_review", "brief_repair"],
      qaCandidateNumber: 5,
      qaRewriteNumber: 4
    });
  });
});
