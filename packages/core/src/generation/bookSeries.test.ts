import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter, unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { GenerateJsonOptions, GenerateTextOptions, JsonResult, TextModelAdapter, TextResult } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { JsonValue } from "../schemas/jsonCoercion.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import {
  BOOK_SERIES_LIMITS,
  SERIES_OPENING_RULE,
  SERIES_WRITER_RULE,
  bookSeriesFromMediaSettings,
  buildBookSeriesSnapshot,
  planSeriesGuidance,
  reconcilePlanSeries,
  seriesPromptLine,
  seriesWriterFields,
  withEndingFacts,
  withoutBookSeriesRecord,
  type BookSeriesSnapshot,
  type BookSeriesSource
} from "./bookSeries.js";
import { formPaletteFor, fallbackChapterComposition } from "./chapterForms.js";
import { composeChapter } from "./composedChapter.js";
import type { LibraryCharacterSnapshot } from "./libraryCharacters.js";
import { buildPageDraftSystemContent, buildPageDraftUserPayload } from "./pageDraftMessages.js";
import { createPlanningPackage, revisePlanningPackage } from "./planner.js";

const baseInput: CreateProjectInput = {
  prompt: "A bedtime story about Luna the fox finding her way home.",
  category: "STORY",
  targetPages: 12,
  complexity: 5,
  temperature: 0.7,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    toneProfile: "neutral"
  }
};

const sourcePlan: BookPlan = {
  ...makeFallbackPlan(baseInput),
  premise: "Luna the fox loses her way in the night garden and finds the lantern bridge home.",
  characters: [
    { name: "Luna", role: "Protagonist", description: "A curious young fox.", traits: ["brave"], visualRules: ["red fur with a white-tipped tail", "a blue scarf"] },
    { name: "Bram", role: "Friend", description: "An old badger who keeps the bridge.", traits: [], visualRules: [] }
  ],
  locations: [{ name: "The night garden", description: "A walled garden of glowing moss.", rules: [] }],
  continuityRules: ["The lantern bridge only lights for those who ask politely."],
  voiceGuide: ["Short, warm sentences.", "One sound word per page."],
  illustrationPlan: { ...makeFallbackPlan(baseInput).illustrationPlan, globalStyle: "Soft watercolor with ink outlines, moonlit palette." }
};

function source(overrides: Partial<BookSeriesSource> = {}): BookSeriesSource {
  return {
    projectId: "book-1",
    title: "The Night Garden",
    mode: "continuation",
    plan: sourcePlan,
    drewPictures: true,
    chapters: [
      { title: "Lost", summary: "Luna wanders off.", facts: [{ subject: "Luna", attribute: "home", value: "the den under the oak" }] },
      { title: "Home", summary: "Bram lights the bridge.", facts: [{ subject: "Bram", attribute: "job", value: "keeper of the lantern bridge" }, { subject: "", value: "dropped" }] }
    ],
    pages: ["# Lost\n\nLuna followed a glow-worm past the wall.", "Bram lit the bridge and Luna ran home."],
    ...overrides
  };
}

function inputWithSeries(series: BookSeriesSnapshot, characters: LibraryCharacterSnapshot[] = []): CreateProjectInput {
  return {
    ...baseInput,
    mediaSettings: {
      ...baseInput.mediaSettings,
      mobile: JSON.parse(JSON.stringify({ characters, series })) as JsonValue
    }
  };
}

