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
    expect(capture.system).toMatch(/do not require a diary, dispatch, archive, citation, named testimony/i);
    expect(capture.system).toMatch(/earlier page outside the supplied context may have established it/i);
    expect(capture.payload?.researchNotes).toEqual([]);
  });

  it("ignores an invented-source verdict because an earlier page may establish it", async () => {
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

    expect(result).toMatchObject({
      approved: true,
      score: 42,
      issues: [],
      requiredRevisions: []
    });
    expect(capture.system).toMatch(/never reject .* merely because it may be fake, invented, fabricated/i);
    expect(capture.system).toMatch(/earlier page outside the supplied context may have established it/i);
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
    expect(capture.system).toMatch(/do not require a diary, dispatch, archive, citation, named testimony/i);
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

  it("does not hard-reject when the model returns only a frozen source-identity complaint", async () => {
    const capture = capturingReviewModel({
      approved: false,
      score: 58,
      issues: [
        "The opening scene is presented as documented, but no specific testimony, contemporary record, archive, or named source is identified, failing the pageBrief's explicit sourcing requirement."
      ],
      requiredRevisions: [
        "Name the specific contemporary record or testimony supporting the opening scene, and distinguish that source's perspective from later interpretations."
      ],
      notes: "The opening needs a named record."
    });

    const result = await reviewPageDraft({
      input,
      plan,
      pageIndex: 2,
      pageBrief: diaryBrief,
      draft: {
        title: "December Under Dispute",
        markdown: warsJulyCrisisMarkdown(),
        summary: "Dated public events establish the conflict without inventing testimony.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(result).toMatchObject({
      approved: true,
      score: 58,
      issues: [],
      requiredRevisions: []
    });
  });

  it("keeps a mixed frozen report rejected for the remaining real defect", async () => {
    const capture = capturingReviewModel({
      approved: false,
      score: 58,
      issues: [
        "The opening scene is presented as documented, but no specific testimony, contemporary record, archive, or named source is identified, failing the pageBrief's explicit sourcing requirement.",
        "The page covers too much chronology for an opening page, moving from the December shooting through the January 1945 Varkiza Agreement. This weakens the requested inside-the-moment opening and compresses later developments that belong on subsequent pages."
      ],
      requiredRevisions: [
        "Name the specific contemporary record or testimony supporting the opening scene, and distinguish that source's perspective from later interpretations.",
        "Keep this page centered on 3 December and defer the Varkiza settlement to its assigned later page."
      ],
      notes: "The opening also overpacks later chronology."
    });

    const result = await reviewPageDraft({
      input,
      plan,
      pageIndex: 2,
      pageBrief: diaryBrief,
      draft: {
        title: "December Under Dispute",
        markdown: warsJulyCrisisMarkdown(),
        summary: "The page ranges beyond the immediate December crisis.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(result.approved).toBe(false);
    expect(result.issues).toEqual([
      "The page covers too much chronology for an opening page, moving from the December shooting through the January 1945 Varkiza Agreement. This weakens the requested inside-the-moment opening and compresses later developments that belong on subsequent pages."
    ]);
    expect(result.requiredRevisions).toEqual([
      "Keep this page centered on 3 December and defer the Varkiza settlement to its assigned later page."
    ]);
  });

  it("promotes a high-scoring rejection made only of explicitly optional feedback", async () => {
    const capture = capturingReviewModel({
      approved: false,
      score: 88,
      issues: [
        "The page is somewhat general in places, but it grounds the narrative in specific events and qualifies uncertainty appropriately.",
        "The generic family could be seen as an illustrative reconstruction, but it does not constitute fabrication.",
        "The page does not name a diary, but it avoids inventing one, which is correct per instructions.",
        "The page does not present a specific invented individual and does not imply a fabricated witness.",
        "The page does not introduce new factual claims but instead synthesizes material established in previous pages.",
        "The page uses a generic composite family without a documented source, which risks reading as an invented scene.",
        "The uncertainty theme could be seen as slightly repetitive, but it is necessary and does not stall progression.",
        "The ending repeats the pressure, but this is the required ending pressure and not a semantic repetition.",
        "The ending repeats the idea, which is the ending pressure, but does so without restaging a specific beat."
      ],
      requiredRevisions: [
        "Ensure that the contemporary record is not presented as a fabricated source; it is generic, which is acceptable.",
        "Tighten the wording to avoid any impression of invented specifics."
      ],
      notes: "The prose is specific and avoids fabrication. The family is presented as a general pattern rather than a specific witnessed event."
    });

    const result = await reviewPageDraft({
      input,
      plan,
      pageIndex: 2,
      draft: {
        title: "The Institutions Hold",
        markdown: warsJulyCrisisMarkdown(),
        summary: "Specific public events carry the page.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(result).toMatchObject({
      approved: true,
      score: 88,
      issues: [],
      requiredRevisions: []
    });
  });

  it("does not promote a high-scoring rejection with a factual defect", async () => {
    const factualIssue =
      "The page contains a major factual and chronological error: the transfer occurred from Thysville, not directly from Léopoldville.";
    const capture = capturingReviewModel({
      approved: false,
      score: 88,
      issues: [factualIssue],
      requiredRevisions: ["Correct the transfer chronology."],
      notes: "The chronology must be corrected."
    });

    const result = await reviewPageDraft({
      input,
      plan,
      pageIndex: 2,
      draft: {
        title: "The Transfer",
        markdown: warsJulyCrisisMarkdown(),
        summary: "The transfer chronology is wrong.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(result.approved).toBe(false);
    expect(result.issues).toEqual([factualIssue]);
  });

  it("keeps a factual defect when the same complaint also calls a source invented", async () => {
    const mixedIssue =
      "The cited journal may be invented, and the page also contains a factual chronology error: the transfer occurred from Thysville, not directly from Léopoldville.";
    const capture = capturingReviewModel({
      approved: false,
      score: 48,
      issues: [mixedIssue],
      requiredRevisions: ["Correct the transfer chronology; the current sequence is factually wrong."],
      notes: "The chronology is independently incorrect regardless of the journal's identity."
    });

    const result = await reviewPageDraft({
      input,
      plan,
      pageIndex: 2,
      draft: {
        title: "The Transfer",
        markdown: warsJulyCrisisMarkdown(),
        summary: "The transfer chronology is wrong.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(result.approved).toBe(false);
    expect(result.issues).toEqual([mixedIssue]);
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
    expect(capture.system).toMatch(/qualified public facts as the available context/i);
    expect(capture.system).toMatch(/never reject .* absent from researchNotes/i);
  });

  it("does not reject an unnamed composite merely as fake", async () => {
    const capture = capturingReviewModel({
      approved: true,
      score: 88,
      issues: [],
      requiredRevisions: [],
      notes: "The anonymous magistrate is only illustrative."
    });

    const result = await reviewPageDraft({
      input,
      plan: {
        ...plan,
        antiAiRules: [...plan.antiAiRules, "Do not invent scenes, composites, or reconstructed viewpoints."]
      },
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
        markdown: [
          "In spring 1920, a county magistrate in China could hold an official seal while wondering which authority would recognize it. The magistrate's practical task was to decide which orders could be enforced.",
          "",
          goodMarkdown()
        ].join("\n"),
        summary: "An unnamed magistrate is presented as a witnessed scene.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(result.approved).toBe(true);
    expect(result.issues).toEqual([]);
    expect(capture.system).toMatch(/never reject .* merely because it may be fake, invented, fabricated/i);
    expect(capture.system).toMatch(/earlier page outside the supplied context may have established it/i);
  });

  it("ignores a source-identity verdict that earlier pages may already support", async () => {
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

    expect(result).toMatchObject({ approved: true, issues: [], requiredRevisions: [] });
    expect(capture.system).toMatch(/earlier page outside the supplied context may have established it/i);
  });
});
