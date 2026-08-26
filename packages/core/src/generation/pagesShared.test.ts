import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { range } from "../collections.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import {
  generateBatchDraft,
  generateChapterDraft,
  generateChapterBrief,
  generatePageDraft,
  generateWholeBookDraft,
  polishPageDraft,
  reviewPageDraft,
  revisePageDraft,
  runFinalBookQa
} from "./pages.js";
import {
  OPENING_QUALITY_RULE_MARKER,
  missingStyleLockIndexes,
  pagesForStyleExcerpts,
  pinStyleExcerpts,
  sampleExcerptsFromInput,
  sanitizePageBriefForCitationContract,
  type PriorPageContext
} from "./pagesShared.js";

function page(index: number, voice: string): PriorPageContext {
  return {
    index,
    title: `Page ${index}`,
    markdown: `${voice} ${"prose ".repeat(20)}`,
    summary: `Summary ${index}`
  };
}

describe("pinStyleExcerpts", () => {
  it("excerpts the two lowest-index pages even when they are not first in the array", () => {
    const excerpts = pinStyleExcerpts([
      page(17, "seventeen-window"),
      page(18, "eighteen-window"),
      page(1, "opening-voice"),
      page(2, "second-voice")
    ]);
    expect(excerpts).toHaveLength(2);
    expect(excerpts[0]).toContain("opening-voice");
    expect(excerpts[1]).toContain("second-voice");
    expect(excerpts.join(" ")).not.toMatch(/seventeen-window|eighteen-window/);
  });

  it("cannot invent pages 1 and 2 when only later pages are present", () => {
    const excerpts = pinStyleExcerpts([page(17, "seventeen-window"), page(18, "eighteen-window")]);
    expect(excerpts).toHaveLength(2);
    expect(excerpts[0]).toContain("seventeen-window");
    expect(excerpts[1]).toContain("eighteen-window");
  });
});

describe("sampleExcerptsFromInput", () => {
  const baseInput = {
    prompt: "A story.",
    category: "STORY",
    targetPages: 8,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral"
    }
  } as CreateProjectInput;

  it("returns mediaSettings.mobile.import.styleProfile.sampleExcerpts", () => {
    const excerpts = sampleExcerptsFromInput({
      ...baseInput,
      mediaSettings: {
        ...baseInput.mediaSettings,
        mobile: {
          import: {
            styleProfile: {
              sampleExcerpts: ["Opening cadence.", "Second voice.", ""]
            }
          }
        }
      }
    } as CreateProjectInput);
    expect(excerpts).toEqual(["Opening cadence.", "Second voice."]);
  });

  it("yields an empty list when mobile is missing", () => {
    expect(sampleExcerptsFromInput(baseInput)).toEqual([]);
  });
});

describe("style lock helpers", () => {
  it("names indexes 1 and 2 as missing from a page-21 recency window", () => {
    const recency = Array.from({ length: 18 }, (_, offset) => ({ index: offset + 3 }));
    expect(missingStyleLockIndexes(recency, 21)).toEqual([1, 2]);
  });

  it("names only index 1 as missing when the window still holds page 2", () => {
    const recency = Array.from({ length: 18 }, (_, offset) => ({ index: offset + 2 }));
    expect(missingStyleLockIndexes(recency, 20)).toEqual([1]);
  });

  it("concatenates loaded pages 1–2 for excerpts without replacing the recency window", () => {
    const recency = [page(17, "seventeen-window"), page(18, "eighteen-window")];
    const lock = [page(1, "opening-voice"), page(2, "second-voice")];
    const merged = pagesForStyleExcerpts(recency, lock);
    expect(merged.map((entry) => entry.index)).toEqual([1, 2, 17, 18]);
    expect(recency.map((entry) => entry.index)).toEqual([17, 18]);
    expect(pinStyleExcerpts(merged)[0]).toContain("opening-voice");
    expect(pinStyleExcerpts(merged)[1]).toContain("second-voice");
  });
});