describe("buildBookSeriesSnapshot", () => {
  it("numbers a continuation after a book with no series, and names the series after it", () => {
    const series = buildBookSeriesSnapshot(source());
    expect(series).toMatchObject({ mode: "continuation", sourceTitle: "The Night Garden", seriesName: "The Night Garden", bookNumber: 2 });
  });

  it("takes the next number of the series a continued book already belongs to", () => {
    const book2 = buildBookSeriesSnapshot(source());
    const book3 = buildBookSeriesSnapshot(source({ projectId: "book-2", title: "The Lantern Thief", sourceSeries: book2 }));
    expect(book3).toMatchObject({ seriesName: "The Night Garden", bookNumber: 3, sourceTitle: "The Lantern Thief" });
  });

  it("starts a new series when the continued book was only inspired by another", () => {
    const inspired = buildBookSeriesSnapshot(source({ mode: "inspired" }));
    const next = buildBookSeriesSnapshot(source({ projectId: "book-2", title: "Winter Garden", sourceSeries: inspired }));
    expect(next).toMatchObject({ seriesName: "Winter Garden", bookNumber: 2 });
  });

  it("carries the ledger's facts, dropping a stored fact with nothing in it", () => {
    const series = buildBookSeriesSnapshot(source());
    expect(series.facts).toEqual([
      { subject: "Luna", attribute: "home", value: "the den under the oak" },
      { subject: "Bram", attribute: "job", value: "keeper of the lantern bridge" }
    ]);
  });

  it("carries a short book whole, and reads no final chapter for it", () => {
    const series = buildBookSeriesSnapshot(source({ finalChapterPages: ["Bram lit the bridge and Luna ran home."] }));
    expect(series.fullText).toContain("Luna followed a glow-worm past the wall.");
    expect(series.fullText).not.toContain("# Lost");
    expect(series.finalChapter).toBeUndefined();
    expect(series.ending).toContain("Luna ran home.");
  });

  it("carries a long book's ending and its last chapter, never the whole text", () => {
    const page = "Luna walked on through the garden, counting the lanterns one by one as they came on. ".repeat(40);
    const pages = Array.from({ length: 6 }, () => page);
    const series = buildBookSeriesSnapshot(source({ pages, finalChapterPages: pages.slice(-2) }));
    expect(series.fullText).toBeUndefined();
    expect(series.ending!.length).toBeLessThanOrEqual(BOOK_SERIES_LIMITS.ending);
    expect(series.finalChapter!.length).toBeLessThanOrEqual(BOOK_SERIES_LIMITS.finalChapter);
  });

  it("records the illustration style only for a book a model drew", () => {
    expect(buildBookSeriesSnapshot(source()).illustrationStyle).toBe("Soft watercolor with ink outlines, moonlit palette.");
    expect(buildBookSeriesSnapshot(source({ drewPictures: false })).illustrationStyle).toBeUndefined();
  });

  it("gives an inspired book the world and the look, and none of the earlier book's events", () => {
    const series = buildBookSeriesSnapshot(source({ mode: "inspired" }));
    expect(series.bookNumber).toBeUndefined();
    expect(series.synopsis).toEqual([]);
    expect(series.facts).toEqual([]);
    expect(series.ending).toBeUndefined();
    expect(series.fullText).toBeUndefined();
    expect(series.characters.map((character) => character.name)).toEqual(["Luna", "Bram"]);
  });
});

describe("reading the snapshot back", () => {
  it("reads a book with no series, or a record it cannot parse, as none", () => {
    expect(bookSeriesFromMediaSettings(baseInput.mediaSettings)).toBeUndefined();
    expect(bookSeriesFromMediaSettings({ mobile: { series: { version: 9 } } })).toBeUndefined();
    const series = buildBookSeriesSnapshot(source());
    expect(bookSeriesFromMediaSettings(inputWithSeries(series).mediaSettings)).toEqual(series);
  });

  it("takes the record out of a prompt's userInput and leaves the rest of mobile alone", () => {
    const input = inputWithSeries(buildBookSeriesSnapshot(source()), [{ id: "lib-luna", name: "Luna", description: "", fields: [] }]);
    const stripped = withoutBookSeriesRecord(input);
    expect(bookSeriesFromMediaSettings(stripped.mediaSettings)).toBeUndefined();
    expect(JSON.stringify(stripped.mediaSettings)).toContain("lib-luna");
    expect(withoutBookSeriesRecord(baseInput)).toBe(baseInput);
  });

  it("appends the ending's facts once and drops the chapter text it read them from", () => {
    const series = buildBookSeriesSnapshot(source({ pages: Array.from({ length: 30 }, () => "A long page of the garden. ".repeat(20)), finalChapterPages: ["The last chapter."] }));
    expect(series.finalChapter).toBe("The last chapter.");
    const after = withEndingFacts(series, [{ subject: "Luna", attribute: "home", value: "the lighthouse" }]);
    expect(after.finalChapter).toBeUndefined();
    expect(after.endingFactsTaken).toBe(true);
    expect(after.facts.at(-1)).toEqual({ subject: "Luna", attribute: "home", value: "the lighthouse" });
  });
});

