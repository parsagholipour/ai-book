import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema, type CreateProjectInput } from "../schemas/book.js";
import type { ChapterEpisode, DossierExcerpt } from "../schemas/episodes.js";
import type { ChapterComposition } from "./chapterForms.js";
import { composeChapter, editChapter } from "./composedChapter.js";
import { FOCUSED_RECONSTRUCTION_RULE, type ChapterMaterial } from "./composedChapterMaterial.js";
import { composeScene } from "./composeScene.js";
import {
  HISTORY_DOSSIER_RULE,
  HISTORY_QUESTION_RULE,
  HISTORY_RECONSTRUCTION_RULE,
  HISTORY_SCENE_DOSSIER_RULE,
  HISTORY_SOURCE_RULE,
  UNFETCHED_SECTION_NOTE,
  passageSource,
  withoutUnfetchedReadings
} from "./historySources.js";

// The legacy lines every other kind of book still gets, spelled out so an edit
// to the history wording cannot quietly move them.
const LEGACY_SOURCE_LINE =
  "The dossier's passages are primary sources: when you quote, quote them exactly and name the document, and let their particulars carry the chapter.";
const LEGACY_DOSSIER_LINE = "`dossier` holds verbatim passages from primary sources, each with the document it comes from.";
const LEGACY_SHAPE_LINE = "State what a source shows and use it.";
const LEGACY_SCENE_TELL = "as an account in time: the recorded actors, what they did, and what followed, in the order the record gives it.";
const LEGACY_SCENE_DOSSIER = "`dossier` holds verbatim passages from the record of this episode. Quote from them with quotation marks and the document named";
const LEGACY_SCENE_USE = "Use the episode's document and the research notes; do not invent named people or documents.";
const LEGACY_SCENE_FORM = "a documented episode from a named source or site";

type Kind = "history" | "guide" | "story";
const PROMPTS: Record<Kind, { prompt: string; category: CreateProjectInput["category"] }> = {
  history: { prompt: "A history of the Suez Canal blockage of 2021.", category: "HISTORY" },
  guide: { prompt: "How to plan an import schedule, step by step.", category: "EDUCATION" },
  story: { prompt: "A novel about a harbour pilot.", category: "STORY" }
};

function book(kind: Kind) {
  const input = createProjectSchema.parse({ ...PROMPTS[kind], targetPages: 20, complexity: 5, language: "en" });
  const plan = makeFallbackPlan(input);
  return { input, plan, chapter: plan.chapters[0]! };
}

const stance = { thesis: "Canals are single points of failure.", positions: [], refusals: [], voiceSample: "Plain prose." };

function episode(title: string, kind: ChapterEpisode["kind"], document: string): ChapterEpisode {
  return { title, kind, person: "", place: "Suez", date: "2021", document, why: "", searchQueries: [] };
}

const blockage = episode("Ever Given blocks the Suez Canal", "scene", "Suez Canal Authority statements on the refloating");
const docks = episode("The old London docks close", "document", "London Docklands Development Corporation, annual reports and historical records on the closure and redevelopment of the docks");

function excerpt(fields: Partial<DossierExcerpt>): DossierExcerpt {
  return {
    id: "ch1-x1",
    chapterIndex: 1,
    episodeTitle: blockage.title,
    documentTitle: "usda.gov",
    documentUrl: "https://apps.fas.usda.gov/report.pdf",
    host: "web",
    author: "",
    year: "",
    speaker: "Ahmed Wally, USDA Foreign Agricultural Service staff (author not named)",
    text: "At least 422 boats were waiting to transit, including container ships and bulk carriers.",
    words: 14,
    ...fields
  };
}

const material: ChapterMaterial = { episodes: [blockage, docks], excerpts: [excerpt({})] };

function composition(chapterIndex: number): ChapterComposition {
  return {
    chapterIndex,
    throughLine: "One ship stops a route",
    sections: [
      { form: "scene", subject: "The Ever Given blocks the Suez Canal in March 2021", share: 0.5, owns: ["The Ever Given blockage"] },
      {
        form: "close-reading",
        subject: "What London Docklands redevelopment records reveal about the urban response",
        share: 0.5,
        owns: ["The redevelopment evidence in London Docklands Development Corporation records", "The shift of port work downriver"]
      }
    ],
    landing: "A route is a promise",
    avoid: []
  };
}

async function composePrompt(kind: Kind, options: { material?: ChapterMaterial } = {}) {
  const { input, plan, chapter } = book(kind);
  const textModel = new FakeTextModelAdapter(input);
  const calls = vi.spyOn(textModel, "generateText");
  await composeChapter({
    input, plan, chapter, stance, composition: composition(chapter.index), chapterPageStart: 1, chapterPageEnd: 4,
    earlierChapters: [], continuityNotes: [], researchNotes: [], contract: "creative", material: options.material ?? material, textModel
  });
  const messages = calls.mock.calls[0]![0].messages;
  return { system: String(messages[0]!.content), payload: JSON.parse(String(messages[1]!.content)) };
}

