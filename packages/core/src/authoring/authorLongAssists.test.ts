import { describe, expect, it } from "vitest";

import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import { parseSchemaWithContext } from "../adapters/json.js";
import type { GenerateJsonOptions, JsonResult, TextModelAdapter } from "../adapters/types.js";
import { CLIPPED_MIDDLE_MARKER } from "./authorAssistSchemas.js";
import { AuthorAssistInputError, AuthorAssistUnavailableError, type AuthorAssistBook } from "./authorAssistTypes.js";
import {
  checkBookConsistency,
  clampTargetWords,
  consistencyChapters,
  CONSISTENCY_CHAPTER_CHARS,
  draftChapterFromNotes,
  outlineAuthorBook,
  reviewChapterForAuthor
} from "./authorLongAssists.js";

type Reply = unknown | Error;

function scripted(...replies: Reply[]) {
  const requests: GenerateJsonOptions<unknown>[] = [];
  const textModel: TextModelAdapter = {
    async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
      requests.push(options as GenerateJsonOptions<unknown>);
      if (replies.length === 0) throw new Error("script exhausted");
      const next = replies.shift();
      if (next instanceof Error) throw next;
      const text = JSON.stringify(next);
      return { data: parseSchemaWithContext("Scripted", options.schema, next, options.purpose, text), text, model: "scripted", provider: "scripted" };
    },
    generateText: () => Promise.reject(new Error("generateText is not used")),
    async *streamText() {},
    generateWithTools: unsupportedGenerateWithTools
  };
  return { textModel, requests };
}

function payload(options: GenerateJsonOptions<unknown>): Record<string, unknown> {
  return JSON.parse(options.messages.at(-1)!.content) as Record<string, unknown>;
}

const book: AuthorAssistBook = { title: "The Salt Road", kind: "story", language: "en" };

describe("draftChapterFromNotes", () => {
  it("drafts from notes, clamps the target and strips a title heading", async () => {
    const { textModel, requests } = scripted({ markdown: "# The Well\n\nMara reached the well.\n\n\n\nIt was dry." });
    const result = await draftChapterFromNotes(
      { book, chapter: { title: "The Well", notes: "Mara finds the well dry." }, previousChapterEnding: "…and so they set out.", targetWords: 9000 },
      { textModel }
    );
    expect(result).toEqual({ markdown: "Mara reached the well.\n\nIt was dry." });
    expect(requests[0]!.purpose).toBe("author-draft-chapter");
    expect(payload(requests[0]!)).toMatchObject({
      targetWords: 4000,
      layout: "flow",
      previousChapterEnding: "…and so they set out.",
      chapter: { title: "The Well", notes: "Mara finds the well dry." }
    });
  });

  it("clamps the target words", () => {
    expect(clampTargetWords(10)).toBe(300);
    expect(clampTargetWords(9000)).toBe(4000);
    expect(clampTargetWords(Number.NaN)).toBe(1500);
    expect(clampTargetWords(1234.4)).toBe(1234);
  });

  it("removes a first line that repeats the chapter title, and writes a picture book as pages", async () => {
    const { textModel, requests } = scripted({ markdown: "**The Fox**\n\nA fox woke up.\n\n<!-- page -->\n\nShe was hungry." });
    const result = await draftChapterFromNotes(
      { book: { ...book, kind: "picture" }, chapter: { title: "The Fox", notes: "" }, targetWords: 200 },
      { textModel }
    );
    expect(result.markdown).toBe("A fox woke up.\n\n<!-- page -->\n\nShe was hungry.");
    expect(payload(requests[0]!)).toMatchObject({ layout: "picture", targetWords: 300 });
  });

  it("asks once more at a wider budget when the reply was cut off", async () => {
    const { textModel, requests } = scripted(new Error("OpenAI response was incomplete: max_output_tokens"), { markdown: "It rained." });
    await expect(
      draftChapterFromNotes({ book, chapter: { title: "Rain", notes: "Rain." }, targetWords: 1500 }, { textModel })
    ).resolves.toEqual({ markdown: "It rained." });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.maxTokens).toBe(Math.ceil(requests[0]!.maxTokens! * 1.5));
  });

  it("refuses nothing to draft from, and reports an empty draft as unavailable", async () => {
    await expect(
      draftChapterFromNotes({ book, chapter: { title: " ", notes: "" }, targetWords: 1000 }, { textModel: scripted().textModel })
    ).rejects.toBeInstanceOf(AuthorAssistInputError);
    await expect(
      draftChapterFromNotes({ book, chapter: { title: "T", notes: "" }, targetWords: 1000 }, { textModel: scripted({ markdown: "## T" }).textModel })
    ).rejects.toBeInstanceOf(AuthorAssistUnavailableError);
  });
});