describe("seriesPromptLine", () => {
  it("tells every writer a continuation is a sequel it must not recap", () => {
    const line = seriesPromptLine(buildBookSeriesSnapshot(source()));
    expect(line).toContain('book 2 of the series "The Night Garden"');
    expect(line).toContain("never recap it");
  });

  it("tells every writer an inspired book does not continue the earlier one", () => {
    expect(seriesPromptLine(buildBookSeriesSnapshot(source({ mode: "inspired" })))).toContain("does not continue that book's events");
  });
});

describe("planSeriesGuidance", () => {
  it("is nothing for a book with no series", () => {
    expect(planSeriesGuidance(undefined)).toEqual([]);
  });

  it("hands a continuation's planner the whole record and the rules about it", () => {
    const text = planSeriesGuidance(buildBookSeriesSnapshot(source())).join("\n");
    expect(text).toContain('continues the user\'s earlier book "The Night Garden"');
    expect(text).toContain('"Luna" — Protagonist: A curious young fox.');
    expect(text).toContain("red fur with a white-tipped tail");
    expect(text).toContain("The lantern bridge only lights for those who ask politely.");
    expect(text).toContain("keeper of the lantern bridge");
    expect(text).toContain("The whole earlier book");
    expect(text).toContain("Do not retell or recap");
    expect(text).toContain("The Night Garden, Book 2");
  });

  it("gives an inspired book's planner the world but no facts and no ending", () => {
    const text = planSeriesGuidance(buildBookSeriesSnapshot(source({ mode: "inspired" }))).join("\n");
    expect(text).toContain("neither continues nor depends on that book's events");
    expect(text).not.toContain("What happened");
    expect(text).not.toContain("Lost: Luna wanders off.");
    expect(text).not.toContain("Established facts");
    expect(text).not.toContain("The whole earlier book");
    expect(text).not.toContain("subtitle");
  });
});

describe("reconcilePlanSeries", () => {
  it("holds the style and a returning character's look, whatever the planner wrote", () => {
    const series = buildBookSeriesSnapshot(source());
    const planned: BookPlan = {
      ...makeFallbackPlan(baseInput),
      characters: [
        { name: "Luna", role: "Hero", description: "A fox.", traits: [], visualRules: ["grey fur"] },
        { name: "Pip", role: "New friend", description: "A mouse.", traits: [], visualRules: ["tiny green hat"] }
      ],
      illustrationPlan: { ...makeFallbackPlan(baseInput).illustrationPlan, globalStyle: "Bold flat vector art." }
    };
    const reconciled = reconcilePlanSeries(planned, series);
    expect(reconciled.illustrationPlan.globalStyle).toBe("Soft watercolor with ink outlines, moonlit palette.");
    expect(reconciled.characters[0]!.visualRules).toEqual(["red fur with a white-tipped tail", "a blue scarf"]);
    expect(reconciled.characters[1]!.visualRules).toEqual(["tiny green hat"]);
  });

  it("returns the plan itself for a book with no series", () => {
    const plan = makeFallbackPlan(baseInput);
    expect(reconcilePlanSeries(plan, undefined)).toBe(plan);
  });
});

describe("seriesWriterFields", () => {
  it("is nothing for a book with no series, or one only inspired by another", () => {
    expect(seriesWriterFields(baseInput, { opening: true })).toEqual({ rules: [], payload: {} });
    expect(seriesWriterFields(inputWithSeries(buildBookSeriesSnapshot(source({ mode: "inspired" }))), { opening: true })).toEqual({ rules: [], payload: {} });
  });

  it("gives every writer the facts and only the opening writer the ending", () => {
    const input = inputWithSeries(buildBookSeriesSnapshot(source()));
    const opening = seriesWriterFields(input, { opening: true });
    expect(opening.rules).toEqual([SERIES_WRITER_RULE, SERIES_OPENING_RULE]);
    expect(opening.payload.previousBook?.ending).toContain("Luna ran home.");
    expect(opening.payload.previousBook?.facts.join(" ")).toContain("keeper of the lantern bridge");
    const later = seriesWriterFields(input, { opening: false });
    expect(later.rules).toEqual([SERIES_WRITER_RULE]);
    expect(later.payload.previousBook?.ending).toBeUndefined();
  });
});