async function editPrompt(kind: Kind) {
  const { input, plan, chapter } = book(kind);
  const textModel = new FakeTextModelAdapter(input);
  const calls = vi.spyOn(textModel, "generateText");
  await editChapter({
    input, plan, chapter, stance, composition: composition(chapter.index), chapterPageStart: 1, chapterPageEnd: 4,
    earlierChapters: [], continuityNotes: [], researchNotes: [], contract: "creative", material, textModel,
    markdown: "The Ever Given ran aground on 23 March 2021."
  });
  const messages = calls.mock.calls[0]![0].messages;
  return { system: String(messages[0]!.content), payload: JSON.parse(String(messages[1]!.content)) };
}

async function scenePrompt(kind: Kind) {
  const { input, plan, chapter } = book(kind);
  const textModel = new FakeTextModelAdapter(input);
  const calls = vi.spyOn(textModel, "generateText");
  await composeScene({ input, plan, stance, chapter, episode: blockage, excerpts: material.excerpts, contract: "creative", textModel });
  const messages = calls.mock.calls[0]![0].messages;
  return { system: String(messages[0]!.content), payload: JSON.parse(String(messages[1]!.content)) };
}

describe("passageSource", () => {
  const web = { host: "web", documentTitle: "Port Newark: How Malcom McLean Changed the World", author: "", year: "" };

  it("names a web passage's speaker without the extractor's parenthesis, and never its page title", () => {
    expect(passageSource({ ...web, speaker: "Maritimafrica (author not named)" })).toBe("Maritimafrica");
    expect(passageSource({ ...web, speaker: "Anthony Mayo and Nitin Nohria" })).toBe("Anthony Mayo and Nitin Nohria");
    expect(passageSource({ ...web, speaker: "" })).toBe("");
  });

  it("names a catalogue work by author and title, with a year only when the catalogue gave one", () => {
    const gutenberg = { host: "gutenberg", documentTitle: "The Wealth of Nations", speaker: "" };
    expect(passageSource({ ...gutenberg, author: "Smith, Adam", year: "b. 1723" })).toBe("Adam Smith, The Wealth of Nations");
    expect(passageSource({ host: "archive", documentTitle: "Petworth account roll", speaker: "", author: "", year: "1417" })).toBe("Petworth account roll, 1417");
  });

  it("never passes on an address", () => {
    expect(passageSource({ ...web, speaker: "usda.gov staff" })).toBe("staff");
    expect(passageSource({ ...web, speaker: "https://www.fmc.gov/testimony" })).toBe("");
    expect(passageSource({ host: "", documentTitle: "iteh.ai", speaker: "", author: "", year: "" })).toBe("");
  });
});

describe("a history book's sources in the compose call", () => {
  it("hands the writer who said each passage, never its title or address, and the positive attribution rule", async () => {
    const { system, payload } = await composePrompt("history");
    expect(system).toContain(HISTORY_SOURCE_RULE);
    expect(system).toContain(HISTORY_DOSSIER_RULE);
    expect(system).toContain(HISTORY_RECONSTRUCTION_RULE);
    expect(system).toContain(HISTORY_QUESTION_RULE);
    for (const legacy of [LEGACY_SOURCE_LINE, LEGACY_DOSSIER_LINE, LEGACY_SHAPE_LINE, FOCUSED_RECONSTRUCTION_RULE, LEGACY_SCENE_FORM]) {
      expect(system).not.toContain(legacy);
    }
    expect(payload.dossier).toEqual([{ id: "ch1-x1", source: "Ahmed Wally, USDA Foreign Agricultural Service staff", text: material.excerpts[0]!.text }]);
    expect(JSON.stringify(payload)).not.toContain("usda.gov");
  });

  it("tells an unfetched episode's reading as a mechanism, without the line that names its document", async () => {
    const { payload } = await composePrompt("history");
    expect(payload.composition.sections).toEqual([
      expect.objectContaining({ form: "scene", owns: ["The Ever Given blockage"] }),
      expect.objectContaining({ form: "mechanism", owns: ["The shift of port work downriver"], note: UNFETCHED_SECTION_NOTE })
    ]);
  });

  it("gives the line editor the same rules and dossier", async () => {
    const { system, payload } = await editPrompt("history");
    expect(system).toContain(HISTORY_SOURCE_RULE);
    expect(system).toContain(HISTORY_RECONSTRUCTION_RULE);
    expect(system).not.toContain(LEGACY_SOURCE_LINE);
    expect(system).not.toContain(FOCUSED_RECONSTRUCTION_RULE);
    expect(payload.dossier[0]).not.toHaveProperty("document");
    expect(payload.dossier[0]).not.toHaveProperty("url");
  });
});