describe("chapter and batch draft style excerpts", () => {
  const input = {
    prompt: "A story.",
    category: "STORY",
    targetPages: 10,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral"
    }
  } as CreateProjectInput;
  const plan = makeFallbackPlan(input);
  const excerpts = ["Opening voice.", "Second page voice."];
  const markdown =
    "The chapel door had been painted black so many times that the grain underneath looked bruised. Jack pressed two fingers to the iron latch and felt it tremble.";

  function capturingModel(pages: Array<{ index: number; title: string; markdown: string; summary: string; continuityNotes: string[] }>) {
    const capture: { payload?: Record<string, unknown>; model: TextModelAdapter } = {
      model: {
        async generateText() {
          return { text: "", model: "test-model", provider: "test" };
        },
        async generateJson(options) {
          capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, unknown>;
          return { data: options.schema.parse({ pages }), text: "{}", model: "test-model", provider: "test" };
        },
        async *streamText() {
          yield "";
        },
        generateWithTools: unsupportedGenerateWithTools
      }
    };
    return capture;
  }

  it("includes the excerpts in the user payload only when they are nonempty", async () => {
    const withExcerpts = capturingModel([
      { index: 2, title: "Turn", markdown, summary: "Jack moves.", continuityNotes: [] }
    ]);
    await generateChapterDraft({
      input,
      plan,
      chapter: plan.chapters[0]!,
      chapterPageStart: 2,
      chapterPageEnd: 2,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      styleExcerpts: excerpts,
      textModel: withExcerpts.model
    });
    expect(withExcerpts.payload?.styleExcerpts).toEqual(excerpts);

    const omitted = capturingModel([
      { index: 2, title: "Turn", markdown, summary: "Jack moves.", continuityNotes: [] }
    ]);
    await generateChapterDraft({
      input,
      plan,
      chapter: plan.chapters[0]!,
      chapterPageStart: 2,
      chapterPageEnd: 2,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: omitted.model
    });
    expect(omitted.payload).not.toHaveProperty("styleExcerpts");

    const batch = capturingModel([
      { index: 4, title: "Turn", markdown, summary: "Jack moves.", continuityNotes: [] }
    ]);
    await generateBatchDraft({
      input,
      plan,
      chapterBriefs: [],
      pageStart: 4,
      pageEnd: 4,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      styleExcerpts: excerpts,
      textModel: batch.model
    });
    expect(batch.payload?.styleExcerpts).toEqual(excerpts);
  });
});