describe("the planner reads a series", () => {
  it("puts the record before the library rules, keeps it out of userInput, and holds the plan to it", async () => {
    const series = buildBookSeriesSnapshot(source());
    const input = inputWithSeries(series);
    let request: GenerateJsonOptions<unknown> | undefined;
    const planned = { ...makeFallbackPlan(input), characters: [{ name: "Luna", role: "Hero", description: "A fox.", traits: [], visualRules: ["grey fur"] }] };
    const plan = await createPlanningPackage({
      input,
      textModel: recordingTextModel((options) => { request = options; }, planned),
      research: stubResearch()
    });
    const system = request!.messages.find((message) => message.role === "system")!.content;
    expect(system).toContain('continues the user\'s earlier book "The Night Garden"');
    const user = JSON.parse(request!.messages.find((message) => message.role === "user")!.content);
    expect(JSON.stringify(user.userInput)).not.toContain("keeper of the lantern bridge");
    expect(plan.characters[0]!.visualRules).toEqual(["red fur with a white-tipped tail", "a blue scarf"]);
    expect(plan.illustrationPlan.globalStyle).toBe("Soft watercolor with ink outlines, moonlit palette.");
  });

  it("lets a saved library character's own look outrank the earlier book's", async () => {
    const series = buildBookSeriesSnapshot(source());
    const luna: LibraryCharacterSnapshot = { id: "lib-luna", name: "Luna", description: "A curious young fox.", appearance: "orange fur and a yellow raincoat", fields: [] };
    const input = inputWithSeries(series, [luna]);
    const plan = await createPlanningPackage({ input, textModel: unusedTextModel(), research: stubResearch(), forceFallback: true });
    expect(plan.characters.find((character) => character.name === "Luna")!.visualRules).toEqual(["orange fur and a yellow raincoat"]);
    expect(plan.illustrationPlan.globalStyle).toBe("Soft watercolor with ink outlines, moonlit palette.");
  });

  it("hands a revision the record too, since its payload carries no input", async () => {
    const input = inputWithSeries(buildBookSeriesSnapshot(source()));
    let request: GenerateJsonOptions<unknown> | undefined;
    await revisePlanningPackage({
      currentPlan: makeFallbackPlan(input),
      userMessage: "Make it shorter.",
      textModel: recordingTextModel((options) => { request = options; }, { title: "Shorter", questions: [] }),
      input,
      targetPages: input.targetPages
    });
    const system = request!.messages.find((message) => message.role === "system")!.content;
    expect(system).toContain("keeper of the lantern bridge");
    expect(system).toContain("unless the user's message asks to change them");
    expect(system).not.toContain("word for word");
  });

  it("lets a revision change the earlier book's style and a returning character's look", async () => {
    const input = inputWithSeries(buildBookSeriesSnapshot(source()));
    const currentPlan = reconcilePlanSeries(
      { ...makeFallbackPlan(input), characters: [{ name: "Luna", role: "Hero", description: "A fox.", traits: [], visualRules: [] }] },
      bookSeriesFromMediaSettings(input.mediaSettings)
    );
    const revised = await revisePlanningPackage({
      currentPlan,
      userMessage: "Make the art bold flat vector, and give Luna a green scarf.",
      textModel: recordingTextModel(() => undefined, {
        questions: [],
        characters: [{ name: "Luna", role: "Hero", description: "A fox.", traits: [], visualRules: ["red fur", "a green scarf"] }],
        illustrationPlan: { ...currentPlan.illustrationPlan, globalStyle: "Bold flat vector art." }
      }),
      input,
      targetPages: input.targetPages
    });
    expect(revised.illustrationPlan.globalStyle).toBe("Bold flat vector art.");
    expect(revised.characters[0]!.visualRules).toEqual(["red fur", "a green scarf"]);
  });
});

