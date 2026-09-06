import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions, GenerateTextOptions, JsonResult, TextResult } from "../adapters/types.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { developmentInput } from "./testing/bookDevelopmentFixtures.js";
import type { AuthorStance } from "../schemas/plan.js";
import { bookEpisodesSchema, type ChapterFocus, type DossierExcerpt } from "../schemas/episodes.js";
import { planChapterForms, type ChapterComposition } from "./chapterForms.js";
import { chapterWordBudget, composeChapter, editChapter, type ComposeChapterOptions } from "./composedChapter.js";
import { chapterFocusLines } from "./composedChapterMaterial.js";

const input: CreateProjectInput = {
  ...developmentInput,
  prompt: "How did medieval English shipwrights source timber and labour for royal fleets?",
  category: "HISTORY",
  targetPages: 30,
  language: "en"
};

const plan: BookPlan = {
  ...makeFallbackPlan(input),
  writingMode: "analytical-history",
  title: "Oak and Wages",
  premise: "Royal fleets were built by credit and coercion, not by command.",
  audience: "General readers of history",
  chapters: [
    { index: 1, title: "The Warrant", summary: "The first warrant.", keyBeats: ["The warrant"], targetPages: 10 },
    { index: 2, title: "The Forest", summary: "Timber accounts.", keyBeats: ["Felling", "Carting"], targetPages: 10 },
    { index: 3, title: "The Launch", summary: "The ship afloat.", keyBeats: ["Launch"], targetPages: 10 }
  ]
};

const stance: AuthorStance = {
  thesis: "Royal fleets were built by credit and coercion, not by command.",
  positions: ["Impressment paid better than wages.", "The forest, not the treasury, set the pace."],
  refusals: ["No paragraph ends by balancing two sides."],
  voiceSample: "The clerk counted the oaks before the king counted the ships."
};

const focus: ChapterFocus = {
  question: "How was oak for the 1417 fleet found, felled and carted from the Weald to Southampton?",
  investigation: ["the sequence of purveyance decisions", "the carting costs against the wage rolls", "why Sussex oak and not Hampshire"],
  contribution: "the difference between purveyance and purchase in the accounts",
  alreadyEstablished: ["the warrant of 1415 named its officers"]
};

const composition: ChapterComposition = {
  chapterIndex: 2,
  throughLine: "The forest sets the pace.",
  sections: [
    { form: "scene", subject: "Felling at Petworth", share: 0.5, owns: ["Petworth accounts"] },
    { form: "mechanism", subject: "Carting to Southampton", share: 0.5, owns: ["carting rolls"] }
  ],
  landing: "Carting cost more than felling.",
  avoid: []
};

const longProse = Array.from({ length: 210 }, (_, index) => `Sentence ${index + 1} of the chapter carries one plain fact about the oaks and the carts and the men who moved them.`).join(" ");

class CapturingModel extends FakeTextModelAdapter {
  textCalls: GenerateTextOptions[] = [];
  jsonCalls: GenerateJsonOptions<unknown>[] = [];
  override async generateText(options: GenerateTextOptions): Promise<TextResult> {
    this.textCalls.push(options);
    return { text: longProse, model: "fake", provider: "fake" };
  }
  override async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    this.jsonCalls.push(options);
    return { data: options.schema.parse({ chapters: [] }), text: "{}", model: "fake", provider: "fake" };
  }
}

const excerpt: DossierExcerpt = {
  id: "petworth-roll-1",
  chapterIndex: 2,
  episodeTitle: "Felling at Petworth",
  documentTitle: "Petworth account roll",
  documentUrl: "",
  host: "",
  author: "",
  year: "1417",
  speaker: "",
  text: "Paid to the sawyers for felling forty oaks in Petworth park, 26s 8d.",
  words: 13
};

const measurementNote = "negation rate 45 per thousand sentences, ceiling 30: \"The roll does not say who carted them.\"";
const readerNote = "Cut the closing comparison of Petworth with the Hampshire woods.";

function composeOptions(model: CapturingModel, withFocus: boolean, excerpts: DossierExcerpt[] = []): ComposeChapterOptions {
  const chapter = plan.chapters[1]!;
  return {
    input,
    plan,
    stance,
    chapter,
    composition,
    chapterPageStart: 11,
    chapterPageEnd: 20,
    earlierChapters: [],
    continuityNotes: [],
    researchNotes: [],
    textModel: model,
    contract: "creative",
    material: {
      episodes: [{ title: "Felling at Petworth", kind: "scene", person: "John Hoggekyn", place: "Petworth", date: "1417", document: "E 101 account", why: "The felling.", searchQueries: [] }],
      excerpts,
      ...(withFocus ? { focus } : {})
    }
  };
}