describe("every other kind of book keeps its source prompt", () => {
  it("a guide's compose and edit calls carry the legacy lines, dossier fields and forms", async () => {
    const compose = await composePrompt("guide");
    for (const legacy of [LEGACY_SOURCE_LINE, LEGACY_DOSSIER_LINE, LEGACY_SHAPE_LINE, FOCUSED_RECONSTRUCTION_RULE]) {
      expect(compose.system).toContain(legacy);
    }
    for (const history of [HISTORY_SOURCE_RULE, HISTORY_DOSSIER_RULE, HISTORY_RECONSTRUCTION_RULE]) {
      expect(compose.system).not.toContain(history);
    }
    expect(compose.payload.dossier[0]).toEqual({
      id: "ch1-x1",
      document: "usda.gov",
      url: "https://apps.fas.usda.gov/report.pdf",
      speaker: "Ahmed Wally, USDA Foreign Agricultural Service staff (author not named)",
      text: material.excerpts[0]!.text
    });
    expect(compose.payload.composition.sections.map((section: { form: string }) => section.form)).toEqual(["scene", "close-reading"]);
    const edit = await editPrompt("guide");
    expect(edit.system).toContain(LEGACY_SOURCE_LINE);
    expect(edit.system).toContain(FOCUSED_RECONSTRUCTION_RULE);
    expect(edit.payload.dossier[0]).toHaveProperty("document", "usda.gov");
  });

  it("a novel gets none of the history wording", async () => {
    const { system, payload } = await composePrompt("story");
    for (const history of [HISTORY_SOURCE_RULE, HISTORY_DOSSIER_RULE, HISTORY_RECONSTRUCTION_RULE]) {
      expect(system).not.toContain(history);
    }
    expect(system).toContain(LEGACY_SHAPE_LINE);
    expect(payload.dossier[0]).toHaveProperty("document", "usda.gov");
    expect(payload.composition.sections.map((section: { form: string }) => section.form)).toEqual(["scene", "close-reading"]);
  });
});

describe("the opening scene's sources", () => {
  it("a history scene tells events from passages that carry only who said them", async () => {
    const { system, payload } = await scenePrompt("history");
    expect(system).toContain("in the order the passages give it");
    expect(system).toContain(HISTORY_SCENE_DOSSIER_RULE);
    for (const legacy of [LEGACY_SCENE_TELL, LEGACY_SCENE_DOSSIER, LEGACY_SCENE_USE]) {
      expect(system).not.toContain(legacy);
    }
    expect(payload.dossier).toEqual([{ source: "Ahmed Wally, USDA Foreign Agricultural Service staff", text: material.excerpts[0]!.text }]);
  });

  it("a guide's scene keeps the legacy account wording and document", async () => {
    const { system, payload } = await scenePrompt("guide");
    for (const legacy of [LEGACY_SCENE_TELL, LEGACY_SCENE_DOSSIER, LEGACY_SCENE_USE]) {
      expect(system).toContain(legacy);
    }
    expect(system).not.toContain(HISTORY_SCENE_DOSSIER_RULE);
    expect(payload.dossier[0]).toEqual({ document: "usda.gov", text: material.excerpts[0]!.text });
  });
});

describe("withoutUnfetchedReadings", () => {
  it("leaves a reading of a fetched episode, and anything that is not a reading, as planned", () => {
    const planned = composition(1);
    const onlyFetched = withoutUnfetchedReadings(planned, [blockage], material.excerpts);
    expect(onlyFetched).toBe(planned);
    const aftermath = { ...planned, sections: planned.sections.map((section) => ({ ...section, form: "aftermath" })) };
    expect(withoutUnfetchedReadings(aftermath, [blockage, docks], material.excerpts)).toBe(aftermath);
  });

  it("does nothing for a chapter with no passages, which composeChapter already turns into argument", () => {
    const planned = composition(1);
    expect(withoutUnfetchedReadings(planned, [blockage, docks], [])).toBe(planned);
  });

  it("does nothing when a passage is filed under a title no episode carries, since it may be the reading's", () => {
    const planned = composition(1);
    expect(withoutUnfetchedReadings(planned, [blockage, docks], [excerpt({}), excerpt({ id: "ch1-x2", episodeTitle: "The old London dock closes" })])).toBe(planned);
  });

  it("keeps a reading that is as much about a fetched episode as an unfetched one", () => {
    const planned = composition(1);
    const fetchedTwin = episode("The London docks close", "document", docks.document);
    const kept = withoutUnfetchedReadings(planned, [fetchedTwin, docks], [excerpt({ episodeTitle: fetchedTwin.title })]);
    expect(kept).toBe(planned);
  });
});