describe("the citation contract, across brief, writer, and reviewer prompts", () => {
  const input = {
    prompt: "A sourced history of a disputed border.",
    category: "HISTORY",
    targetPages: 2,
    complexity: 6,
    temperature: 0.7,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral"
    }
  } as CreateProjectInput;
  const basePlan = makeFallbackPlan(input);
  const source = {
    query: "border archive",
    title: "Boundary Commission papers",
    url: "https://example.com/archive",
    summary: "A catalog of commission correspondence."
  };
  const prose =
    "The commission reached the river after the rains and found three roads converging at the ferry. Its clerks recorded the settlements on both banks, but the surviving map leaves the seasonal market unmarked. That omission limits what the line can prove without erasing the people and dates the record does preserve. The delegates returned in October, compared the road ledger with the ferry tolls, and shifted the proposed boundary east of the landing. Traders continued to use the western road through the dry season, while tax collectors counted cargo at a post the map placed on the opposite bank. Minutes from the final meeting preserve the vote and the names of the delegates, yet say nothing about the market day on which residents would first encounter the new line. A careful account can therefore reconstruct the administrative sequence without pretending the papers contain a complete civilian response.";

  function captureModel(data: unknown) {
    const capture: { system: string; payload: Record<string, unknown>; model: TextModelAdapter } = {
      system: "",
      payload: {},
      model: {
        async generateText() {
          return { text: "", model: "test-model", provider: "test" };
        },
        async generateJson(options) {
          capture.system = options.messages[0]?.content ?? "";
          capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, unknown>;
          return { data: options.schema.parse(data), text: "{}", model: "test-model", provider: "test" };
        },
        async *streamText() {
          yield "";
        },
        generateWithTools: unsupportedGenerateWithTools
      }
    };
    return capture;
  }

  const approved = {
    approved: true,
    score: 90,
    issues: [],
    requiredRevisions: [],
    notes: "Approved."
  };

  const sites = [
    {
      name: "chapter brief",
      async run(citeable: boolean) {
        const plan = { ...basePlan, researchNotes: citeable ? [source] : [] };
        const capture = captureModel({
          chapterIndex: plan.chapters[0]!.index,
          title: plan.chapters[0]!.title,
          summary: plan.chapters[0]!.summary,
          pages: [
            {
              pageIndex: 1,
              chapterIndex: plan.chapters[0]!.index,
              purpose: "Establish the disputed record.",
              beat: "Compare the ferry ledger with the commission map.",
              requiredContinuity: [],
              endingPressure: "The omission changes the boundary claim."
            }
          ],
          continuityFocus: []
        });
        await generateChapterBrief({
          input,
          plan,
          chapter: plan.chapters[0]!,
          chapterPageStart: 1,
          chapterPageEnd: 1,
          textModel: capture.model
        });
        return capture;
      }
    },
    {
      name: "page writer",
      async run(citeable: boolean) {
        const capture = captureModel({ title: "The Ferry Ledger", markdown: prose, summary: "The records diverge.", continuityNotes: [] });
        await generatePageDraft({
          input,
          plan: basePlan,
          pageIndex: 2,
          previousSummaries: [],
          previousPages: [],
          continuityNotes: [],
          researchNotes: citeable ? [`${source.title}: ${source.summary}`] : [],
          textModel: capture.model
        });
        return capture;
      }
    },
    {
      name: "page reviewer",
      async run(citeable: boolean) {
        const capture = captureModel(approved);
        await reviewPageDraft({
          input,
          plan: basePlan,
          pageIndex: 2,
          draft: { title: "The Ferry Ledger", markdown: prose, summary: "The records diverge.", continuityNotes: [] },
          previousPages: [],
          continuityNotes: [],
          researchNotes: citeable ? [`${source.title}: ${source.summary}`] : [],
          textModel: capture.model
        });
        return capture;
      }
    }
  ];

  it("keeps the empty/source rule sets identical to their payload gate sets", async () => {
    const emptyRule: string[] = [];
    const emptyPayload: string[] = [];
    const sourcedRule: string[] = [];
    const sourcedPayload: string[] = [];

    for (const site of sites) {
      const empty = await site.run(false);
      const sourced = await site.run(true);
      if (empty.system.includes("researchNotes is empty:")) emptyRule.push(site.name);
      if (Array.isArray(empty.payload.researchNotes) && empty.payload.researchNotes.length === 0) emptyPayload.push(site.name);
      if (sourced.system.includes("Use only sources present in researchNotes")) sourcedRule.push(site.name);
      if (Array.isArray(sourced.payload.researchNotes) && sourced.payload.researchNotes.length > 0) sourcedPayload.push(site.name);
    }

    expect(emptyRule).toEqual(emptyPayload);
    expect(sourcedRule).toEqual(sourcedPayload);
    expect(emptyRule).toEqual(sites.map((site) => site.name));
    expect(sourcedRule).toEqual(sites.map((site) => site.name));
  });
});

