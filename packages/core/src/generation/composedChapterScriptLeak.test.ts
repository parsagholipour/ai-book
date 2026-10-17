import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateTextOptions, TextResult } from "../adapters/types.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { developmentInput } from "./testing/bookDevelopmentFixtures.js";
import type { ChapterComposition } from "./chapterForms.js";
import type { AuthorStance } from "../schemas/plan.js";
import { editChapter, type ComposeChapterOptions } from "./composedChapter.js";

const input: CreateProjectInput = { ...developmentInput, prompt: "How royal fleets were built from Wealden oak.", category: "HISTORY", targetPages: 30, language: "en" };
const plan: BookPlan = {
  ...makeFallbackPlan(input),
  chapters: [
    { index: 1, title: "The Warrant", summary: "The first warrant.", keyBeats: ["The warrant"], targetPages: 10 },
    { index: 2, title: "The Forest", summary: "Timber accounts.", keyBeats: ["Felling"], targetPages: 10 },
    { index: 3, title: "The Launch", summary: "The ship afloat.", keyBeats: ["Launch"], targetPages: 10 }
  ]
};
const stance: AuthorStance = {
  thesis: "Royal fleets were built by credit and coercion, not by command.",
  positions: ["The forest, not the treasury, set the pace."],
  refusals: ["No paragraph ends by balancing two sides."],
  voiceSample: "The clerk counted the oaks before the king counted the ships."
};
const composition: ChapterComposition = {
  chapterIndex: 2,
  throughLine: "The forest sets the pace.",
  sections: [{ form: "mechanism", subject: "Carting to Southampton", share: 1, owns: ["carting rolls"] }],
  landing: "Carting cost more than felling.",
  avoid: []
};
const draft = Array.from({ length: 210 }, (_, index) => `Sentence ${index + 1} of the chapter carries one plain fact about the oaks and the carts.`).join(" ");

class EditingModel extends FakeTextModelAdapter {
  constructor(private readonly reply: string) { super(); }
  override async generateText(_options: GenerateTextOptions): Promise<TextResult> {
    return { text: this.reply, model: "fake", provider: "fake" };
  }
}

function options(reply: string, markdown = draft): ComposeChapterOptions & { markdown: string } {
  return {
    input, plan, stance, chapter: plan.chapters[1]!, composition, chapterPageStart: 11, chapterPageEnd: 20,
    earlierChapters: [], continuityNotes: [], researchNotes: [], textModel: new EditingModel(reply), contract: "creative", markdown
  };
}

describe("editChapter and leaked script", () => {
  it("keeps the draft when the edit brings in a word of another script", async () => {
    const leaky = draft.replace("Sentence 40 of the chapter", "Sentence 40 of the allocation制度 chapter");
    const result = await editChapter(options(leaky));
    expect(result.changed).toBe(false);
    expect(result.markdown).toBe(draft);
  });

  it("does not hold a leak the draft already had against the edit", async () => {
    const before = draft.replace("Sentence 40 of the chapter", "Sentence 40 of the allocation制度 chapter");
    const after = before.replace("Sentence 41 of the chapter", "Sentence 41 of this chapter");
    const result = await editChapter(options(after, before));
    expect(result.changed).toBe(true);
    expect(result.markdown).toContain("Sentence 41 of this chapter");
  });
});
