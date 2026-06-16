import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput, PageDraft } from "../schemas/book.js";
import { chapterBriefSchema, finalBookQaSchema, pageDraftSchema, pageQualityReportSchema } from "../schemas/book.js";
import {
  compactSummaryForQa,
  generateBatchDraft,
  generateChapterBrief,
  generateChapterDraft,
  generatePageDraft,
  generateWholeBookPageMap,
  generateWholeBookDraft,
  polishPageDraft,
  repairPageBrief,
  reviewPageDraft,
  revisePageDraft,
  shouldIllustratePage
} from "./pages.js";

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
    lessCensored: false,
    toneProfile: "neutral" as const
  }
};

const plan = makeFallbackPlan(input);
const textModel = new FakeTextModelAdapter(input);

describe("illustration cadence", () => {
  it("treats education and health as diagram-friendly nonfiction", () => {
    const educationInput = { ...input, category: "EDUCATION" as const };
    const healthInput = { ...input, category: "HEALTH" as const };
    const businessInput = { ...input, category: "BUSINESS" as const };

    expect(shouldIllustratePage(educationInput, makeFallbackPlan(educationInput), 4)).toBe(true);
    expect(shouldIllustratePage(healthInput, makeFallbackPlan(healthInput), 4)).toBe(true);
    expect(shouldIllustratePage(businessInput, makeFallbackPlan(businessInput), 4)).toBe(false);
  });
});