describe("chapter focus schema", () => {
  it("keeps focus and parses episodes planned without one", () => {
    const parsed = bookEpisodesSchema.parse({
      chapters: [
        { index: 1, episodes: [] },
        { index: 2, episodes: [], focus: { question: focus.question, investigation: focus.investigation, contribution: focus.contribution } }
      ]
    });
    expect(parsed.chapters[0]!.focus).toBeUndefined();
    expect(parsed.chapters[1]!.focus?.question).toBe(focus.question);
    expect(parsed.chapters[1]!.focus?.alreadyEstablished).toEqual([]);
    expect(bookEpisodesSchema.parse(parsed)).toEqual(parsed);
  });
});

describe("chapter focus lines", () => {
  it("says nothing about a new contribution when the plan contract blanked it", () => {
    const withContribution = chapterFocusLines({ material: { episodes: [], excerpts: [], focus } }).join(" ");
    expect(withContribution).toContain("The new contribution is");
    const blanked = chapterFocusLines({ material: { episodes: [], excerpts: [], focus: { ...focus, contribution: "  " } } }).join(" ");
    expect(blanked).not.toContain("The new contribution is");
    expect(blanked).toContain(focus.investigation.join(" | "));
  });
});

describe("the writer's style notes", () => {
  const voiceGuide = [
    "Use clear historical prose for general readers, with concrete scenes, artifacts, institutions, and decisions carrying the explanation.",
    "Separate what evidence shows from what scholars infer, especially when archaeological remains cannot reveal motives.",
    "Use moderate confidence. Name competing interpretations when the available evidence supports more than one reading."
  ];

  it("omits the method rules and keeps the rest", async () => {
    const model = new CapturingModel();
    const options = composeOptions(model, true);
    await composeChapter({ ...options, plan: { ...plan, voiceGuide } });
    const payload = JSON.parse(model.textCalls[0]!.messages[1]!.content);
    expect(payload.book.styleNotes).toEqual([voiceGuide[0]]);
  });
});

describe("chapter focus in the form planner", () => {
  it("reaches the planner's caseAssignments payload with its rule", async () => {
    const model = new CapturingModel();
    await planChapterForms({
      input,
      plan,
      stance,
      ranges: plan.chapters.map((chapter, offset) => ({ chapter, startPage: offset * 10 + 1, endPage: offset * 10 + 10 })),
      episodes: { chapters: [{ index: 1, episodes: [] }, { index: 2, episodes: [], focus }, { index: 3, episodes: [] }] },
      textModel: model
    });
    const first = model.jsonCalls[0]!;
    const payload = JSON.parse(first.messages.find((message) => message.role === "user")!.content);
    expect(payload.caseAssignments[1]!.focus).toEqual(focus);
    expect(payload.caseAssignments[0]!.focus).toBeUndefined();
    expect(first.messages[0]!.content).toContain("A chapter with focus investigates that specific question");
  });
});

describe("chapter focus in the writer's prompts", () => {
  it("gives a middle chapter its question and withholds the global thesis", async () => {
    const model = new CapturingModel();
    await composeChapter(composeOptions(model, true));
    await editChapter({ ...composeOptions(model, true), markdown: longProse });
    expect(model.textCalls).toHaveLength(2);
    for (const call of model.textCalls) {
      const system = call.messages[0]!.content;
      expect(system).toContain(`This chapter investigates: ${focus.question}`);
      expect(system).toContain(focus.investigation.join(" | "));
      expect(system).toContain("a plausible detail is not a witnessed fact");
      expect(system).not.toContain(stance.thesis);
      for (const position of stance.positions) expect(system).not.toContain(position);
      const payload = JSON.parse(call.messages[1]!.content);
      expect(payload.focus).toEqual(focus);
      if (payload.book) {
        expect(payload.book.premise).toBe(focus.question);
        expect(payload.book.promises).toEqual([]);
      }
    }
    expect(model.textCalls[0]!.messages[0]!.content).toContain("a plausible detail is not a witnessed fact");
    expect(model.textCalls[0]!.messages[0]!.content).not.toContain("reconstructed from what the record makes likely");
  });

  it("keeps the legacy stance when the same chapter has no focus", async () => {
    const model = new CapturingModel();
    await composeChapter(composeOptions(model, false));
    const system = model.textCalls[0]!.messages[0]!.content;
    expect(system).toContain(stance.thesis);
    expect(system).not.toContain("This chapter investigates:");
    const payload = JSON.parse(model.textCalls[0]!.messages[1]!.content);
    expect(payload.book.premise).toBe(plan.premise);
    expect(payload.focus).toBeUndefined();
  });
});

