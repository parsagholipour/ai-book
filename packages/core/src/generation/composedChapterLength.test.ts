import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { dossierExcerptSchema } from "../schemas/episodes.js";
import { fallbackChapterComposition, formPaletteFor } from "./chapterForms.js";
import { chapterWordBudget, composeChapter, editChapter, type ComposeChapterOptions } from "./composedChapter.js";

const input: CreateProjectInput = {
  prompt: "Explain public key cryptography with worked examples.", category: "SCIENCE",
  targetPages: 20, complexity: 7, temperature: 0.8, language: "en",
  mediaSettings: { fullIllustrations: false, illustrationCadence: "template-driven", includeCover: true,
    coverTemplate: "auto", finalReview: true, toneProfile: "neutral" }
};

const prose = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(" ");

function setup(pages = 4): ComposeChapterOptions {
  const plan = makeFallbackPlan(input);
  const chapter = { ...plan.chapters[0]!, targetPages: pages };
  return { input, plan, chapter,
    composition: fallbackChapterComposition({ chapter, startPage: 1, endPage: pages }, formPaletteFor("analytical-history"), 0),
    stance: { thesis: "Keys permit public exchange.", positions: [], refusals: [], voiceSample: "" },
    chapterPageStart: 1, chapterPageEnd: pages, earlierChapters: [], continuityNotes: [], researchNotes: [],
    textModel: new FakeTextModelAdapter(input) };
}

describe("audited chapter length shortfalls", () => {
  it.each([
    { tier: "Balanced", pages: 4, draftWords: 1498 },
    { tier: "Quick", pages: 5, draftWords: 1779 },
    { tier: "Ultra chapter 2", pages: 4, draftWords: 1540 },
    { tier: "Ultra chapter 3", pages: 4, draftWords: 1266 }
  ])("retries $tier at its actual minimum before paginating", async ({ pages, draftWords }) => {
    const options = setup(pages);
    const min = chapterWordBudget(input, pages).min;
    const generate = vi.spyOn(options.textModel, "generateText")
      .mockResolvedValueOnce({ text: prose(draftWords), model: "fake", provider: "fake" })
      .mockResolvedValueOnce({ text: prose(min), model: "fake", provider: "fake" });
    const result = await composeChapter(options);
    expect(result.words).toBeGreaterThanOrEqual(min);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it.each([
    { before: 1498, after: 1370 },
    { before: 1800, after: 1700 }
  ])("keeps an ordinary edit from reducing $before words to $after below the floor", async ({ before, after }) => {
    const options = setup();
    vi.spyOn(options.textModel, "generateText").mockResolvedValue({ text: prose(after), model: "fake", provider: "fake" });
    const result = await editChapter({ ...options, markdown: prose(before), semanticAcceptance: false });
    expect(result.changed).toBe(false);
    expect(result.words).toBe(before);
  });

  it("still accepts a targeted factual deletion even when it leaves a shortage", async () => {
    const options = setup();
    vi.spyOn(options.textModel, "generateText").mockResolvedValue({ text: prose(1370), model: "fake", provider: "fake" });
    const result = await editChapter({ ...options, markdown: prose(1498), semanticAcceptance: false,
      factualCorrection: { instructions: ["Delete unsupported details."], evidence: [] } });
    expect(result.changed).toBe(true);
    expect(result.words).toBe(1370);
  });

  it("keeps the longer supported draft and stops after one retry if both remain short", async () => {
    const options = setup();
    const generate = vi.spyOn(options.textModel, "generateText")
      .mockResolvedValueOnce({ text: prose(1498), model: "fake", provider: "fake" })
      .mockResolvedValueOnce({ text: prose(1370), model: "fake", provider: "fake" });
    const result = await composeChapter(options);
    expect(result.words).toBe(1498);
    expect(result.attempts).toBe(2);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not retry a draft at its minimum", async () => {
    const options = setup();
    const generate = vi.spyOn(options.textModel, "generateText").mockResolvedValue({ text: prose(1720), model: "fake", provider: "fake" });
    expect((await composeChapter(options)).words).toBe(1720);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("counts the separate opening scene toward the minimum", async () => {
    const options = setup();
    options.material = { episodes: [], excerpts: [dossierExcerptSchema.parse({ id: "record", chapterIndex: 1,
      documentTitle: "Original record", documentUrl: "https://example.org/record", text: "The record describes the opening episode.", provenanceVerified: true })],
      scene: { text: prose(300), words: 300, episodeTitle: "Opening" } };
    const generate = vi.spyOn(options.textModel, "generateText").mockResolvedValue({ text: prose(1420), model: "fake", provider: "fake" });
    expect((await composeChapter(options)).words).toBe(1420);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("accepts supported editorial growth even if the chapter is still below minimum", async () => {
    const options = setup();
    vi.spyOn(options.textModel, "generateText").mockResolvedValue({ text: prose(1646), model: "fake", provider: "fake" });
    expect(await editChapter({ ...options, markdown: prose(1540), semanticAcceptance: false })).toMatchObject({ changed: true, words: 1646 });
  });
});
