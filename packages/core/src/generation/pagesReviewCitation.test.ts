import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
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
  system?: string;
} {
  const capture: { model: TextModelAdapter; payload?: Record<string, unknown>; system?: string } = {
    model: {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        capture.system = options.messages[0]?.content ?? "";
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

describe("reviewPageDraft citation contract", () => {
  const diaryBrief = {
    pageIndex: 2,
    chapterIndex: 1,
    purpose: "Show how residents understood the order.",
    beat: "Name a civilian diary and quote its account of the order.",
    requiredContinuity: ["Identify the diary or archive holding it."],
    endingPressure: "Land on the limits of the surviving record."
  };

  /**
   * Stored page-1 brief from the Wars diagnosis. The payload copy must lose
   * diary / newspaper / source-status demands when notes are empty; the row
   * itself is not rewritten here.
   */
  const warsPage1Brief = {
    pageIndex: 1,
    chapterIndex: 1,
    purpose:
      "Open inside the July Crisis through a documented moment in a mobilizing European city, assigning the openingHook without explaining the book or defining the war.",
    beat: "Present a specific sourced observation, notice, diary entry, newspaper report, public announcement, or other record showing ordinary people encountering mobilization, mourning, military preparation, or uncertainty after the Sarajevo assassination. Keep the immediate question concrete: what does this first visible disruption mean, and how quickly can a regional crisis become a war?",
    requiredContinuity: [
      "Identify the date, place, person or record, and source status. Do not invent interior thoughts or dialogue. Clarify that the assassination was a trigger within an already tense international system, not a complete explanation."
    ],
    endingPressure:
      "Leave the reader needing to know how an assassination in Sarajevo could activate decisions across several governments and turn public uncertainty into military movement."
  };

  function warsJulyCrisisMarkdown(): string {
    return [
      "On 28 June 1914 the shots in Sarajevo killed the heir and, by evening, crowds on the Ringstrasse already treated the crime as Austria-Hungary's affair with a Balkan fuse.",
      "",
      "Shopkeepers read extra editions aloud. Clerks in the war ministry stayed past dusk copying mobilisation tables, while an ultimatum took shape that would ask Serbia to accept terms no independent government could swallow whole.",
      "",
      "What the first visible disruption meant was still unsettled: a regional crisis, or the opening move of a war several cabinets could no longer stop."
    ].join("\n");
  }

  function sourceIdentityDemandIn(value: unknown): boolean {
    return /diar(?:y|ies)|newspaper|source status/i.test(JSON.stringify(value));
  }

  it("does not require an unsupplied diary identity when researchNotes is empty", async () => {
    const capture = capturingReviewModel({
      approved: true,
      score: 91,
      issues: [],
      requiredRevisions: [],
      notes: "The prose is grounded and appropriately qualified."
    });

    const result = await reviewPageDraft({
      input,
      plan,
      pageIndex: 2,
      pageBrief: diaryBrief,
      draft: {
        title: "The Order at the Ferry",
        markdown: goodMarkdown(),
        summary: "The surviving order establishes a sequence but not every resident's response.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(result.approved).toBe(true);
    expect(capture.system).toContain("do not assign, require, invent, or reject prose for omitting a diary");
    expect(capture.payload?.researchNotes).toEqual([]);
  });

  it("still rejects an invented named journal", async () => {
    const capture = capturingReviewModel({
      approved: false,
      score: 42,
      issues: ["The named North March Historical Journal is invented."],
      requiredRevisions: ["Remove the invented journal and qualify the claim."],
      notes: "Fabricated source identity."
    });

    const result = await reviewPageDraft({
      input,
      plan,
      pageIndex: 2,
      pageBrief: diaryBrief,
      draft: {
        title: "The Order at the Ferry",
        markdown: `${goodMarkdown()} The North March Historical Journal supposedly confirmed the account in 1912.`,
        summary: "The page attributes the account to a named journal.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(result.approved).toBe(false);
    expect(result.issues.join(" ")).toMatch(/invented/i);
    expect(capture.system).toContain("Still reject invented named sources");
  });

  it("sanitizes the Wars page-1 brief in the payload when researchNotes is empty", async () => {
    const capture = capturingReviewModel({
      approved: true,
      score: 88,
      issues: [],
      requiredRevisions: [],
      notes: "Dated, placed, and specific enough without a named diary."
    });

    const result = await reviewPageDraft({
      input,
      plan,
      pageIndex: 1,
      pageBrief: warsPage1Brief,
      draft: {
        title: "After Sarajevo",
        markdown: warsJulyCrisisMarkdown(),
        summary: "Vienna reacts to 28 June 1914 while an ultimatum takes shape.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(result.approved).toBe(true);
    expect(capture.system).toContain("researchNotes is empty:");
    expect(capture.system).toMatch(
      /do not reject it for omitting a named private civilian, interview, photograph caption, testimony/i
    );
    expect(sourceIdentityDemandIn(capture.payload?.pageBrief)).toBe(false);
    expect(JSON.stringify(capture.payload?.pageBrief)).toMatch(/Sarajevo|July Crisis|mobiliz/i);
    expect(JSON.stringify(capture.payload?.pageBrief)).toMatch(/interior thoughts/i);
  });

  it("leaves the same brief intact when a URL-backed note can satisfy it", async () => {
    const capture = capturingReviewModel({
      approved: true,
      score: 90,
      issues: [],
      requiredRevisions: [],
      notes: "The assignment is now satisfiable."
    });

    await reviewPageDraft({
      input,
      plan,
      pageIndex: 1,
      pageBrief: warsPage1Brief,
      draft: {
        title: "After Sarajevo",
        markdown: warsJulyCrisisMarkdown(),
        summary: "Vienna reacts to 28 June 1914 while an ultimatum takes shape.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      researchNotes: [
        "July Crisis papers (https://example.com/july-crisis): Diplomatic correspondence after Sarajevo."
      ],
      textModel: capture.model
    });

    expect(sourceIdentityDemandIn(capture.payload?.pageBrief)).toBe(true);
    expect(capture.payload?.pageBrief).toMatchObject({
      beat: warsPage1Brief.beat,
      requiredContinuity: warsPage1Brief.requiredContinuity
    });
    expect(capture.system).toContain("Use only sources present in researchNotes");
  });

  it("forbids rejecting dated placed prose for omitted testimony when notes are empty", async () => {
    const capture = capturingReviewModel({
      approved: true,
      score: 86,
      issues: [],
      requiredRevisions: [],
      notes: "Dates, places, and qualified claims are enough."
    });

    const result = await reviewPageDraft({
      input,
      plan,
      pageIndex: 2,
      pageBrief: warsPage1Brief,
      draft: {
        title: "The Ultimatum Takes Shape",
        markdown: warsJulyCrisisMarkdown(),
        summary: "28 June 1914 in Sarajevo forces Austria-Hungary toward an ultimatum.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(result.approved).toBe(true);
    expect(capture.system).toMatch(/specific enough/i);
    expect(capture.system).toMatch(
      /do not reject it for omitting a named private civilian, interview, photograph caption, testimony/i
    );
  });

  it("still rejects an unnamed composite presented as a witnessed scene", async () => {
    const capture = capturingReviewModel({
      approved: false,
      score: 40,
      issues: [
        "The page fabricates a witnessed scene of a county magistrate in China in spring 1920 with no county or record."
      ],
      requiredRevisions: ["Remove the invented scene or ground it in a named place the notes can support."],
      notes: "Fabricated scene."
    });

    const result = await reviewPageDraft({
      input,
      plan,
      pageIndex: 2,
      pageBrief: {
        pageIndex: 2,
        chapterIndex: 1,
        purpose: "Show how authority met unrest.",
        beat: "A local official answers the first protests.",
        requiredContinuity: ["Do not invent interior thoughts."],
        endingPressure: "The next page must say what the protest becomes."
      },
      draft: {
        title: "A County Magistrate",
        markdown: `${goodMarkdown()} A county magistrate in China in spring 1920 watched the petitioners gather and promised a hearing he had no power to hold.`,
        summary: "An unnamed magistrate is presented as a witnessed scene.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(result.approved).toBe(false);
    expect(capture.system).toMatch(/unnamed composite presented as a witnessed scene/i);
    expect(capture.system).toContain("Still reject invented named sources, fabricated scenes");
  });

  it("still rejects an unsupported named journalist or unnamed contemporary record", async () => {
    const capture = capturingReviewModel({
      approved: false,
      score: 44,
      issues: [
        "Marguerite Higgins’s dispatches are named, and 'one contemporary record' is treated as identified evidence, with no identity in researchNotes."
      ],
      requiredRevisions: ["Drop the named journalist and the anonymous record, or qualify the claim."],
      notes: "Unsupported named source."
    });

    const result = await reviewPageDraft({
      input,
      plan,
      pageIndex: 2,
      pageBrief: {
        pageIndex: 2,
        chapterIndex: 1,
        purpose: "Show how the landing was reported.",
        beat: "Describe the first day of the landing through public events.",
        requiredContinuity: ["Do not invent interior thoughts."],
        endingPressure: "The next page follows the advance inland."
      },
      draft: {
        title: "The Landing",
        markdown: `${goodMarkdown()} Marguerite Higgins’s dispatches claimed the ridge was taken by noon, and one contemporary record supposedly confirmed the same hour.`,
        summary: "The page cites Higgins and an unnamed contemporary record.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(result.approved).toBe(false);
    expect(capture.system).toMatch(/named publication, dispatch, embassy record, or journalist/i);
  });
});