describe("focused chapters follow their investigation, not the form quotas", () => {
  const formSubject = composition.sections[1]!.subject;

  it("drops form quotas, shape targets and measurements from the writer and the editor with a focus", async () => {
    const model = new CapturingModel();
    await composeChapter(composeOptions(model, true, [excerpt]));
    await editChapter({ ...composeOptions(model, true, [excerpt]), markdown: longProse, measurementNotes: [measurementNote], readerNotes: [readerNote] });
    expect(model.textCalls).toHaveLength(2);
    for (const call of model.textCalls) {
      const system = call.messages[0]!.content;
      expect(system).not.toContain(formSubject);
      expect(system).not.toContain("two hundred words or more");
      expect(system).not.toContain("It can show X");
      expect(system).not.toContain(measurementNote);
      expect(system).toContain("a plausible detail is not a witnessed fact");
      expect(system).toContain("Keep consequential sequences together");
      expect(system.split("Use the chapter's full word budget for substantive development")).toHaveLength(2);
      const payload = JSON.parse(call.messages[1]!.content);
      expect(payload.episodes).toHaveLength(1);
      expect(payload.focus).toEqual(focus);
      expect(payload.wordBudget).toEqual(chapterWordBudget(input, 10));
      expect(payload.dossier).toEqual([{ id: excerpt.id, document: excerpt.documentTitle, year: excerpt.year, text: excerpt.text }]);
      expect(Object.keys(payload)).not.toContain("measurementNotes");
    }
    const composeSystem = model.textCalls[0]!.messages[0]!.content;
    expect(composeSystem).toContain("not a checklist of equally long case studies");
    expect(composeSystem).not.toContain("Give each episode a real stretch of the chapter");
    expect(composeSystem).not.toContain("may appear at most three times in the chapter");
    expect(Object.keys(JSON.parse(model.textCalls[0]!.messages[1]!.content))).not.toContain("composition");
    const editSystem = model.textCalls[1]!.messages[0]!.content;
    expect(editSystem).not.toContain("Reshape paragraphs wherever");
    expect(editSystem).not.toContain("Only the chapter's final paragraph");
    expect(editSystem).toContain("Keep every fact, name, date, number, place and quotation");
    expect(editSystem).toContain("Cut what a reader would skim");
    expect(editSystem).toContain(readerNote);
    expect(JSON.parse(model.textCalls[1]!.messages[1]!.content).readerNotes).toEqual([readerNote]);
  });

  it("keeps the composition, the shape rules and the measurements without a focus", async () => {
    const model = new CapturingModel();
    await composeChapter(composeOptions(model, false));
    await editChapter({ ...composeOptions(model, false), markdown: longProse, measurementNotes: [measurementNote], readerNotes: [readerNote] });
    expect(model.textCalls).toHaveLength(2);
    for (const call of model.textCalls) {
      const system = call.messages[0]!.content;
      expect(system).toContain(formSubject);
      expect(system).toContain("two hundred words or more");
      expect(system).toContain("It can show X");
      expect(system).not.toContain("Keep consequential sequences together");
    }
    const composePayload = JSON.parse(model.textCalls[0]!.messages[1]!.content);
    expect(composePayload.composition.sections[1].subject).toBe(formSubject);
    expect(composePayload.wordBudget).toEqual(chapterWordBudget(input, 10));
    expect(model.textCalls[0]!.messages[0]!.content).toContain("Give each episode a real stretch of the chapter");
    const editSystem = model.textCalls[1]!.messages[0]!.content;
    expect(editSystem).toContain(measurementNote);
    expect(editSystem).toContain(readerNote);
    expect(JSON.parse(model.textCalls[1]!.messages[1]!.content).measurementNotes).toEqual([measurementNote]);
  });
});
