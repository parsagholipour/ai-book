import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateTextOptions, TextResult } from "../adapters/types.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { developmentInput } from "./testing/bookDevelopmentFixtures.js";
import type { ChapterEpisode, DossierExcerpt } from "../schemas/episodes.js";
import type { AuthorStance } from "../schemas/plan.js";
import { composeScene } from "./composeScene.js";

function project(category: "history" | "fiction"): { input: CreateProjectInput; plan: BookPlan } {
  const input: CreateProjectInput = { ...developmentInput, prompt: "The 1417 fleet at Southampton.", category: category === "history" ? "HISTORY" : "STORY", targetPages: 20, language: "en" };
  const plan: BookPlan = {
    ...makeFallbackPlan(input),
    writingMode: category === "history" ? "analytical-history" : "narrative",
    title: "Oak and Wages",
    premise: "How a fleet was built.",
    audience: "General readers",
    chapters: [{ index: 1, title: "The Forest", summary: "Timber accounts.", keyBeats: ["Felling"], targetPages: 20 }]
  };
  return { input, plan };
}

const stance: AuthorStance = {
  thesis: "Fleets were built by credit.",
  positions: ["Impressment paid better than wages."],
  refusals: [],
  voiceSample: "The clerk counted the oaks."
};

const episode: ChapterEpisode = {
  title: "Felling at Petworth",
  kind: "scene",
  person: "John Hoggekyn",
  place: "Petworth",
  date: "1417",
  document: "E 101 account",
  why: "The felling.",
  searchQueries: []
};

const excerpt: DossierExcerpt = {
  id: "x1",
  chapterIndex: 1,
  episodeTitle: episode.title,
  documentTitle: "E 101 account",
  documentUrl: "",
  host: "",
  author: "",
  year: "1417",
  speaker: "",
  text: "Paid to John Hoggekyn for felling forty oaks at Petworth, and for carting the same to Southampton.",
  words: 17
};

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");
}

class ScriptedModel extends FakeTextModelAdapter {
  calls: GenerateTextOptions[] = [];
  constructor(private readonly reply: string) {
    super();
  }
  override async generateText(options: GenerateTextOptions): Promise<TextResult> {
    this.calls.push(options);
    return { text: this.reply, model: "fake", provider: "fake" };
  }
}

describe("composeScene grounding for nonfiction", () => {
  it("makes no call when the episode has no passage of the record", async () => {
    const model = new ScriptedModel(words(500));
    const { input, plan } = project("history");
    const scene = await composeScene({ input, plan, stance, chapter: plan.chapters[0]!, episode, excerpts: [], contract: "creative", textModel: model });
    expect(scene).toBeUndefined();
    expect(model.calls).toHaveLength(0);
  });

  it("accepts a short grounded account in one call without asking for a minimum", async () => {
    const model = new ScriptedModel(words(90));
    const { input, plan } = project("history");
    const scene = await composeScene({ input, plan, stance, chapter: plan.chapters[0]!, episode, excerpts: [excerpt], contract: "creative", textModel: model });
    expect(model.calls).toHaveLength(1);
    expect(scene?.words).toBe(90);
    const system = model.calls[0]!.messages[0]!.content;
    expect(system).toContain("Write up to");
    expect(system).toContain("a short source warrants a short account");
    expect(system).not.toContain("aiming for");
    expect(system).not.toContain("let the grammar say so once");
    expect(system).not.toContain("draw on your own knowledge");
    expect(system).not.toContain("the reader is there");
  });

  it("returns nothing for thirty words after one call", async () => {
    const model = new ScriptedModel(words(30));
    const { input, plan } = project("history");
    const scene = await composeScene({ input, plan, stance, chapter: plan.chapters[0]!, episode, excerpts: [excerpt], contract: "grounded", textModel: model });
    expect(scene).toBeUndefined();
    expect(model.calls).toHaveLength(1);
  });

  it("still lets a narrative book tell a scene with no dossier", async () => {
    const model = new ScriptedModel(words(320));
    const { input, plan } = project("fiction");
    const scene = await composeScene({ input, plan, stance, chapter: plan.chapters[0]!, episode, excerpts: [], contract: "creative", textModel: model });
    expect(scene?.words).toBe(320);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.messages[0]!.content).toContain("aiming for");
  });
});