describe("reviewChapterForAuthor", () => {
  const markdown = "The well was dry.\n\n“We go back,” Mara said.\n\nThe night was long and cold and nobody slept.";

  it("verifies each quote against the chapter and orders notes by where they point", async () => {
    const { textModel, requests } = scripted({
      notes: [
        { quote: null, note: "The ending comes quickly.", severity: "suggestion" },
        { quote: 'The night was long  and cold', note: "Tell less here.", severity: "issue" },
        { quote: '"We go back," Mara said.', note: "Give Mara a beat first.", severity: "suggestion" },
        { quote: "A sentence that is not there.", note: "Invented quote.", severity: "issue" },
        { quote: "The well was dry.", note: "  ", severity: "issue" },
        { quote: "The well was dry.", note: "Strong opening.", severity: "odd" }
      ]
    });
    const { notes } = await reviewChapterForAuthor({ book, chapter: { title: "The Well", markdown } }, { textModel });
    expect(notes).toEqual([
      { quote: "The well was dry.", note: "Strong opening.", severity: "suggestion" },
      { quote: "“We go back,” Mara said.", note: "Give Mara a beat first.", severity: "suggestion" },
      { quote: "The night was long and cold", note: "Tell less here.", severity: "issue" },
      { quote: null, note: "The ending comes quickly.", severity: "suggestion" },
      { quote: null, note: "Invented quote.", severity: "issue" }
    ]);
    expect(requests[0]!.purpose).toBe("author-chapter-feedback");
  });

  it("keeps at most twelve notes and shows a very long chapter head and tail", async () => {
    const long = Array.from({ length: 12_000 }, (_, index) => `w${index}`).join(" ");
    const { textModel, requests } = scripted({
      notes: Array.from({ length: 20 }, (_, index) => ({ quote: null, note: `Note ${index}.`, severity: "suggestion" }))
    });
    const { notes } = await reviewChapterForAuthor({ book, chapter: { title: "Long", markdown: long } }, { textModel });
    expect(notes).toHaveLength(12);
    const shown = (payload(requests[0]!).chapter as { markdown: string }).markdown;
    expect(shown).toContain(CLIPPED_MIDDLE_MARKER);
    expect(shown.length).toBeLessThanOrEqual(60_000);
  });

  it("refuses an empty chapter and reports no usable note as unavailable", async () => {
    await expect(
      reviewChapterForAuthor({ book, chapter: { title: "Empty", markdown: "![pic](/assets/images/p/x.png)" } }, { textModel: scripted().textModel })
    ).rejects.toMatchObject({ code: "NOTHING_TO_READ" });
    await expect(
      reviewChapterForAuthor({ book, chapter: { title: "T", markdown } }, { textModel: scripted({ notes: [] }).textModel })
    ).rejects.toBeInstanceOf(AuthorAssistUnavailableError);
  });
});

describe("figures in the Studio's long assists", () => {
  const figure = '```figure\n{"kind":"bar","title":"Harbour traffic","categories":["1950","1960"],"series":[{"name":"Ships","values":[3,5]}]}\n```';

  it("never shows a draft a figure, and never keeps one it invents", async () => {
    const { textModel, requests } = scripted({ markdown: `The tide came in.\n\n${figure}\n\n[Figure: Harbour traffic]\n\nMara waited.` });
    const result = await draftChapterFromNotes(
      { book, chapter: { title: "The Tide", notes: "Mara waits." }, previousChapterEnding: `They counted ships.\n\n${figure}`, targetWords: 1500 },
      { textModel }
    );
    expect(result.markdown).toBe("The tide came in.\n\nMara waited.");
    expect(JSON.stringify(payload(requests[0]!))).not.toContain("figure");
    expect(payload(requests[0]!)).toMatchObject({ previousChapterEnding: "They counted ships." });
  });

  it("shows chapter feedback a figure's stand-in, never its JSON", async () => {
    const { textModel, requests } = scripted({ notes: [{ quote: "The tide came in.", note: "Good start.", severity: "suggestion" }] });
    const { notes } = await reviewChapterForAuthor(
      { book, chapter: { title: "The Tide", markdown: `The tide came in.\n\n${figure}\n\nMara waited.` } },
      { textModel }
    );
    expect(notes).toEqual([{ quote: "The tide came in.", note: "Good start.", severity: "suggestion" }]);
    const shown = JSON.stringify(payload(requests[0]!));
    expect(shown).toContain("[Figure: Harbour traffic]");
    expect(shown).not.toContain("categories");
  });
});

