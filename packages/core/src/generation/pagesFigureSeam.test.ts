import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput, PageDraft } from "../schemas/book.js";
import { generateBatchDraft, generateChapterDraft, generatePageDraft, generateWholeBookDraft, polishPageDraft } from "./pages.js";
import { revisePageDraft } from "./pagesReview.js";

/**
 * The per-page draft seam: a page writer is never shown the figure syntax,
 * so whatever fence or stand-in line its reply carries is removed where the
 * draft is parsed — before any review, audit or revision reads it. A revise
 * asked to keep figures (`figures: "keep"`) is the chat rewrite whose request
 * names the page's figure. A revise asked to hold them (`figures: "hold"`)
 * strips invented fences and keeps `[Figure: …]` stand-ins. Kept apart from
 * `pages.test.ts`, which is at the file-size budget.
 */
const input: CreateProjectInput = {
  prompt: "A practical history of city water systems.",
  category: "EDUCATION",
  targetPages: 12,
  complexity: 6,
  temperature: 0.4,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "scholarly"
  }
};
const plan = makeFallbackPlan(input);
const fence =
  "```figure\n" +
  JSON.stringify({ kind: "bar", title: "Carts by decade", categories: ["1500", "1510"], series: [{ name: "Carts", values: [120, 140] }], source: "The ledger" }) +
  "\n```";
const prose = "The clerks counted the carts at the north gate.";
const closing = "The towns felt the change first.";
const dirty = `${prose}\n\n${fence}\n\n[Figure: Carts by decade]\n\n${closing}`;
const clean = `${prose}\n\n${closing}`;

function modelReturning(markdown: string): TextModelAdapter {
  return {
    async generateText() {
      return { text: "", model: "test-model", provider: "test" };
    },
    async *streamText() {
      yield "";
    },
    generateWithTools: unsupportedGenerateWithTools,
    async generateJson<T>(options: GenerateJsonOptions<T>) {
      const data = options.schema.parse({ title: "The North Gate", markdown, summary: "Carts and tolls.", continuityNotes: [] });
      return { data, text: JSON.stringify(data), model: "test-model", provider: "test" };
    }
  };
}

/** A bulk writer's reply: every page carries the fence and the stand-in. */
function bulkModelReturning(indexes: number[], extras?: { markdown?: string; omitSummary?: boolean }): TextModelAdapter {
  const markdown = extras?.markdown ?? dirty;
  return {
    async generateText() {
      return { text: "", model: "test-model", provider: "test" };
    },
    async *streamText() {
      yield "";
    },
    generateWithTools: unsupportedGenerateWithTools,
    async generateJson<T>(options: GenerateJsonOptions<T>) {
      const data = options.schema.parse({
        pages: indexes.map((index) => ({
          index,
          title: `Turn ${index}`,
          markdown,
          ...(extras?.omitSummary ? {} : { summary: `Page ${index} summary.` }),
          continuityNotes: []
        }))
      });
      return { data, text: JSON.stringify(data), model: "test-model", provider: "test" };
    }
  };
}

const draft: PageDraft = { title: "The North Gate", markdown: clean, summary: "Carts and tolls.", continuityNotes: [] };
const report = { approved: false, score: 40, issues: ["Flat."], requiredRevisions: ["Sharpen."], notes: "", groundedOk: true, unsupportedClaims: [], checks: { placeholderFree: true, promptLeakFree: true, titleClean: true, repetitionOk: true, progressionOk: false, styleNatural: true } };

describe("per-page drafts and figure blocks", () => {
  it("returns a draft with neither the fence nor the stand-in the writer put in it", async () => {
    const generated = await generatePageDraft({ input, plan, pageIndex: 3, previousSummaries: [], previousPages: [], continuityNotes: [], researchNotes: [], textModel: modelReturning(dirty) });
    expect(generated.markdown).toBe(clean);
    const polished = await polishPageDraft({ input, plan, pageIndex: 3, draft, previousPages: [], nextPages: [], continuityNotes: [], researchNotes: [], textModel: modelReturning(dirty) });
    expect(polished.markdown).toBe(clean);
    const revised = await revisePageDraft({ input, plan, pageIndex: 3, draft, report, previousPages: [], continuityNotes: [], textModel: modelReturning(dirty) });
    expect(revised.markdown).toBe(clean);
  });

  it("returns the bulk writers' pages the same way: whole book, chapter and batch", async () => {
    const short = { ...input, targetPages: 2 };
    const shortPlan = makeFallbackPlan(short);
    const whole = await generateWholeBookDraft({ input: short, plan: shortPlan, researchNotes: [], textModel: bulkModelReturning([1, 2]) });
    expect(whole.pages.map((page) => page.markdown)).toEqual([clean, clean]);
    const chapter = await generateChapterDraft({
      input: short,
      plan: shortPlan,
      chapter: shortPlan.chapters[0]!,
      chapterPageStart: 1,
      chapterPageEnd: 2,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: bulkModelReturning([1, 2])
    });
    expect(chapter.pages.map((page) => page.markdown)).toEqual([clean, clean]);
    const batch = await generateBatchDraft({
      input: short,
      plan: shortPlan,
      chapterBriefs: [],
      pageStart: 1,
      pageEnd: 2,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: bulkModelReturning([1, 2])
    });
    expect(batch.pages.map((page) => page.markdown)).toEqual([clean, clean]);
  });

  it("derives a whole-book summary from figure-free markdown", async () => {
    const short = { ...input, targetPages: 1 };
    const whole = await generateWholeBookDraft({
      input: short,
      plan: makeFallbackPlan(short),
      researchNotes: [],
      textModel: bulkModelReturning([1], { markdown: `${fence}\n\n${prose}`, omitSummary: true })
    });
    expect(whole.pages[0]?.summary).toMatch(/clerks counted/);
    expect(whole.pages[0]?.summary).not.toMatch(/\{|"kind"|```figure|"categories"|"series"/);
  });

  it("keeps the figure only on a revise that asks for it", async () => {
    const kept = await revisePageDraft({ input, plan, pageIndex: 3, draft, report, previousPages: [], continuityNotes: [], textModel: modelReturning(`${prose}\n\n${fence}\n\n${closing}`), figures: "keep" });
    expect(kept.markdown).toBe(`${prose}\n\n${fence}\n\n${closing}`);
  });

  it("keeps the stand-in and drops an invented fence when a revise holds figures aside", async () => {
    const held = await revisePageDraft({ input, plan, pageIndex: 3, draft, report, previousPages: [], continuityNotes: [], textModel: modelReturning(dirty), figures: "hold" });
    expect(held.markdown).toBe(`${prose}\n\n[Figure: Carts by decade]\n\n${closing}`);
    expect(held.markdown).not.toContain("```figure");
  });
});