describe("the writers read a continuation", () => {
  it("gives the page writer the facts, and page 1 alone the ending", () => {
    const input = inputWithSeries(buildBookSeriesSnapshot(source()));
    const plan = makeFallbackPlan(input);
    const options = { input, plan, chapter: plan.chapters[0]!, previousSummaries: [], previousPages: [], continuityNotes: [], researchNotes: [], textModel: unusedTextModel() };
    const first = buildPageDraftUserPayload({ ...options, pageIndex: 1 }) as Record<string, any>;
    expect(first.previousBook.ending).toContain("Luna ran home.");
    expect(buildPageDraftSystemContent({ ...options, pageIndex: 1 })).toContain(SERIES_OPENING_RULE);
    const later = buildPageDraftUserPayload({ ...options, pageIndex: 4 }) as Record<string, any>;
    expect(later.previousBook.facts.join(" ")).toContain("keeper of the lantern bridge");
    expect(later.previousBook.ending).toBeUndefined();
  });

  it("leaves a book with no series' page prompt as it was", () => {
    const plan = makeFallbackPlan(baseInput);
    const options = { input: baseInput, plan, chapter: plan.chapters[0]!, pageIndex: 1, previousSummaries: [], previousPages: [], continuityNotes: [], researchNotes: [], textModel: unusedTextModel() };
    expect(JSON.stringify(buildPageDraftUserPayload(options))).not.toContain("previousBook");
    expect(buildPageDraftSystemContent(options)).not.toContain("previousBook");
  });

  it("gives the composed chapter that opens the book the ending, and a later one only the facts", async () => {
    const input = inputWithSeries(buildBookSeriesSnapshot(source()));
    const plan = makeFallbackPlan({ ...input, targetPages: 24 });
    const stance = { thesis: "Home is the people who light the way.", positions: [], refusals: [], voiceSample: "A short warm sample." };
    const palette = formPaletteFor("narrative");
    const promptFor = async (chapterIndex: number, start: number, end: number) => {
      const fake = new FakeTextModelAdapter(input);
      const seen: GenerateTextOptions[] = [];
      const recording = { ...fake, generateText: (options: GenerateTextOptions) => { seen.push(options); return fake.generateText(options); } } as unknown as FakeTextModelAdapter;
      const chapter = plan.chapters[chapterIndex]!;
      const composition = fallbackChapterComposition({ chapter, startPage: start, endPage: end }, palette, chapterIndex);
      await composeChapter({ input, plan, stance, chapter, composition, chapterPageStart: start, chapterPageEnd: end, earlierChapters: [], continuityNotes: [], researchNotes: [], textModel: recording });
      return seen[0]!.messages.map((message) => message.content).join("\n");
    };
    const opening = await promptFor(0, 1, plan.chapters[0]!.targetPages);
    expect(opening).toContain(SERIES_OPENING_RULE);
    expect(opening).toContain("Luna ran home.");
    const later = await promptFor(1, plan.chapters[0]!.targetPages + 1, plan.chapters[0]!.targetPages + plan.chapters[1]!.targetPages);
    expect(later).toContain(SERIES_WRITER_RULE);
    expect(later).not.toContain(SERIES_OPENING_RULE);
  });
});

function recordingTextModel(onRequest: (options: GenerateJsonOptions<unknown>) => void, data: unknown): TextModelAdapter {
  return {
    async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
      onRequest(options as GenerateJsonOptions<unknown>);
      return { data: data as T, text: JSON.stringify(data), model: "test-model", provider: "test" };
    },
    async generateText(_options: GenerateTextOptions): Promise<TextResult> {
      throw new Error("Not used");
    },
    async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
      throw new Error("Not used");
    },
    generateWithTools: unsupportedGenerateWithTools
  };
}

function unusedTextModel(): TextModelAdapter {
  return recordingTextModel(() => {
    throw new Error("Not used");
  }, {});
}

function stubResearch() {
  return {
    async search(query: { query: string }) {
      return { query: query.query, summary: "", sources: [] };
    }
  };
}