describe("checkBookConsistency", () => {
  const chapters = [
    { id: "c1", title: "One", markdown: "Mara was nine years old.\n\nHer eyes were grey." },
    { id: "c2", title: "Empty", markdown: "" },
    { id: "c3", title: "Three", markdown: "Mara, now twelve, looked back.\n\nHer green eyes narrowed." }
  ];

  it("maps chapter numbers to ids, re-homes a quote found elsewhere, and nulls one found nowhere", async () => {
    const { textModel, requests } = scripted({
      notes: [
        { chapterNumber: 3, quote: "Her green eyes narrowed.", note: "Eyes are grey in chapter 1.", severity: "issue" },
        { chapterNumber: 3, quote: "Mara was nine years old.", note: "Age jumps to twelve in chapter 3.", severity: "issue" },
        { chapterNumber: "1", quote: "Mara is ten.", note: "Unverifiable quote.", severity: "suggestion" },
        { chapterNumber: 42, quote: null, note: "No such chapter.", severity: "suggestion" },
        { chapterNumber: 3, quote: "Her green eyes narrowed.", note: "Eyes are grey in chapter 1.", severity: "issue" }
      ]
    });
    const { notes } = await checkBookConsistency({ book, chapters }, { textModel });
    expect(notes).toEqual([
      { quote: "Mara was nine years old.", note: "Age jumps to twelve in chapter 3.", severity: "issue", chapterId: "c1" },
      { quote: null, note: "Unverifiable quote.", severity: "suggestion", chapterId: "c1" },
      { quote: "Her green eyes narrowed.", note: "Eyes are grey in chapter 1.", severity: "issue", chapterId: "c3" },
      { quote: null, note: "No such chapter.", severity: "suggestion", chapterId: null }
    ]);
    expect(requests[0]!.purpose).toBe("author-consistency");
    const shown = payload(requests[0]!).chapters as Array<{ number: number }>;
    expect(shown.map((chapter) => chapter.number)).toEqual([1, 3]);
  });

  it("treats agreement as a valid, empty answer and refuses a book with no text", async () => {
    await expect(checkBookConsistency({ book, chapters }, { textModel: scripted({ notes: [] }).textModel })).resolves.toEqual({ notes: [] });
    await expect(
      checkBookConsistency({ book, chapters: [{ id: "x", title: "X", markdown: "  " }] }, { textModel: scripted().textModel })
    ).rejects.toMatchObject({ code: "NOTHING_TO_READ" });
  });

  it("clips each chapter, and shrinks the allowance when the book is long", () => {
    const big = "word ".repeat(4_000);
    const one = consistencyChapters([{ title: "Big", markdown: big }]);
    expect(one[0]!.clipped).toBe(true);
    expect(one[0]!.text.length).toBeLessThanOrEqual(CONSISTENCY_CHAPTER_CHARS);
    const many = consistencyChapters(Array.from({ length: 60 }, (_, index) => ({ title: `C${index}`, markdown: big })));
    const total = many.reduce((sum, chapter) => sum + chapter.text.length, 0);
    expect(total).toBeLessThanOrEqual(120_000);
    expect(many.every((chapter) => chapter.clipped)).toBe(true);
    const prose = consistencyChapters([{ title: "Img", markdown: "![a](/x.png)\n\nMara ran." }]);
    expect(prose[0]!.text).toBe("Mara ran.");
  });
});

describe("outlineAuthorBook", () => {
  it("returns cleaned chapters and passes on only the chapters the author touched", async () => {
    const { textModel, requests } = scripted({
      chapters: [
        { title: "## The Well", notes: "Mara finds the well dry." },
        { title: "", notes: "The caravan turns back." },
        { title: "", notes: "" },
        ...Array.from({ length: 25 }, (_, index) => ({ title: `Part ${index}`, notes: "More." }))
      ]
    });
    const result = await outlineAuthorBook(
      {
        book,
        premise: "A trader's daughter crosses the desert.",
        existingChapters: [
          { title: "Chapter 1", notes: "" },
          { title: "The Well", notes: "" }
        ]
      },
      { textModel }
    );
    expect(result.chapters).toHaveLength(20);
    expect(result.chapters[0]).toEqual({ title: "The Well", notes: "Mara finds the well dry." });
    expect(result.chapters[1]).toEqual({ title: "The caravan turns back.", notes: "The caravan turns back." });
    expect(requests[0]!.purpose).toBe("author-outline");
    expect(payload(requests[0]!)).toMatchObject({
      premise: "A trader's daughter crosses the desert.",
      existingChapters: [{ title: "The Well", notes: "" }]
    });
  });

  it("folds a picture book into one chapter of page beats", async () => {
    const { textModel } = scripted({
      chapters: [
        { title: "Page one", notes: "A fox wakes." },
        { title: "Page two", notes: "She is hungry.\nShe sniffs the air." }
      ]
    });
    const result = await outlineAuthorBook({ book: { ...book, title: "Fox", kind: "picture" } }, { textModel });
    expect(result).toEqual({ chapters: [{ title: "Fox", notes: "A fox wakes.\nShe is hungry.\nShe sniffs the air." }] });
  });

  it("falls back to the style profile's premise, and reports an empty outline as unavailable", async () => {
    const styleProfile = {
      voiceGuide: ["x"],
      antiAiRules: ["y"],
      tone: "t",
      pointOfView: "p",
      tense: "past",
      audience: "a",
      writingComplexity: 5,
      premise: "From the profile.",
      detectedLanguage: "en",
      sampleExcerpts: []
    };
    const { textModel, requests } = scripted({ chapters: [] });
    await expect(outlineAuthorBook({ book: { ...book, styleProfile } }, { textModel })).rejects.toBeInstanceOf(AuthorAssistUnavailableError);
    expect(payload(requests[0]!).premise).toBe("From the profile.");
  });
});
