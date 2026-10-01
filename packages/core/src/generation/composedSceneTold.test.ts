import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema } from "../schemas/book.js";
import { chapterEpisodeSchema, dossierExcerptSchema } from "../schemas/episodes.js";
import { formPaletteFor, type ChapterComposition } from "./chapterForms.js";
import { composeChapter } from "./composedChapter.js";
import { afterOpeningScene, sceneToldNote } from "./composedSceneTold.js";

const analytical = formPaletteFor("analytical-history");
const voyage = chapterEpisodeSchema.parse({ title: "The Ideal X leaves Port Newark", kind: "scene", person: "Malcolm McLean", place: "Port Newark", date: "April 26, 1956", document: "Port Authority record", searchQueries: [] });
const trucking = chapterEpisodeSchema.parse({ title: "A trucking problem becomes a shipping company", kind: "portrait", person: "Malcolm McLean", searchQueries: [] });
const scene = { text: "On April 26, 1956, the Ideal X left Port Newark with fifty-eight containers.", words: 12, episodeTitle: voyage.title };
// The plan of 2026-09-30 that put the voyage third: the chapter opened on the scene, went back to 1937 and told the voyage again.
const composition: ChapterComposition = {
  chapterIndex: 2, throughLine: "McLean's bet", landing: "A voyage is not a system.", avoid: [],
  sections: [
    { form: "portrait", subject: "Malcolm McLean's trucking business and his decisions to carry loaded units between road and sea", share: 0.3, owns: ["McLean's 1934–1956 trucking decisions as documented in The Box"] },
    { form: "mechanism", subject: "How a loaded container could move from a truck chassis to a ship", share: 0.2, owns: ["The ship-to-shore transfer design"] },
    { form: "scene", subject: "The Ideal X leaves Port Newark for Houston on April 26, 1956", share: 0.3, owns: ["The documented Ideal X departure and voyage from Port Newark to Houston", "The Houston inspection report"], note: "Check the date against shipping records." },
    { form: "open-question", subject: "The limits of the Ideal X voyage as evidence for a transport system", share: 0.2, owns: ["The distinction between a demonstration and a system"] }
  ]
};
const material = { episodes: [voyage, trucking], excerpts: [], scene };

describe("a chapter whose opening scene is already told", () => {
  it("turns the section that treats the told episode into its aftermath and takes the episode out of the material", () => {
    const after = afterOpeningScene({ composition, material }, analytical);
    expect(after.composition.sections.map((section) => section.form)).toEqual(["portrait", "mechanism", "aftermath", "open-question"]);
    expect(after.composition.sections[2]).toMatchObject({ owns: ["The Houston inspection report"], note: sceneToldNote(voyage.title), share: 0.3 });
    // The section that only mentions the ship is left as planned, and so is every other field.
    expect(after.composition.sections[3]).toBe(composition.sections[3]);
    expect(after.material?.episodes).toEqual([trucking]);
    expect(after.material?.scene).toBe(scene);
  });

  it("keeps the form of a section that was never a narration, and leaves a plan with no such section alone", () => {
    const reading = { ...composition, sections: composition.sections.map((section, index) => index === 2 ? { ...section, form: "close-reading" } : section) };
    expect(afterOpeningScene({ composition: reading, material }, analytical).composition.sections[2]).toMatchObject({ form: "close-reading", note: sceneToldNote(voyage.title) });
    const elsewhere = { ...material, scene: { ...scene, episodeTitle: "The Ever Given blocks the Suez Canal" } };
    const after = afterOpeningScene({ composition, material: elsewhere }, analytical);
    expect(after.composition).toBe(composition);
    expect(after.material?.episodes).toEqual([voyage, trucking]);
  });

  it("changes nothing without a scene, or for a palette with no aftermath form", () => {
    const bare = { episodes: [voyage, trucking], excerpts: [] };
    expect(afterOpeningScene({ composition, material: bare }, analytical)).toEqual({ composition, material: bare });
    expect(afterOpeningScene({ composition }, analytical)).toEqual({ composition, material: undefined });
    // A narrative book's scenes are its sections: 0.14–0.33 of their numbers repeated, against 0.5–1.0 in a history.
    expect(afterOpeningScene({ composition, material }, formPaletteFor("narrative"))).toEqual({ composition, material });
  });

  it("shows the writer the reassigned section and an episode list without the told one", async () => {
    const input = createProjectSchema.parse({ prompt: "A history of the shipping container.", category: "HISTORY", targetPages: 20, complexity: 6, language: "en" });
    const plan = makeFallbackPlan(input);
    const chapter = plan.chapters[0]!;
    const textModel = new FakeTextModelAdapter(input);
    const calls = vi.spyOn(textModel, "generateText");
    const excerpt = dossierExcerptSchema.parse({ id: "x1", chapterIndex: chapter.index, episodeTitle: voyage.title, documentTitle: "Port Authority record", documentUrl: "https://example.org/record", text: "The Ideal X carried fifty-eight containers to Houston." });
    await composeChapter({ input, plan, chapter, composition: { ...composition, chapterIndex: chapter.index },
      stance: { thesis: "The box changed trade.", positions: [], refusals: [], voiceSample: "Plain prose." },
      chapterPageStart: 1, chapterPageEnd: 4, earlierChapters: [], continuityNotes: [], researchNotes: [], contract: "creative",
      material: { ...material, excerpts: [excerpt] }, textModel });
    const messages = calls.mock.calls[0]![0].messages;
    const system = String(messages[0]!.content);
    const payload = JSON.parse(String(messages[1]!.content));
    expect(system).toContain(`form "aftermath"`);
    expect(system).toContain(sceneToldNote(voyage.title));
    expect(system).toContain("give none of its events, dates, figures or quotations a second time");
    expect(system).not.toContain("Check the date against shipping records.");
    expect(payload.episodes.map((episode: { title: string }) => episode.title)).toEqual([trucking.title]);
    expect(payload.openingScene).toBe(scene.text);
  });
});