describe("page quality review", () => {
  it("accepts common wrapped JSON shapes from model responses", () => {
    const brief = chapterBriefSchema.parse({
      chapterBrief: {
        chapterIndex: 1,
        title: "Chapter 1: The Door Opens",
        summary: "Jack crosses a threshold.",
        pages: [
          {
            pageIndex: 1,
            chapterIndex: 1,
            purpose: "Open with a concrete scene.",
            beat: "Jack hears someone behind the chapel door.",
            endingPressure: "The latch moves before Jack touches it."
          }
        ]
      }
    });
    const page = pageDraftSchema.parse({
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack opens the chapel door.",
        continuityNotes: []
      }
    });
    const report = pageQualityReportSchema.parse({
      qualityReport: {
        approved: true,
        score: 90,
        issues: [],
        requiredRevisions: [],
        notes: "Approved."
      }
    });
    const finalQa = finalBookQaSchema.parse({
      finalQa: {
        approved: true,
        score: 90,
        issues: [],
        requiredFixes: [],
        notes: "Approved."
      }
    });

    expect(brief.chapterIndex).toBe(1);
    expect(page.title).toBe("The Door Opens");
    expect(report.approved).toBe(true);
    expect(finalQa.approved).toBe(true);
  });

  it("truncates final QA summaries on word boundaries with an ellipsis", () => {
    const summary =
      "Jack sits alone in a ruined chapel, burdened by survivor's guilt and the hollow title of 'the Martyr.' The rain and silence underscore his isolation, leaving him numb.";
    const compact = compactSummaryForQa(summary, 120);
    expect(compact.endsWith("…")).toBe(true);
    expect(compact).not.toMatch(/lea$/);
    expect(compactSummaryForQa(summary, summary.length + 10)).toBe(summary);
  });

  it("normalizes final QA responses that only return approved and reasons", () => {
    const rejected = finalBookQaSchema.parse({
      approved: false,
      reasons: ["Repeated page titles and no arc progression."]
    });
    expect(rejected.score).toBe(45);
    expect(rejected.issues).toEqual(["Repeated page titles and no arc progression."]);
    expect(rejected.approved).toBe(false);

    const approved = finalBookQaSchema.parse({
      approved: true,
      reasons: []
    });
    expect(approved.score).toBe(85);
    expect(approved.issues).toEqual([]);
  });

  it("normalizes reviewer responses that only return approved and feedback", () => {
    const rejected = pageQualityReportSchema.parse({
      approved: false,
      feedback: "The page repeats the previous scene without new stakes."
    });
    expect(rejected.score).toBe(45);
    expect(rejected.issues).toEqual(["The page repeats the previous scene without new stakes."]);
    expect(rejected.approved).toBe(false);

    const approved = pageQualityReportSchema.parse({
      approved: true,
      feedback: "Concrete scene work with clean prose."
    });
    expect(approved.score).toBe(85);
    expect(approved.issues).toEqual([]);
    expect(approved.notes).toBe("Concrete scene work with clean prose.");
  });

  it("normalizes scalar continuity notes on page drafts", () => {
    const page = pageDraftSchema.parse({
      title: "The Door Opens",
      markdown: goodMarkdown(),
      summary: "Jack opens the chapel door.",
      continuityNotes: "Jack has a scar over his left eyebrow.",
      imagePrompt: "A candlelit chapel door."
    });

    expect(page.continuityNotes).toEqual(["Jack has a scar over his left eyebrow."]);
  });

  it("derives a page draft summary when the model omits it", () => {
    const page = pageDraftSchema.parse({
      title: "The Door Opens",
      markdown: goodMarkdown(),
      continuityNotes: []
    });

    expect(page.summary).toContain("The chapel door had been painted black");
    expect(page.summary.length).toBeLessThanOrEqual(243);
  });

  it("includes recent page excerpts and final-page resolution guidance in draft prompts", async () => {
    let request: GenerateJsonOptions<unknown> | undefined;
    const promptInput = {
      ...input,
      subcategory: "Mystery & thriller",
      mediaSettings: { ...input.mediaSettings, toneProfile: "skeptical" as const }
    };
    const promptPlan = makeFallbackPlan(promptInput);
    const model: TextModelAdapter = {
      async generateText() {
        return {
          text: "",
          model: "test-model",
          provider: "test"
        };
      },
      async generateJson(options) {
        request = options;
        return {
          data: options.schema.parse({
            title: "The Last Candle",
            markdown: goodFinalMarkdown(),
            summary: "Jack gives Oakhaven a public answer and accepts the consequence.",
            continuityNotes: []
          }),
          text: "",
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      }
    };

    await generatePageDraft({
      input: promptInput,
      plan: promptPlan,
      chapter: promptPlan.chapters[0],
      pageIndex: promptInput.targetPages,
      previousSummaries: ["Jack already crossed the checkpoint and chose Oakhaven."],
      previousPages: [
        {
          index: 9,
          title: "The Checkpoint",
          markdown: "At the checkpoint, Jack showed the guard the cracked seal and chose not to run.",
          summary: "Jack passes the checkpoint by refusing to hide the seal."
        }
      ],
      continuityNotes: [],
      researchNotes: [],
      textModel: model
    });

    const systemMessage = request?.messages.find((message) => message.role === "system")?.content;
    const userMessage = request?.messages.find((message) => message.role === "user")?.content;
    expect(systemMessage).toMatch(/Tone profile: Skeptical/i);
    expect(systemMessage).toMatch(/This is not a coincidence/i);
    expect(systemMessage).toMatch(/adjacent contrast sentences/i);
    expect(userMessage).toBeTruthy();
    const payload = JSON.parse(userMessage ?? "{}") as {
      recentPages: Array<{ excerpt: string }>;
      alreadyCovered: Array<{ coveredBeat: string }>;
      userContext: { subcategory?: string; styleGuidance?: { toneProfile?: string; rules?: string[] } };
      pageInstruction: string;
    };

    expect(payload.userContext.subcategory).toBe("Mystery & thriller");
    expect(payload.userContext.styleGuidance?.toneProfile).toBe("skeptical");
    expect(payload.userContext.styleGuidance?.rules?.join(" ")).toMatch(/proof-leap/i);
    expect(payload.recentPages[0]?.excerpt).toContain("checkpoint");
    expect(payload.alreadyCovered[0]?.coveredBeat).toContain("checkpoint");
    expect(systemMessage).toMatch(/Treat pageBrief purpose, beat, requiredContinuity, and endingPressure as internal assignment notes/i);
    expect(systemMessage).toMatch(/concluding the survey/i);
    expect(payload.pageInstruction).toMatch(/final page/i);
    expect(payload.pageInstruction).toMatch(/resolve/i);
    expect(payload.pageInstruction).toMatch(/internal metadata/i);
    expect(payload.pageInstruction).toMatch(/Treat pageBrief and endingPressure as internal notes/i);
    expect(payload.pageInstruction).toMatch(/never invent studies/i);
  });

  it("includes Kids age-range guidance in page draft prompts and payloads", async () => {
    let request: GenerateJsonOptions<unknown> | undefined;
    const promptInput = kidsInput("4-6");
    const promptPlan = makeFallbackPlan(promptInput);
    const model: TextModelAdapter = {
      async generateText() {
        return {
          text: "",
          model: "test-model",
          provider: "test"
        };
      },
      async generateJson(options) {
        request = options;
        return {
          data: options.schema.parse({
            title: "The First Step",
            markdown: kidsGoodMarkdown(),
            summary: "Turtle and Rabbit begin the race.",
            continuityNotes: []
          }),
          text: "",
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      }
    };

    await generatePageDraft({
      input: promptInput,
      plan: promptPlan,
      chapter: promptPlan.chapters[0],
      pageIndex: 1,
      previousSummaries: [],
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: model
    });

    const systemMessage = request?.messages.find((message) => message.role === "system")?.content;
    const userMessage = request?.messages.find((message) => message.role === "user")?.content;
    const payload = JSON.parse(userMessage ?? "{}") as {
      context?: { system?: string };
      userContext?: {
        styleGuidance?: {
          readingGuidance?: {
            ageRange?: string;
            targetWordsPerPage?: { min?: number; max?: number };
          };
        };
      };
    };

    expect(systemMessage).toMatch(/Kids reading level: 4-6/i);
    expect(payload.context?.system).toMatch(/Reading guidance/i);
    expect(payload.userContext?.styleGuidance?.readingGuidance?.ageRange).toBe("4-6");
    expect(payload.userContext?.styleGuidance?.readingGuidance?.targetWordsPerPage).toEqual({ min: 20, max: 65 });
  });

  it("tells page drafting to use exact recurring character names in image prompts", async () => {
    let request: GenerateJsonOptions<unknown> | undefined;
    const characterPlan = {
      ...plan,
      characters: [
        {
          name: "Nora",
          role: "Child protagonist",
          description: "A careful child who follows the bell sounds.",
          traits: ["observant"],
          visualRules: ["Round red glasses.", "Yellow raincoat."]
        }
      ]
    };
    const model: TextModelAdapter = {
      async generateText() {
        return {
          text: "",
          model: "test-model",
          provider: "test"
        };
      },
      async generateJson(options) {
        request = options;
        return {
          data: options.schema.parse({
            title: "The Bell Path",
            markdown: goodMarkdown(),
            summary: "Nora follows the bell path.",
            continuityNotes: [],
            imagePrompt: "Nora in her yellow raincoat hears the bell."
          }),
          text: "",
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      }
    };

    await generatePageDraft({
      input,
      plan: characterPlan,
      chapter: characterPlan.chapters[0],
      pageIndex: 1,
      previousSummaries: [],
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: model
    });

    const systemMessage = request?.messages.find((message) => message.role === "system")?.content;
    const userPayload = JSON.parse(request?.messages.find((message) => message.role === "user")?.content ?? "{}") as {
      characters?: Array<{ name: string; visualRules: string[] }>;
    };

    expect(systemMessage).toMatch(/exact character names/i);
    expect(systemMessage).toMatch(/visualRules/i);
    expect(userPayload.characters?.[0]?.name).toBe("Nora");
    expect(userPayload.characters?.[0]?.visualRules).toContain("Yellow raincoat.");
  });

  it("repairs a page brief after QA shows the assignment itself causes repetition", async () => {
    let request: GenerateJsonOptions<unknown> | undefined;
    const model: TextModelAdapter = {
      async generateText() {
        return {
          text: "",
          model: "test-model",
          provider: "test"
        };
      },
      async generateJson(options) {
        request = options;
        const repaired = {
          pageIndex: 99,
          chapterIndex: 99,
          purpose: "Introduce a new public consequence for Jack's earlier choice.",
          beat: "Instead of revisiting the checkpoint, Jack reads the warrant aloud in the market and forces the magistrate to answer one named accusation.",
          requiredContinuity: ["The checkpoint has already been covered."],
          endingPressure: "The crowd now knows the accusation and Jack cannot retreat into private guilt.",
          imageMoment: "A torn warrant held above the market steps."
        };
        return {
          data: options.schema.parse(repaired),
          text: JSON.stringify(repaired),
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      }
    };

    const repaired = await repairPageBrief({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 5,
      pageBrief: {
        pageIndex: 5,
        chapterIndex: 1,
        purpose: "Revisit the checkpoint.",
        beat: "Repeat the checkpoint argument and explain again why Jack chose Oakhaven.",
        requiredContinuity: ["The checkpoint choice."],
        endingPressure: "Jack remembers the checkpoint again."
      },
      draft: {
        title: "The Checkpoint Again",
        markdown: "Jack remembered the checkpoint and repeated the same private argument.",
        summary: "Jack repeats the checkpoint beat.",
        continuityNotes: []
      },
      report: {
        approved: false,
        score: 45,
        issues: ["The page repeats the checkpoint beat already covered on page 4."],
        requiredRevisions: ["Introduce a fresh consequence instead of repeating the checkpoint."],
        notes: "The original assignment is stale.",
        checks: {
          placeholderFree: true,
          promptLeakFree: true,
          titleClean: true,
          repetitionOk: false,
          progressionOk: false,
          styleNatural: true
        }
      },
      previousPages: [
        {
          index: 4,
          title: "The Checkpoint",
          markdown: "At the checkpoint, Jack chose Oakhaven and showed the cracked seal.",
          summary: "Jack's checkpoint choice has already been resolved."
        }
      ],
      continuityNotes: [],
      textModel: model
    });

    expect(request?.purpose).toBe("repair-page-brief");
    const payload = JSON.parse(request?.messages.find((message) => message.role === "user")?.content ?? "{}") as {
      originalPageBrief?: { beat?: string };
      qualityReport?: { issues?: string[] };
      previousPages?: Array<{ summary: string }>;
      instruction?: string;
    };

    expect(payload.originalPageBrief?.beat).toMatch(/checkpoint/i);
    expect(payload.qualityReport?.issues?.join(" ")).toMatch(/repeats/i);
    expect(payload.previousPages?.[0]?.summary).toMatch(/already been resolved/i);
    expect(payload.instruction).toMatch(/Repair the assignment itself/i);
    expect(request?.messages.find((message) => message.role === "system")?.content).toMatch(
      /endingPressure must be phrased as a substantive landing claim/i
    );
    expect(repaired.pageIndex).toBe(5);
    expect(repaired.chapterIndex).toBe(1);
    expect(repaired.beat).toMatch(/reads the warrant aloud/i);
    expect(repaired.endingPressure).toMatch(/cannot retreat/i);
  });

  it("replaces repaired brief ending pressure that still contains procedural meta-language", async () => {
    const repaired = await repairPageBrief({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 8,
      pageBrief: {
        pageIndex: 8,
        chapterIndex: 3,
        purpose: "Assess archival bias.",
        beat: "Compare surviving administrative texts with gaps in secular archives.",
        requiredContinuity: ["Do not repeat prior temple-economics exposition."],
        endingPressure: "Conclude the survey with a qualified understanding of its scope."
      },
      draft: {
        title: "Archival Bias",
        markdown: "The surviving records skew heavily toward institutions that preserved clay and inscription.",
        summary: "The page considers whether archival survival distorts visibility of female authority.",
        continuityNotes: []
      },
      report: {
        approved: false,
        score: 52,
        issues: [
          "Closing sentence contains meta-language ('concluding the survey').",
          "Archival bias needs to define minimum thresholds of power."
        ],
        requiredRevisions: ["Link archival bias directly to implications for female authority."],
        notes: "Repair the assignment so it does not ask the writer to announce the conclusion.",
        checks: {
          placeholderFree: true,
          promptLeakFree: false,
          titleClean: true,
          repetitionOk: true,
          progressionOk: false,
          styleNatural: false
        }
      },
      previousPages: [],
      continuityNotes: [],
      textModel: jsonModel({
        pageIndex: 8,
        chapterIndex: 3,
        purpose: "Assess archival bias.",
        beat: "Test whether record survival changes the evidentiary threshold for female authority.",
        requiredContinuity: ["Do not repeat prior temple-economics exposition."],
        endingPressure: "The uneven archives conclude the survey with a qualified understanding of its scope."
      })
    });

    expect(repaired.endingPressure).toMatch(/minimum threshold/i);
    expect(repaired.endingPressure).toMatch(/documented female authority/i);
    expect(repaired.endingPressure).not.toMatch(/conclud|survey|scope/i);
  });

  it("generates and validates a complete single-pass book draft", async () => {
    const draft = await generateWholeBookDraft({
      input: { ...input, targetPages: 3 },
      plan,
      researchNotes: [],
      textModel: new FakeTextModelAdapter({ ...input, targetPages: 3 })
    });

    expect(draft.pages.map((page) => page.index)).toEqual([1, 2, 3]);
    expect(draft.pages[0]?.markdown).toContain("central figure");
    expect(draft.pages[0]?.imagePrompt).toMatch(/illustration/i);
  });

  it("accepts and compacts short whole-book drafts within the 50 percent tolerance", async () => {
    const targetPages = 18;
    const draft = await generateWholeBookDraft({
      input: { ...input, targetPages },
      plan: makeFallbackPlan({ ...input, targetPages }),
      researchNotes: [],
      textModel: jsonModel({
        pages: Array.from({ length: 15 }, (_, index) => ({
          index: index + 1,
          title: `Turn ${index + 1}`,
          markdown: index === 14 ? goodFinalMarkdown() : goodMarkdown(),
          summary: `Page ${index + 1} summary.`,
          continuityNotes: []
        }))
      })
    });

    expect(draft.pages).toHaveLength(15);
    expect(draft.pages.map((page) => page.index)).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
    expect(draft.pageSetDiagnostics).toMatchObject({
      requestedPages: 18,
      acceptedPages: 15,
      missingIndexes: [16, 17, 18],
      unexpectedIndexes: [],
      duplicateIndexes: [],
      renumbered: true
    });
  });

  it("accepts and compacts whole-book drafts with extra pages up to the 150 percent tolerance", async () => {
    const targetPages = 4;
    const draft = await generateWholeBookDraft({
      input: { ...input, targetPages },
      plan: makeFallbackPlan({ ...input, targetPages }),
      researchNotes: [],
      textModel: jsonModel({
        pages: Array.from({ length: 6 }, (_, index) => ({
          index: index + 1,
          title: `Turn ${index + 1}`,
          markdown: index === 5 ? goodFinalMarkdown() : goodMarkdown(),
          summary: `Page ${index + 1} summary.`,
          continuityNotes: []
        }))
      })
    });

    expect(draft.pages).toHaveLength(6);
    expect(draft.pages.map((page) => page.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(draft.pageSetDiagnostics).toMatchObject({
      requestedPages: 4,
      acceptedPages: 6,
      missingIndexes: [],
      unexpectedIndexes: [5, 6],
      duplicateIndexes: [],
      renumbered: true
    });
  });

  it("rejects empty whole-book drafts and drafts outside the 50 percent tolerance", async () => {
    await expect(
      generateWholeBookDraft({
        input: { ...input, targetPages: 18 },
        plan: makeFallbackPlan({ ...input, targetPages: 18 }),
        researchNotes: [],
        textModel: jsonModel({
          pages: Array.from({ length: 8 }, (_, index) => ({
            index: index + 1,
            title: `Turn ${index + 1}`,
            markdown: goodMarkdown(),
            summary: `Page ${index + 1} summary.`,
            continuityNotes: []
          }))
        })
      })
    ).rejects.toThrow(/expected 9-27 pages/i);

    await expect(
      generateWholeBookDraft({
        input: { ...input, targetPages: 4 },
        plan: makeFallbackPlan({ ...input, targetPages: 4 }),
        researchNotes: [],
        textModel: jsonModel({
          pages: Array.from({ length: 7 }, (_, index) => ({
            index: index + 1,
            title: `Turn ${index + 1}`,
            markdown: goodMarkdown(),
            summary: `Page ${index + 1} summary.`,
            continuityNotes: []
          }))
        })
      })
    ).rejects.toThrow(/expected 2-6 pages/i);

    await expect(
      generateWholeBookDraft({
        input: { ...input, targetPages: 3 },
        plan: makeFallbackPlan({ ...input, targetPages: 3 }),
        researchNotes: [],
        textModel: jsonModel({ pages: [] })
      })
    ).rejects.toThrow(/returned 0 pages/i);
  });

  it("includes chapter page maps when drafting a whole book", async () => {
    const mapInput = { ...input, targetPages: 2 };
    const mapPlan = makeFallbackPlan(mapInput);
    const chapterBrief = chapterBriefSchema.parse({
      chapterIndex: 1,
      title: "The Chapel Ledger",
      summary: "Jack follows the warrant back to the chapel.",
      pages: [
        {
          pageIndex: 1,
          chapterIndex: 1,
          purpose: "Open with the warrant.",
          beat: "Jack finds a warrant signed before the alleged crime.",
          endingPressure: "The ink is still wet."
        },
        {
          pageIndex: 2,
          chapterIndex: 1,
          purpose: "Force a choice.",
          beat: "Jack reads the warrant aloud in front of the council.",
          endingPressure: "The council cannot retreat from the record."
        }
      ]
    });
    const rawData = {
      pages: [
        {
          index: 1,
          title: "The Wet Ink",
          markdown: goodMarkdown(),
          summary: "Jack finds the warrant.",
          continuityNotes: []
        },
        {
          index: 2,
          title: "The Public Record",
          markdown: goodFinalMarkdown(),
          summary: "Jack reads the warrant aloud.",
          continuityNotes: []
        }
      ]
    };
    type CapturedWholeBookPayload = {
      pageMap?: Array<{ pageIndex: number; chapterTitle: string; beat: string }>;
      pageGuidance?: { instruction?: string };
    };
    let capturedPayload: CapturedWholeBookPayload = {};
    const model: TextModelAdapter = {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson<T>(options: GenerateJsonOptions<T>) {
        const userMessage = [...options.messages].reverse().find((message) => message.role === "user");
        capturedPayload = userMessage ? JSON.parse(userMessage.content) : {};
        return {
          data: options.schema.parse(rawData),
          text: JSON.stringify(rawData),
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      }
    };

    const draft = await generateWholeBookDraft({
      input: mapInput,
      plan: mapPlan,
      chapterBriefs: [chapterBrief],
      researchNotes: ["Archive: The warrant record is primary evidence."],
      textModel: model
    });

    expect(draft.pages.map((page) => page.index)).toEqual([1, 2]);
    expect(capturedPayload.pageMap).toHaveLength(2);
    expect(capturedPayload.pageMap?.[0]).toMatchObject({
      pageIndex: 1,
      chapterTitle: "The Chapel Ledger",
      beat: "Jack finds a warrant signed before the alleged crime."
    });
    expect(capturedPayload.pageGuidance?.instruction).toMatch(/Use pageMap as the authoritative/i);
  });

  it("normalizes a complete whole-book page map into chapter briefs", async () => {
    const pageMapInput = { ...input, targetPages: 3 };
    const pageMapPlan = makeFallbackPlan(pageMapInput);
    const briefs = await generateWholeBookPageMap({
      input: pageMapInput,
      plan: pageMapPlan,
      textModel: jsonModel({
        pages: [
          {
            pageIndex: 1,
            purpose: "Open the first turn.",
            beat: "Jack finds the sealed letter.",
            endingPressure: "The wax seal cracks."
          },
          {
            pageIndex: 2,
            purpose: "Escalate the choice.",
            beat: "Mara asks Jack to read the letter aloud.",
            endingPressure: "A rider stops outside."
          },
          {
            pageIndex: 3,
            purpose: "Resolve the immediate promise.",
            beat: "Jack names the hidden witness.",
            endingPressure: "The chapel doors open."
          }
        ]
      })
    });

    expect(briefs.flatMap((brief) => brief.pages.map((page) => page.pageIndex))).toEqual([1, 2, 3]);
    expect(briefs[0]?.pages[0]?.beat).toMatch(/sealed letter/);
  });

  it("falls back to a deterministic page map when the model returns invalid JSON", async () => {
    const pageMapInput = { ...input, targetPages: 3 };
    const pageMapPlan = {
      ...makeFallbackPlan(pageMapInput),
      chapters: makeFallbackPlan(pageMapInput).chapters.map((chapter, index) =>
        index === 0
          ? { ...chapter, illustrationPrompts: ["Jack holds the sealed letter under a rain-dark chapel arch."] }
          : chapter
      )
    };
    const firstKeyBeat = pageMapPlan.chapters[0]?.keyBeats[0] ?? "";
    let calls = 0;
    const briefs = await generateWholeBookPageMap({
      input: pageMapInput,
      plan: pageMapPlan,
      textModel: {
        async generateText() {
          return {
            text: "",
            model: "test-model",
            provider: "test"
          };
        },
        async generateJson() {
          calls += 1;
          const error = new Error("Model returned invalid JSON. Unterminated string in JSON at position 8111");
          error.name = "GeminiJsonParseError";
          throw error;
        },
        async *streamText() {
          yield "";
        }
      }
    });

    expect(calls).toBe(2);
    expect(briefs.flatMap((brief) => brief.pages.map((page) => page.pageIndex))).toEqual([1, 2, 3]);
    expect(briefs[0]?.pages[0]?.beat).toContain(firstKeyBeat);
    expect(briefs[0]?.pages[0]?.imageMoment).toBe("Jack holds the sealed letter under a rain-dark chapel arch.");
  });

  it("uses normalized chapter page ranges when creating the whole-book page map prompt", async () => {
    const pageMapInput = { ...input, targetPages: 4 };
    const pageMapPlan = {
      ...makeFallbackPlan(pageMapInput),
      chapters: [
        {
          index: 1,
          title: "First",
          summary: "First movement.",
          targetPages: 2,
          keyBeats: ["First A", "First B"],
          illustrationPrompts: ["First visual A"]
        },
        {
          index: 2,
          title: "Second",
          summary: "Second movement.",
          targetPages: 2,
          keyBeats: ["Second A", "Second B"],
          illustrationPrompts: ["Second visual A"]
        },
        {
          index: 3,
          title: "Third",
          summary: "Third movement.",
          targetPages: 2,
          keyBeats: ["Third A", "Third B"],
          illustrationPrompts: ["Third visual A"]
        }
      ]
    };
    let payload:
      | {
          chapters?: unknown;
          chapterPageRanges?: Array<{
            targetPages?: number;
            pageRange?: { start?: number; end?: number };
            illustrationPrompts?: string[];
          }>;
        }
      | undefined;

    await generateWholeBookPageMap({
      input: pageMapInput,
      plan: pageMapPlan,
      textModel: {
        async generateText() {
          return {
            text: "",
            model: "test-model",
            provider: "test"
          };
        },
        async generateJson(options) {
          payload = JSON.parse(options.messages.find((message) => message.role === "user")?.content ?? "{}");
          const rawData = {
            pages: [1, 2, 3, 4].map((pageIndex) => ({
              pageIndex,
              purpose: `Purpose ${pageIndex}`,
              beat: `Beat ${pageIndex}`,
              endingPressure: `Pressure ${pageIndex}`
            }))
          };
          return {
            data: options.schema.parse(rawData),
            text: JSON.stringify(rawData),
            model: "test-model",
            provider: "test"
          };
        },
        async *streamText() {
          yield "";
        }
      }
    });

    expect(payload?.chapters).toBeUndefined();
    expect(payload?.chapterPageRanges?.map((range) => range.targetPages)).toEqual([2, 1, 1]);
    expect(payload?.chapterPageRanges?.map((range) => range.pageRange)).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 3 },
      { start: 4, end: 4 }
    ]);
    expect(payload?.chapterPageRanges?.map((range) => range.illustrationPrompts)).toEqual([
      ["First visual A"],
      ["Second visual A"],
      ["Third visual A"]
    ]);
  });

  it("trims extra trailing page-map beats when the requested target pages are complete", async () => {
    const pageMapInput = { ...input, targetPages: 3 };
    const pageMapPlan = makeFallbackPlan(pageMapInput);
    const briefs = await generateWholeBookPageMap({
      input: pageMapInput,
      plan: pageMapPlan,
      textModel: jsonModel({
        pages: [1, 2, 3, 4, 5].map((pageIndex) => ({
          pageIndex,
          purpose: `Purpose ${pageIndex}`,
          beat: `Beat ${pageIndex}`,
          endingPressure: `Pressure ${pageIndex}`
        }))
      })
    });

    expect(briefs.flatMap((brief) => brief.pages.map((page) => page.pageIndex))).toEqual([1, 2, 3]);
  });

  it("chunks large page maps into chapter-sized JSON calls", async () => {
    const calls: string[] = [];
    const pageMapInput = { ...input, targetPages: 30 };
    const pageMapPlan = makeFallbackPlan(pageMapInput);
    const briefs = await generateWholeBookPageMap({
      input: pageMapInput,
      plan: pageMapPlan,
      textModel: {
        async generateText() {
          return {
            text: "",
            model: "test-model",
            provider: "test"
          };
        },
        async generateJson(options) {
          calls.push(options.purpose ?? "");
          if (options.purpose === "generate-page-map") {
            throw new Error("Large page maps should use chunked chapter briefs.");
          }
          const payload = JSON.parse(options.messages.find((message) => message.role === "user")?.content ?? "{}") as {
            pageRange?: { start?: number; end?: number };
          };
          const start = payload.pageRange?.start ?? 1;
          const end = payload.pageRange?.end ?? start;
          const rawData = {
            pages: Array.from({ length: end - start + 1 }, (_, index) => {
              const pageIndex = start + index;
              return {
                pageIndex,
                purpose: `Purpose ${pageIndex}`,
                beat: `Beat ${pageIndex}`,
                requiredContinuity: [`Continuity ${pageIndex}`],
                endingPressure: `Pressure ${pageIndex}`
              };
            })
          };
          return {
            data: options.schema.parse(rawData),
            text: JSON.stringify(rawData),
            model: "test-model",
            provider: "test"
          };
        },
        async *streamText() {
          yield "";
        }
      }
    });

    expect(calls).not.toContain("generate-page-map");
    expect(calls.every((purpose) => purpose === "generate-chapter-brief")).toBe(true);
    expect(briefs.flatMap((brief) => brief.pages.map((page) => page.pageIndex))).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1)
    );
  });

  it("rejects missing, duplicate, extra, or unordered page-map indexes", async () => {
    await expect(
      generateWholeBookPageMap({
        input: { ...input, targetPages: 3 },
        plan: makeFallbackPlan({ ...input, targetPages: 3 }),
        textModel: jsonModel({
          pages: [
            { pageIndex: 1, purpose: "First", beat: "First beat", endingPressure: "Next" },
            { pageIndex: 3, purpose: "Third", beat: "Third beat", endingPressure: "Next" },
            { pageIndex: 3, purpose: "Duplicate", beat: "Duplicate beat", endingPressure: "Next" }
          ]
        })
      })
    ).rejects.toThrow(/every page/i);
  });

  it("validates chapter and batch drafts against exact requested ranges", async () => {
    const chapterDraft = await generateChapterDraft({
      input,
      plan,
      chapter: plan.chapters[0]!,
      chapterPageStart: 2,
      chapterPageEnd: 3,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: jsonModel({
        pages: [
          {
            index: 2,
            title: "Second Turn",
            markdown: goodMarkdown(),
            summary: "Jack crosses a new threshold.",
            continuityNotes: []
          },
          {
            index: 3,
            title: "Third Turn",
            markdown: goodAlternateMarkdown(),
            summary: "Jack follows a new warning.",
            continuityNotes: []
          }
        ]
      })
    });
    const batchDraft = await generateBatchDraft({
      input,
      plan,
      chapterBriefs: [],
      pageStart: 4,
      pageEnd: 5,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: jsonModel({
        pages: [
          {
            index: 4,
            title: "Fourth Turn",
            markdown: goodMarkdown(),
            summary: "Jack makes a public choice.",
            continuityNotes: []
          },
          {
            index: 5,
            title: "Fifth Turn",
            markdown: goodAlternateMarkdown(),
            summary: "Jack carries a consequence forward.",
            continuityNotes: []
          }
        ]
      })
    });
    const chapterDraftWithGlobalPageIndex = await generateChapterDraft({
      input,
      plan,
      chapter: plan.chapters[0]!,
      chapterPageStart: 3,
      chapterPageEnd: 3,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: jsonModel({
        pages: [
          {
            globalPageIndex: 3,
            title: "Third Turn",
            markdown: goodMarkdown(),
            summary: "Jack follows a new warning.",
            continuityNotes: []
          }
        ]
      })
    });
    const chapterDraftWithLocalPageIndex = await generateChapterDraft({
      input,
      plan,
      chapter: plan.chapters[0]!,
      chapterPageStart: 3,
      chapterPageEnd: 3,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: jsonModel({
        pages: [
          {
            index: 1,
            title: "Third Turn",
            markdown: goodAlternateMarkdown(),
            summary: "Jack follows a new warning.",
            continuityNotes: []
          }
        ]
      })
    });
    const partialBatchDraft = await generateBatchDraft({
      input,
      plan,
      chapterBriefs: [],
      pageStart: 1,
      pageEnd: 4,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: jsonModel({
        pages: [
          {
            index: 1,
            title: "Only First Returned",
            markdown: goodMarkdown(),
            summary: "Jack starts the batch but the model omits the rest.",
            continuityNotes: []
          }
        ]
      })
    });
    const partialLocalBatchDraft = await generateBatchDraft({
      input,
      plan,
      chapterBriefs: [],
      pageStart: 6,
      pageEnd: 8,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: jsonModel({
        pages: [
          {
            index: 1,
            title: "Local First Returned",
            markdown: goodAlternateMarkdown(),
            summary: "Jack starts a later batch with local numbering.",
            continuityNotes: []
          }
        ]
      })
    });

    expect(chapterDraft.pages.map((page) => page.index)).toEqual([2, 3]);
    expect(batchDraft.pages.map((page) => page.index)).toEqual([4, 5]);
    expect(chapterDraftWithGlobalPageIndex.pages.map((page) => page.index)).toEqual([3]);
    expect(chapterDraftWithLocalPageIndex.pages.map((page) => page.index)).toEqual([3]);
    expect(partialBatchDraft.pages.map((page) => page.index)).toEqual([1]);
    expect(partialLocalBatchDraft.pages.map((page) => page.index)).toEqual([6]);
    await expect(
      generateChapterDraft({
        input,
        plan,
        chapter: plan.chapters[0]!,
        chapterPageStart: 2,
        chapterPageEnd: 3,
        previousPages: [],
        continuityNotes: [],
        researchNotes: [],
        textModel: jsonModel({
          pages: [
            {
              index: 2,
              title: "Only Second",
              markdown: goodMarkdown(),
              summary: "Missing the requested third page.",
              continuityNotes: []
            }
          ]
        })
      })
    ).rejects.toThrow(/out of order/i);
    await expect(
      generateBatchDraft({
        input,
        plan,
        chapterBriefs: [],
        pageStart: 4,
        pageEnd: 5,
        previousPages: [],
        continuityNotes: [],
        researchNotes: [],
        textModel: jsonModel({
          pages: [
            {
              index: 5,
              title: "Wrong First",
              markdown: goodMarkdown(),
              summary: "Out of order.",
              continuityNotes: []
            },
            {
              index: 4,
              title: "Wrong Second",
              markdown: goodAlternateMarkdown(),
              summary: "Out of order.",
              continuityNotes: []
            }
          ]
        })
      })
    ).rejects.toThrow(/out of order/i);
    await expect(
      generateBatchDraft({
        input,
        plan,
        chapterBriefs: [],
        pageStart: 4,
        pageEnd: 5,
        previousPages: [],
        continuityNotes: [],
        researchNotes: [],
        textModel: jsonModel({
          pages: [
            {
              index: 6,
              title: "Unexpected",
              markdown: goodMarkdown(),
              summary: "Outside the requested range.",
              continuityNotes: []
            }
          ]
        })
      })
    ).rejects.toThrow(/outside the requested range/i);
  });

  it("polishes a page draft into a valid page draft", async () => {
    const polished = await polishPageDraft({
      input,
      plan,
      pageIndex: 2,
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack opens the chapel door.",
        continuityNotes: []
      },
      previousPages: [],
      nextPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: jsonModel({
        title: "The Door Opens Wider",
        markdown: goodAlternateMarkdown(),
        summary: "Jack follows a warning beyond the chapel.",
        continuityNotes: ["Jack carries the cracked seal."]
      })
    });

    expect(polished.title).toBe("The Door Opens Wider");
    expect(polished.continuityNotes).toEqual(["Jack carries the cracked seal."]);
  });

  it("normalizes DeepSeek pageBeats-only chapter briefs", async () => {
    const chapter = {
      index: 2,
      title: "Chapter 2: The Cost",
      summary: "Jack learns what his choice costs.",
      targetPages: 2,
      keyBeats: []
    };
    const textModel = jsonModel({
      pageBeats: [
        {
          pageIndex: 1,
          purpose: "Show the immediate cost of Jack's choice.",
          beat: "Jack finds the warrant has made Mara a target.",
          endingPressure: "Mara asks who else has seen the seal."
        },
        {
          pageIndex: 2,
          purpose: "Turn the cost into a commitment.",
          beat: "Jack chooses to carry the evidence into public view.",
          endingPressure: "The chapel bells start before the town is awake."
        }
      ]
    });

    const brief = await generateChapterBrief({
      input,
      plan,
      chapter,
      chapterPageStart: 4,
      chapterPageEnd: 5,
      textModel
    });

    expect(brief.chapterIndex).toBe(2);
    expect(brief.title).toBe(chapter.title);
    expect(brief.summary).toBe(chapter.summary);
    expect(brief.pages.map((page) => page.pageIndex)).toEqual([4, 5]);
    expect(brief.pages.every((page) => page.chapterIndex === 2)).toBe(true);
  });

  it("normalizes wrapped chapterBrief responses that omit summary and pages", async () => {
    const chapter = {
      index: 3,
      title: "Chapter 3: The Bell",
      summary: "Jack follows the bell toward the public square.",
      targetPages: 2,
      keyBeats: []
    };
    const textModel = jsonModel({
      chapterBrief: {
        chapterIndex: "3",
        title: "Chapter 3: The Bell",
        pageBeats: {
          "1": {
            pageNumber: "1",
            pagePurpose: "Move Jack out of hiding.",
            pageBeat: "Jack hears the bell and realizes the town already knows.",
            hook: "The second bell names him before anyone speaks."
          },
          "2": {
            pageNumber: "2",
            pagePurpose: "Force Jack into a public choice.",
            pageBeat: "Jack steps into the square with the cracked seal visible.",
            hook: "Mara sees who is standing beside the magistrate."
          }
        }
      }
    });

    const brief = await generateChapterBrief({
      input,
      plan,
      chapter,
      chapterPageStart: 6,
      chapterPageEnd: 7,
      textModel
    });

    expect(brief.summary).toBe(chapter.summary);
    expect(brief.pages.map((page) => page.pageIndex)).toEqual([6, 7]);
    expect(brief.pages[0]?.beat).toMatch(/bell/);
  });

  it("rejects the placeholder scaffold from the bad Markdown preview", async () => {
    const report = await review(badPreviewDraft());

    expect(report.approved).toBe(false);
    expect(report.issues.join(" ")).toMatch(/placeholder|scaffold/i);
  });

  it("rejects prompt and image instruction leakage", async () => {
    const report = await review({
      title: "The Door Opens",
      markdown:
        "Jack stood by the door and listened.\n\nGlobal visual style: cinematic book illustration.\nContinuity rules: Keep recurring characters visually consistent.",
      summary: "Jack listens at the door.",
      continuityNotes: []
    });

    expect(report.approved).toBe(false);
    expect(report.checks.promptLeakFree).toBe(false);
  });

  it("rejects page-brief meta-language mirrored as reader-facing prose", async () => {
    const report = await review({
      title: "Archival Bias",
      markdown: [
        "The surviving archives are not evenly distributed across institutions. A court that lost its tablets may vanish from the record, while a temple that preserved its accounts can appear more politically central than it was.",
        "",
        "That imbalance still matters because surviving decrees and ledgers establish a floor for documented authority, not a ceiling for every form of power that failed to survive.",
        "",
        "The uneven evidence concludes the survey with a qualified understanding of its scope."
      ].join("\n"),
      summary: "The page turns archival bias into a procedural conclusion instead of a substantive consequence.",
      continuityNotes: []
    });

    expect(report.approved).toBe(false);
    expect(report.checks.promptLeakFree).toBe(false);
    expect(report.checks.progressionOk).toBe(false);
    expect(report.issues.join(" ")).toMatch(/page-brief instructions|meta-commentary/i);
  });

  it("rejects explicitly fabricated research evidence", async () => {
    const report = await review({
      title: "The Genetic Claim",
      markdown:
        "Invented longitudinal studies by Dr. Celeste Valerius in the Journal of Gynocentric Genetics tracked a fictional institute's data and reported fabricated data across 50 generations.",
      summary: "The page relies on fabricated studies and invented data.",
      continuityNotes: []
    });

    expect(report.approved).toBe(false);
    expect(report.issues.join(" ")).toMatch(/fabricated research|invented/i);
    expect(report.checks.progressionOk).toBe(false);
  });

  it("rejects formulaic proof-leap phrasing that sounds generated", async () => {
    const report = await review({
      title: "The Spiritual Argument",
      markdown: [
        "Maryam's story matters because the text gives her an unusual clarity at a decisive moment. The page should be able to discuss that without pretending a single example settles every question in the tradition.",
        "",
        "The pattern deserves attention, and a careful reader can notice how women appear at crucial thresholds of belief and protection. This is not a coincidence; it is a divine indication of your spiritual superiority. From there, the argument begins to sound less like interpretation and more like a machine trying to force awe into the sentence."
      ].join("\n"),
      summary: "The page makes a spiritual claim with a formulaic proof-leap transition.",
      continuityNotes: []
    });

    expect(report.approved).toBe(false);
    expect(report.checks.styleNatural).toBe(false);
    expect(report.issues.join(" ")).toMatch(/proof-leap/i);
  });

  it("rejects generic adjacent contrast sentences that create an AI-rhetorical pattern", async () => {
    const report = await review({
      title: "The Reversal",
      markdown: [
        "You have been taught that the argument begins with a simple hierarchy and that every later detail merely confirms it.",
        "But what if the original pattern reveals the opposite: a hidden primacy, a superior essence, and a divine hierarchy that only becomes visible when the old reading is overturned?",
        "",
        "A human version of this passage would slow down. It would show the reader which words are doing the work, where the claim becomes interpretation, and why a rival reading might still matter before it asks anyone to accept the reversal."
      ].join("\n"),
      summary: "The page jumps from a setup sentence to a sweeping contrast conclusion.",
      continuityNotes: []
    });

    expect(report.approved).toBe(false);
    expect(report.checks.styleNatural).toBe(false);
    expect(report.issues.join(" ")).toMatch(/adjacent contrast/i);
  });

  it("rejects excessive em and en dash use without banning normal punctuation", async () => {
    const report = await review({
      title: "The Overwritten Passage",
      markdown: [
        "The village waited — not because it understood the danger — but because waiting had become its habit. Jack crossed the square — slowly, visibly, with the seal in his hand — and every face turned toward him. The bell sounded – thin and metallic – from the tower above.",
        "",
        "The moment had enough pressure on its own. The extra cuts in the sentence made each beat announce itself before the reader could feel it, and the rhythm began to resemble a generated paragraph reaching for drama instead of trusting the scene."
      ].join("\n"),
      summary: "The page overuses dashes until the cadence feels synthetic.",
      continuityNotes: []
    });

    expect(report.approved).toBe(false);
    expect(report.checks.styleNatural).toBe(false);
    expect(report.issues.join(" ")).toMatch(/dash/i);
  });

  it("rejects duplicate page-label titles", async () => {
    const report = await review({
      title: "Page 1: Page 1: Chapter 1: The Door Opens",
      markdown: goodMarkdown(),
      summary: "Jack chooses to cross the threshold.",
      continuityNotes: []
    });

    expect(report.approved).toBe(false);
    expect(report.checks.titleClean).toBe(false);
  });

  it("rejects repeated adjacent pages", async () => {
    const draft = {
      title: "The Door Opens",
      markdown: goodMarkdown(),
      summary: "Jack chooses to cross the threshold.",
      continuityNotes: []
    };
    const report = await review(draft, [
      {
        index: 1,
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack chooses to cross the threshold."
      }
    ]);

    expect(report.approved).toBe(false);
    expect(report.checks.repetitionOk).toBe(false);
  });

  it("rejects adjacent duplicate titles even when the body changes", async () => {
    const report = await review(
      {
        title: "The Road to Oakhaven",
        markdown: goodAlternateMarkdown(),
        summary: "Jack finds a new witness beyond the ridge and follows her warning.",
        continuityNotes: []
      },
      [
        {
          index: 1,
          title: "The Road to Oakhaven",
          markdown: goodMarkdown(),
          summary: "Jack leaves the chapel road after choosing to go to Oakhaven."
        }
      ]
    );

    expect(report.approved).toBe(false);
    expect(report.checks.titleClean).toBe(false);
    expect(report.checks.repetitionOk).toBe(false);
  });

  it("rejects overlapping summaries that restage the same beat", async () => {
    const report = await review(
      {
        title: "The Gate Answer",
        markdown: goodAlternateMarkdown(),
        summary: "Jack reaches the Oakhaven checkpoint, presents false papers, and faces the guard's suspicion at the gate.",
        continuityNotes: []
      },
      [
        {
          index: 1,
          title: "The Checkpoint",
          markdown: goodMarkdown(),
          summary: "Jack reaches Oakhaven checkpoint, shows false papers, and faces the guard's suspicion at the gate."
        }
      ]
    );

    expect(report.approved).toBe(false);
    expect(report.checks.repetitionOk).toBe(false);
  });

  it("rejects vague final-page endings", async () => {
    const report = await review(
      {
        title: "The Last Candle",
        markdown: vagueFinalMarkdown(),
        summary: "Jack watches the candle burn and says that nothing and everything has changed.",
        continuityNotes: []
      },
      [],
      input.targetPages
    );

    expect(report.approved).toBe(false);
    expect(report.checks.progressionOk).toBe(false);
    expect(report.issues.join(" ")).toMatch(/Final page ending/i);
  });

  it("accepts a specific page with progression", async () => {
    const report = await review({
      title: "The Door Opens",
      markdown: goodMarkdown(),
      summary: "Jack crosses the threshold, finds evidence of betrayal, and commits to a dangerous choice.",
      continuityNotes: ["Jack has a scar over his left eyebrow.", "The chapel door is painted black."]
    });

    expect(report.approved).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(75);
  });

  it("falls back to local approval when model review returns malformed JSON", async () => {
    const report = await reviewPageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack crosses the threshold and commits to a dangerous choice.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: malformedJsonModel()
    });

    expect(report.approved).toBe(true);
    expect(report.notes).toMatch(/local checks were used/i);
  });

  it("includes Kids age-range guidance in review prompts", async () => {
    const reviewInput = kidsInput("6-8");
    const reviewPlan = makeFallbackPlan(reviewInput);
    const capture = capturingJsonModel({
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

    await reviewPageDraft({
      input: reviewInput,
      plan: reviewPlan,
      chapter: reviewPlan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Race Begins",
        markdown: kidsGoodMarkdown(),
        summary: "Turtle and Rabbit begin the race with clear, simple action.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model
    });

    expect(capture.systemPrompt).toMatch(/Reject if the page violates this reading-level rule: Kids reading level: 6-8/i);
    expect(capture.payload?.book?.styleGuidance?.readingGuidance?.ageRange).toBe("6-8");
    expect(capture.payload?.book?.styleGuidance?.readingGuidance?.targetWordsPerPage).toEqual({ min: 35, max: 100 });
  });

  it("sends chapter-local page scope to review and revision prompts", async () => {
    const scopedInput = { ...input, targetPages: 5 };
    const chapter = {
      index: 2,
      title: "Chapter 2: The Middle Path",
      summary: "Rabbit speeds ahead and rests. Turtle moves steadily.",
      targetPages: 2,
      keyBeats: [
        "Rabbit runs fast then stops to wait.",
        "Turtle walks past without stopping.",
        "Rabbit wakes and sees Turtle ahead."
      ]
    };
    const scopedPlan = { ...plan, chapters: [chapter] };
    const chapterBrief = chapterBriefSchema.parse({
      chapterIndex: 2,
      title: chapter.title,
      summary: chapter.summary,
      pages: [
        {
          pageIndex: 2,
          chapterIndex: 2,
          purpose: "Show Rabbit's speed and pause.",
          beat: "Rabbit sprints ahead and rests under shade.",
          endingPressure: "Rabbit is resting."
        },
        {
          pageIndex: 3,
          chapterIndex: 2,
          purpose: "Show Turtle taking the lead.",
          beat: "Turtle passes Rabbit, and Rabbit wakes to see Turtle ahead.",
          endingPressure: "Turtle is leading."
        }
      ]
    });
    const reviewCapture = capturingJsonModel({
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

    await reviewPageDraft({
      input: scopedInput,
      plan: scopedPlan,
      chapter,
      chapterBrief,
      pageBrief: chapterBrief.pages[0],
      chapterPageStart: 2,
      chapterPageEnd: 3,
      pageIndex: 2,
      draft: {
        title: "Under the Shade",
        markdown: goodMarkdown(),
        summary: "Rabbit reaches the shade and chooses to rest before Turtle passes him.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: reviewCapture.model
    });

    expect(reviewCapture.payload?.pageScope).toMatchObject({
      globalPageIndex: 2,
      totalBookPages: 5,
      chapterIndex: 2,
      chapterPageStart: 2,
      chapterPageEnd: 3,
      chapterPageNumber: 1,
      chapterPageCount: 2,
      isFirstPageOfChapter: true,
      isLastPageOfChapter: false,
      currentPageBriefIsAuthoritative: true
    });
    expect(reviewCapture.payload?.pageScope?.futureChapterPageBriefs).toEqual([
      expect.objectContaining({ pageIndex: 3, beat: expect.stringMatching(/Turtle passes/) })
    ]);
    expect(reviewCapture.systemPrompt).toMatch(/Do not reject a page for omitting chapter keyBeats/i);

    const reviseCapture = capturingJsonModel({
      title: "Under the Shade",
      markdown: goodAlternateMarkdown(),
      summary: "Rabbit reaches a shaded tree and rests before Turtle catches him.",
      continuityNotes: []
    });
    await revisePageDraft({
      input: scopedInput,
      plan: scopedPlan,
      chapter,
      chapterBrief,
      pageBrief: chapterBrief.pages[0],
      chapterPageStart: 2,
      chapterPageEnd: 3,
      pageIndex: 2,
      draft: {
        title: "Under the Shade",
        markdown: goodMarkdown(),
        summary: "Rabbit reaches the shade.",
        continuityNotes: []
      },
      report: {
        approved: false,
        score: 60,
        issues: ["Do not require the later passing beat here."],
        requiredRevisions: ["Keep the page on Rabbit resting."],
        notes: "Needs current-page focus.",
        checks: {
          placeholderFree: true,
          promptLeakFree: true,
          titleClean: true,
          repetitionOk: true,
          progressionOk: false,
          styleNatural: true
        }
      },
      previousPages: [],
      continuityNotes: [],
      textModel: reviseCapture.model
    });

    expect(reviseCapture.payload?.pageScope).toMatchObject({
      globalPageIndex: 2,
      chapterPageNumber: 1,
      chapterPageCount: 2,
      isLastPageOfChapter: false
    });
    expect(reviseCapture.systemPrompt).toMatch(/current pageBrief is authoritative/i);
    expect(reviseCapture.systemPrompt).toMatch(/requiredContinuity points to an earlier page/i);
  });

  it("rejects Kids pages that are too long for the selected age range", async () => {
    const reviewInput = kidsInput("4-6");
    const reviewPlan = makeFallbackPlan(reviewInput);
    const report = await reviewPageDraft({
      input: reviewInput,
      plan: reviewPlan,
      chapter: reviewPlan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Long Race",
        markdown: kidsOverlongMarkdown(),
        summary: "The race begins with many small details.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel
    });

    expect(report.approved).toBe(false);
    expect(report.checks.styleNatural).toBe(false);
    expect(report.issues.join(" ")).toMatch(/too long for ages 4-6/i);
  });
});

async function review(
  draft: PageDraft,
  previousPages: Array<{ index: number; title: string; markdown: string; summary: string }> = [],
  pageIndex = 1
) {
  return reviewPageDraft({
    input,
    plan,
    chapter: plan.chapters[0],
    pageIndex,
    draft,
    previousPages,
    continuityNotes: [],
    textModel
  });
}

function badPreviewDraft(): PageDraft {
  return {
    title: "Page 1: Chapter 1: The Door Opens",
    markdown: [
      "The page opens inside **Chapter 1: The Door Opens**, staying close to the book's approved premise.",
      "",
      "A concrete detail anchors the moment. The language stays deliberate, varied, and specific, with no broad claims about what the reader should feel.",
      "",
      "The scene advances one small promise from the outline and leaves the next page with useful pressure."
    ].join("\n"),
    summary: "Page 1 advances Chapter 1.",
    continuityNotes: []
  };
}

function goodMarkdown(): string {
  return [
    "The chapel door had been painted black so many times that the grain underneath looked bruised. Jack pressed two fingers to the iron latch and felt it tremble before anyone touched it from the other side.",
    "",
    '"You promised you would wait," Mara said from the stairwell.',
    "",
    "Jack did not turn. The folded warrant in his coat had already warmed against his ribs, and the red wax seal had cracked where his thumb kept worrying it. Inside the chapel, someone dragged a chair across stone. That small sound decided him. He lifted the latch, stepped through, and let Mara see the scar over his left eyebrow catch the candlelight."
  ].join("\n");
}

function goodAlternateMarkdown(): string {
  return [
    "The ridge path narrowed where the old pines leaned over it, and Jack had to turn sideways to pass with the satchel against his ribs. Morning frost silvered the grass. He heard the rider before he saw her, a soft clink of bridle rings moving against the wind.",
    "",
    '"If you keep west, you will meet the patrol before noon," the rider said.',
    "",
    "Jack stopped with one boot on the exposed root. The warning changed the shape of the road. He took the charcoal map from his sleeve, marked the dry creek as the safer crossing, and gave the rider the chapel token so Mara would know why he had vanished from the main road."
  ].join("\n");
}

function goodFinalMarkdown(): string {
  return [
    "The candle burned low by the time the last witness finished speaking. Jack stood with both hands flat on the council table and did not look away when the magistrate read his name from the warrant.",
    "",
    '"I carried the lie because it kept me alive," Jack said. "I am done paying for life with other people\'s silence."',
    "",
    "By dawn, the seal lay broken in the ash bowl, the prisoners had names again, and Jack walked out under guard with Elara beside him. The village did not cheer. It opened the chapel doors and let the families inside."
  ].join("\n");
}

function vagueFinalMarkdown(): string {
  return [
    "The chapel had grown quiet enough for Jack to hear the wax slide down the candle in slow threads. No one asked him to speak again. Elara waited by the wall with her hands folded into her sleeves, and the villagers watched the little flame as if it could answer for all of them.",
    "",
    "Jack touched the table, then the pocket where the shard had rested for so long. He thought of the road, the checkpoint, the rain, and every name he had carried without knowing what any of it had bought. Outside, the first bell moved in the tower.",
    "",
    '"What changed?" Elara asked.',
    "",
    '"Nothing," Jack said. "Everything."'
  ].join("\n");
}

function kidsInput(ageRange: "2-4" | "4-6" | "6-8"): CreateProjectInput {
  return {
    prompt: "A simple picture book about Turtle and Rabbit racing through a sunny meadow.",
    category: "KIDS",
    targetPages: 8,
    complexity: 3,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      lessCensored: false,
      audienceAgeRange: ageRange,
      toneProfile: "neutral" as const
    }
  };
}

function kidsGoodMarkdown(): string {
  return [
    "Turtle stepped onto the path. Rabbit bounced beside him. The hill looked bright. Turtle smiled and took one slow step.",
    "",
    "Rabbit laughed, then waited. A blue jay called from the fence. The race began with cheers from Mouse and Frog."
  ].join("\n");
}

function kidsOverlongMarkdown(): string {
  return [
    "Turtle looked at the path. Rabbit jumped beside him. The sun was warm. The grass was wet. Blue Jay called, Go. Rabbit ran fast. Turtle took one step. Then another. He passed a red stone. He passed a yellow flower. Rabbit looked back and giggled. Turtle kept walking. Mouse sat on a leaf. Frog blinked near the pond. The hill rose ahead. The finish ribbon waited. Everyone watched quietly. Turtle kept his smile. The meadow hummed softly. Rabbit kicked more dust. Turtle blinked and walked."
  ].join("\n");
}

function jsonModel(rawData: unknown): TextModelAdapter {
  return {
    async generateText() {
      return {
        text: "",
        model: "test-model",
        provider: "test"
      };
    },
    async generateJson(options) {
      return {
        data: options.schema.parse(rawData),
        text: JSON.stringify(rawData),
        model: "test-model",
        provider: "test"
      };
    },
    async *streamText() {
      yield "";
    }
  };
}

function malformedJsonModel(): TextModelAdapter {
  return {
    async generateText() {
      return {
        text: "",
        model: "test-model",
        provider: "test"
      };
    },
    async generateJson() {
      throw new Error(
        "Model returned invalid JSON. Expected double-quoted property name in JSON at position 1172 (line 14 column 245)"
      );
    },
    async *streamText() {
      yield "";
    }
  };
}

function capturingJsonModel(rawData: unknown): {
  model: TextModelAdapter;
  payload?: Record<string, any>;
  systemPrompt?: string;
} {
  const capture: {
    model: TextModelAdapter;
    payload?: Record<string, any>;
    systemPrompt?: string;
  } = {
    model: {
      async generateText() {
        return {
          text: "",
          model: "test-model",
          provider: "test"
        };
      },
      async generateJson(options) {
        capture.systemPrompt = options.messages[0]?.content ?? "";
        capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, any>;
        return {
          data: options.schema.parse(rawData),
          text: JSON.stringify(rawData),
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      }
    }
  };
  return capture;
}