describe("sanitizePageBriefForCitationContract", () => {
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

  it("drops source-identity demands from the Wars page-1 brief when notes are empty", () => {
    const sanitized = sanitizePageBriefForCitationContract(warsPage1Brief, []);
    expect(sanitized).toEqual({
      pageIndex: 1,
      chapterIndex: 1,
      purpose:
        "Open inside the July Crisis in a mobilizing European city, assigning the openingHook without explaining the book or defining the war.",
      beat: "Show ordinary people encountering mobilization, mourning, military preparation, or uncertainty after the Sarajevo assassination. Keep the immediate question concrete: what does this first visible disruption mean, and how quickly can a regional crisis become a war?",
      requiredContinuity: [
        "Keep the date, place, person, or public event concrete. Do not invent interior thoughts or dialogue. Clarify that the assassination was a trigger within an already tense international system, not a complete explanation."
      ],
      endingPressure:
        "Leave the reader needing to know how an assassination in Sarajevo could activate decisions across several governments and turn public uncertainty into military movement."
    });
  });

  it("passes the same brief through when notes are citeable", () => {
    const notes = ["July Crisis papers (https://example.com/july-crisis): Diplomatic correspondence."];
    expect(sanitizePageBriefForCitationContract(warsPage1Brief, notes)).toBe(warsPage1Brief);
  });

  it("keeps the historical assignment on stored Wars opening briefs without source-identity leftovers", () => {
    const leftover = /diar(?:y|ies)|newspaper|source status|documented (?:moment|account|civilian|human)|official record|sourced account|verified civilian|contemporary report|photograph caption/i;
    const briefs = [
      {
        keep: /local-government experience|political fragmentation/i,
        purpose: "Open with a documented civilian or local-government experience that conveys political fragmentation at ground level.",
        beat: "Open with a documented civilian or local-government experience that conveys political fragmentation at ground level.",
        requiredContinuity: [
          "Establish that the chapter concerns the Chinese Civil War as a distinct conflict."
        ],
        endingPressure: "Leave a practical political problem."
      },
      {
        keep: /German invasion of Poland|September 1939/i,
        purpose: "Open with civilians confronting the German invasion of Poland in September 1939, using a documented location, testimony, photograph, diary, or official record.",
        beat: "Open with civilians confronting the German invasion of Poland in September 1939, using a documented location, testimony, photograph, diary, or official record.",
        requiredContinuity: ["Place the opening within the chronology of the German-Soviet invasion."],
        endingPressure: "End with occupation as a system."
      },
      {
        keep: /December 1944/i,
        purpose: "Open with a documented moment from the December 1944 crisis that places readers inside the uncertainty of liberation and contested authority.",
        beat: "Open with a documented moment from the December 1944 crisis that places readers inside the uncertainty of liberation and contested authority.",
        requiredContinuity: [
          "Define the occupation, resistance movements, government-in-exile, and return of political authority. Identify whose testimony or record supports the opening scene."
        ],
        endingPressure: "Ask how a resistance movement became an opponent of the postwar state."
      }
    ];

    for (const [index, fixture] of briefs.entries()) {
      const sanitized = sanitizePageBriefForCitationContract(
        {
          pageIndex: index + 1,
          chapterIndex: 1,
          purpose: fixture.purpose,
          beat: fixture.beat,
          requiredContinuity: fixture.requiredContinuity,
          endingPressure: fixture.endingPressure
        },
        []
      );
      expect(JSON.stringify(sanitized), `brief ${index}`).not.toMatch(leftover);
      expect(`${sanitized.purpose} ${sanitized.beat}`, `brief ${index} keep`).toMatch(fixture.keep);
    }
  });

  it("uses the reviewed displacement rewrite without inventing an unnamed witness", () => {
    const sanitized = sanitizePageBriefForCitationContract(
      {
        pageIndex: 136,
        chapterIndex: 14,
        purpose: "Open with a documented human experience of displacement.",
        beat: "Begin with a sourced account from a displaced person, relief worker, journalist, or official record during the flight from violence in 1966 or the early months of the war. Identify the place, date, and nature of the evidence, then briefly locate the reader in southeastern Nigeria.",
        requiredContinuity: ["Do not imply that one testimony represents all displaced people."],
        endingPressure: "End with why political crisis became mass displacement."
      },
      []
    );
    expect(sanitized.beat).toBe(
      "Begin with the public effects of the flight from violence in 1966 or the early months of the war. Keep the place and date concrete, then briefly locate the reader in southeastern Nigeria."
    );
    expect(sanitized.requiredContinuity).toEqual([
      "Do not imply that one person's experience represents all displaced people."
    ]);
  });

  it("passes unreviewed text through byte-for-byte in every language and genre", () => {
    const unreviewed = [
      {
        pageIndex: 4,
        chapterIndex: 1,
        purpose: "Move the investigation forward.",
        beat: "Mara steals the diary from the archives before the guard returns.",
        requiredContinuity: ["The diary belonged to Mara's mother."],
        endingPressure: "The final entry changes whom Mara trusts."
      },
      {
        pageIndex: 5,
        chapterIndex: 1,
        purpose: "Explain public mobilization.",
        beat: "Explain how newspapers shaped public opinion during the July Crisis.",
        requiredContinuity: ["Keep the date and place of the demonstrations concrete."],
        endingPressure: "Public pressure narrows the cabinet's options."
      },
      {
        pageIndex: 6,
        chapterIndex: 1,
        purpose: "تابع الأزمة السياسية.",
        beat: "اشرح كيف تغير ميزان القوى بعد القرار.",
        requiredContinuity: ["لا تخترع أفكارًا داخلية أو حوارًا."],
        endingPressure: "اترك السؤال السياسي التالي مفتوحًا."
      },
      {
        pageIndex: 7,
        chapterIndex: 1,
        purpose: "Explain the crisis.",
        beat: "Present the ultimatum and mobilization timetable, showing how the crisis escalated.",
        requiredContinuity: ["Identify the date and place of the invasion."],
        endingPressure: "Show the consequence."
      },
      {
        pageIndex: 8,
        chapterIndex: 1,
        purpose: "Explain the crisis.",
        beat: "Cite a diary entry.",
        requiredContinuity: [],
        endingPressure: "Show the consequence."
      }
    ];

    for (const brief of unreviewed) {
      expect(sanitizePageBriefForCitationContract(brief, [])).toBe(brief);
    }
  });
});

/**
 * **The sweep the three drift rounds would each have failed.**
 *
 * Page 1's contract has two halves — the opening-quality ban and the hook
 * delivery — and an imported manuscript is exempt from both, because its plan
 * describes a manuscript nobody planned. Every prompt in the pipeline that says
 * anything about the opening has to answer both the same way. Stated per prompt,
 * they came apart four times: the multi-page writers fused the ban into the hook
 * sentence and lost it for every hookless plan, the page reviewer stated the ban
 * on every page of every book, `buildPageInstruction` stated it with no import
 * check and fed it to the reviser and the polisher, and then the hook half was
 * left ungated and walked back through that same reviser.
 *
 * So this asks the question those rounds each got wrong of *every* site at once,
 * and it asks it as a set identity rather than site by site: the set of prompts
 * stating the ban must be exactly the set the import exemption silences, and the
 * set naming the hook must be exactly the set a hookless plan silences *and*
 * exactly the set an import silences. All three sets are *measured* from the
 * prompts rather than listed here, so none can be kept right by editing this
 * file — and a prompt that phrases the ban in its own words instead of quoting
 * `OPENING_QUALITY_RULE_MARKER` is measured as not stating it at all, which the
 * "every site states it" assertion is what catches.
 */
describe("the opening contract, across every prompt that states it", () => {
  const contractInput: CreateProjectInput = {
    prompt: "Jack The Martyr, a character-led story about sacrifice and consequence.",
    category: "STORY",
    targetPages: 2,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral"
    }
  } as CreateProjectInput;

  /**
   * The provenance an imported manuscript carries — `mediaSettings.mobile.import`,
   * written by the import route and carried through every plan version's input
   * snapshot. It is the only thing separating these two books.
   */
  const importedContractInput: CreateProjectInput = {
    ...contractInput,
    mediaSettings: {
      ...contractInput.mediaSettings,
      mobile: { bookType: "custom", import: { importId: "imp_1", fileName: "chapel.docx", format: "docx" } }
    }
  } as CreateProjectInput;

  const hooklessPlan = makeFallbackPlan(contractInput);
  const contractHook = "Jack is already halfway over the chapel wall when the bell starts ringing for him.";
  const hookPlan: BookPlan = { ...hooklessPlan, openingHook: contractHook };

  const openingProse = [
    "The chapel door had been painted black so many times that the grain underneath looked bruised. Jack pressed two fingers to the iron latch and felt it tremble before anyone touched it from the other side.",
    "",
    '"You promised you would wait," Mara said from the stairwell.',
    "",
    "Jack did not turn. The folded warrant in his coat had already warmed against his ribs, and the red wax seal had cracked where his thumb kept worrying it. Inside the chapel, someone dragged a chair across stone. That small sound decided him."
  ].join("\n");

  const ledgerProse = [
    "The ledger room smelled of tallow and wet wool. Mara spread the parish accounts across the table and set a candle at each corner so the columns would not swim.",
    "",
    "Jack read the entries twice. Somebody had paid the bell-ringer a full week's wage on a night the tower was supposed to be empty, and the signature under the payment was the priest's — dated two days after the priest had left for the coast."
  ].join("\n");

  function prose(pageIndex: number): string {
    return pageIndex === 1 ? openingProse : ledgerProse;
  }

  /** Distinct per page: the local final-QA gate rejects two pages summarised alike. */
  function pageSummary(pageIndex: number): string {
    return pageIndex === 1
      ? "Jack is caught at the chapel latch when Mara calls him back from the stairwell."
      : "Mara finds a payment in the parish accounts that the absent priest could not have signed.";
  }

  /** Everything one call put in front of the model: system content and payload. */
  function capturingModel(data: unknown) {
    const capture: { prompt: string; model: TextModelAdapter } = {
      prompt: "",
      model: {
        async generateText() {
          return { text: "", model: "test-model", provider: "test" };
        },
        async generateJson(options) {
          capture.prompt = `${options.messages[0]?.content ?? ""}\n${options.messages[1]?.content ?? ""}`;
          return { data: options.schema.parse(data), text: "{}", model: "test-model", provider: "test" };
        },
        async *streamText() {
          yield "";
        },
        generateWithTools: unsupportedGenerateWithTools
      }
    };
    return capture;
  }

  function draftPages(pageStart: number, pageEnd: number) {
    return range(pageStart, pageEnd).map((index) => ({
      index,
      title: `Page ${index}`,
      markdown: prose(index),
      summary: pageSummary(index),
      continuityNotes: []
    }));
  }

  const pageDraft = { title: "The Wall Bell", markdown: openingProse, summary: "Jack is caught mid-climb.", continuityNotes: [] };
  const approvedReport = {
    approved: true,
    score: 92,
    issues: [],
    requiredRevisions: [],
    notes: "Approved.",
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
  };

  type OpeningPromptScenario = {
    input: CreateProjectInput;
    plan: BookPlan;
    /** The absolute page range this call writes, judges or reviews. */
    pageStart: number;
    pageEnd: number;
  };

  type OpeningPromptSite = {
    name: string;
    /**
     * Whether the call can be aimed away from page 1 at all. The one-pass draft
     * and final book QA are always handed the whole book, so "page 7 of a
     * forty-page book" is not a question they can be asked.
     */
    alwaysWritesFirstPage?: boolean;
    /** Whether this prompt carries the hook contract. Final QA judges the opening prose, not its delivery. */
    carriesOpeningHook: boolean;
    run: (scenario: OpeningPromptScenario) => Promise<string>;
  };

  const SITES: OpeningPromptSite[] = [
    {
      name: "generateWholeBookDraft",
      alwaysWritesFirstPage: true,
      carriesOpeningHook: true,
      async run({ input, plan }) {
        const capture = capturingModel({ pages: draftPages(1, input.targetPages) });
        await generateWholeBookDraft({ input, plan, researchNotes: [], textModel: capture.model });
        return capture.prompt;
      }
    },
    {
      name: "generateChapterDraft",
      carriesOpeningHook: true,
      async run({ input, plan, pageStart, pageEnd }) {
        const capture = capturingModel({ pages: draftPages(pageStart, pageEnd) });
        await generateChapterDraft({
          input,
          plan,
          chapter: plan.chapters[0]!,
          chapterPageStart: pageStart,
          chapterPageEnd: pageEnd,
          previousPages: [],
          continuityNotes: [],
          researchNotes: [],
          textModel: capture.model
        });
        return capture.prompt;
      }
    },
    {
      name: "generateBatchDraft",
      carriesOpeningHook: true,
      async run({ input, plan, pageStart, pageEnd }) {
        const capture = capturingModel({ pages: draftPages(pageStart, pageEnd) });
        await generateBatchDraft({
          input,
          plan,
          chapterBriefs: [],
          pageStart,
          pageEnd,
          previousPages: [],
          continuityNotes: [],
          researchNotes: [],
          textModel: capture.model
        });
        return capture.prompt;
      }
    },
    {
      name: "generatePageDraft",
      carriesOpeningHook: true,
      async run({ input, plan, pageStart }) {
        const capture = capturingModel(pageDraft);
        await generatePageDraft({
          input,
          plan,
          pageIndex: pageStart,
          previousSummaries: [],
          previousPages: [],
          continuityNotes: [],
          researchNotes: [],
          textModel: capture.model
        });
        return capture.prompt;
      }
    },
    {
      name: "polishPageDraft",
      carriesOpeningHook: true,
      async run({ input, plan, pageStart }) {
        const capture = capturingModel(pageDraft);
        await polishPageDraft({
          input,
          plan,
          pageIndex: pageStart,
          draft: { ...pageDraft, markdown: prose(pageStart) },
          previousPages: [],
          nextPages: [],
          continuityNotes: [],
          researchNotes: [],
          textModel: capture.model
        });
        return capture.prompt;
      }
    },
    {
      name: "revisePageDraft",
      carriesOpeningHook: true,
      async run({ input, plan, pageStart }) {
        const capture = capturingModel(pageDraft);
        await revisePageDraft({
          input,
          plan,
          pageIndex: pageStart,
          draft: { ...pageDraft, markdown: prose(pageStart) },
          report: { ...approvedReport, approved: false, score: 40, issues: ["Repeats page 3."], requiredRevisions: ["Change the beat."] },
          previousPages: [],
          continuityNotes: [],
          textModel: capture.model
        });
        return capture.prompt;
      }
    },
    {
      name: "reviewPageDraft",
      carriesOpeningHook: true,
      async run({ input, plan, pageStart }) {
        const capture = capturingModel(approvedReport);
        await reviewPageDraft({
          input,
          plan,
          pageIndex: pageStart,
          draft: { ...pageDraft, markdown: prose(pageStart) },
          previousPages: [],
          continuityNotes: [],
          textModel: capture.model
        });
        return capture.prompt;
      }
    },
    {
      name: "runFinalBookQa",
      alwaysWritesFirstPage: true,
      carriesOpeningHook: false,
      async run({ input, plan }) {
        const capture = capturingModel({ approved: true, score: 92, issues: [], requiredFixes: [], notes: "Approved." });
        await runFinalBookQa({
          input,
          plan,
          pages: range(1, input.targetPages).map((index) => ({
            index,
            title: `Page ${index}`,
            markdown: prose(index),
            summary: pageSummary(index)
          })),
          textModel: capture.model
        });
        return capture.prompt;
      }
    }
  ];

  const statesBan = (prompt: string) => prompt.includes(OPENING_QUALITY_RULE_MARKER);
  const namesHook = (prompt: string) => prompt.includes("openingHook");
  const firstPage = { pageStart: 1, pageEnd: 1 };
  const laterPage = { pageStart: 2, pageEnd: 2 };

  it("states the ban in exactly the prompts the import exemption silences", async () => {
    const stating: string[] = [];
    const silencedByImport: string[] = [];
    for (const site of SITES) {
      const generated = await site.run({ input: contractInput, plan: hookPlan, ...firstPage });
      const imported = await site.run({ input: importedContractInput, plan: hookPlan, ...firstPage });
      if (statesBan(generated)) {
        stating.push(site.name);
      }
      if (statesBan(generated) && !statesBan(imported)) {
        silencedByImport.push(site.name);
      }
    }

    expect(silencedByImport).toEqual(stating);
    expect(stating).toEqual(SITES.map((site) => site.name));
  });

  it("states the ban to a plan that committed to no opening hook", async () => {
    // Round one: `makeFallbackPlan` sets no `openingHook`, and neither does any
    // plan stored before the field existed or any run where the model omitted
    // the optional key. The ban rode the hook sentence, so all three drafted
    // page 1 with no first-page instruction at all — and the reviewer then
    // failed the page and paid for a revision of it.
    for (const site of SITES) {
      const prompt = await site.run({ input: contractInput, plan: hooklessPlan, ...firstPage });
      expect([site.name, statesBan(prompt)]).toEqual([site.name, true]);
      expect([site.name, namesHook(prompt)]).toEqual([site.name, false]);
    }
  });

  it("names the hook in exactly the prompts a hookless plan silences, and in exactly the ones an import silences", async () => {
    // Round five: the hook half used to be gated on the plan and on nothing
    // else, justified as "a repair's replacement page is generated prose". That
    // is true of the brief producers and false of every prompt below —
    // `revisePageDraft` and `polishPageDraft` rewrite the page they are handed,
    // in place, and a reader's "make page 1 sharper" reaches `revisePageDraft`
    // through `rewritePageForUserRequest`. An import's `openingHook` is invented
    // by a later plan revision that never saw page 1 (a fresh import's plan has
    // none at all), so naming it on that page is an instruction to rewrite the
    // author's opening — the one thing the exemption exists to prevent, arriving
    // through the other half. Both halves are now one fact, so this measures the
    // hook's set identity the same way the ban's is measured above: three sets,
    // and neither gate can be the one that moves.
    const naming: string[] = [];
    const gatedOnThePlan: string[] = [];
    const silencedByImport: string[] = [];
    for (const site of SITES) {
      const withHook = await site.run({ input: contractInput, plan: hookPlan, ...firstPage });
      const hookless = await site.run({ input: contractInput, plan: hooklessPlan, ...firstPage });
      const imported = await site.run({ input: importedContractInput, plan: hookPlan, ...firstPage });
      if (namesHook(withHook)) {
        naming.push(site.name);
      }
      if (namesHook(withHook) && !namesHook(hookless)) {
        gatedOnThePlan.push(site.name);
      }
      if (namesHook(withHook) && !namesHook(imported)) {
        silencedByImport.push(site.name);
      }
    }

    expect(gatedOnThePlan).toEqual(naming);
    expect(silencedByImport).toEqual(naming);
    expect(naming).toEqual(SITES.filter((site) => site.carriesOpeningHook).map((site) => site.name));
  });

  it("says nothing at all about the opening on an import's page 1", async () => {
    // The two halves read one fact, so the whole contract is silent rather than
    // half-stated: hook without ban is round one in mirror image — page 1 told
    // to be striking with none of the rules that say what a striking opening is.
    for (const site of SITES) {
      const prompt = await site.run({ input: importedContractInput, plan: hookPlan, ...firstPage });
      expect([site.name, statesBan(prompt)]).toEqual([site.name, false]);
      expect([site.name, namesHook(prompt)]).toEqual([site.name, false]);
    }
  });

  it("says nothing about the opening to a prompt that does not write page 1", async () => {
    for (const site of SITES.filter((candidate) => candidate.alwaysWritesFirstPage !== true)) {
      const prompt = await site.run({ input: contractInput, plan: hookPlan, ...laterPage });
      expect([site.name, statesBan(prompt)]).toEqual([site.name, false]);
      expect([site.name, namesHook(prompt)]).toEqual([site.name, false]);
    }
  });
});
