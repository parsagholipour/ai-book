import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChapterDossier, candidateWindows, documentIsRelevant, sliceByAnchors, type DossierDocument } from "./dossier.js";
import * as primarySources from "./primarySources.js";
import { chapterEpisodeSchema } from "../schemas/episodes.js";
import { developmentInput, originalDevelopmentPlan, scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

afterEach(() => vi.restoreAllMocks());

const filler = (n: number, word = "lorem") => Array.from({ length: n }, (_, i) => `${word}${i % 7}`).join(" ");
const passage =
  "Then Temüjin said to Jamukha: “Let us make the Merkit our prey, and take back what they took from us; let no man of them escape across the Selenge.” And they rode that night.";

describe("dossier", () => {
  it("lets the extractor assess a passage without shared names instead of dropping its source", async () => {
    const episode = chapterEpisodeSchema.parse({ title: "The coronation", person: "Napoleon Bonaparte", place: "Paris", document: "Coronation memoir", searchQueries: ["coronation witness"] });
    const text = "We watched him take the crown from the cushion and raise it above his head. The company stood as the music began, and the clerk recorded the ceremony before the guests departed through the western door.";
    vi.spyOn(primarySources, "searchPrimarySources").mockResolvedValue([{ host: "web", title: "A witness's recollections", url: "https://example.org/record", textUrl: "https://example.org/record", author: "", year: "" }]);
    vi.spyOn(primarySources, "fetchPrimaryText").mockResolvedValue(`${text} ${filler(100)}`);
    const chapter = originalDevelopmentPlan().chapters[0]!;
    const { model, calls } = scriptedDevelopmentModel([{ excerpts: [{ windowId: `ch${chapter.index}-d1-w1`, firstWords: "We watched him take the crown from", lastWords: "guests departed through the western door.", episodeTitle: episode.title }] }]);
    const result = await buildChapterDossier({ input: developmentInput, chapter, episodes: [episode], textModel: model, fetch: async () => ({ status: 200, text: "" }) });
    expect(calls).toHaveLength(1);
    expect(result.excerpts[0]?.text).toBe(text);
  });
  it("ranks windows by distinct episode-term hits and falls back to the opening", () => {
    const document: DossierDocument = {
      id: "d1", title: "T", url: "u", host: "wikisource", author: "", year: "", episodeTitle: "e",
      text: `${filler(400)} ${passage} ${filler(400)} Temüjin alone. ${filler(400)}`
    };
    const windows = candidateWindows(document, ["temujin", "merkit", "jamukha"], { windowWords: 300, maxWindows: 2 });
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]!.text).toContain("Merkit");
    const empty = candidateWindows({ ...document, text: filler(200) }, ["temujin"], { windowWords: 100 });
    expect(empty).toHaveLength(1);
    expect(empty[0]!.text.startsWith("lorem0")).toBe(true);
  });

  it("slices a passage between folded anchors and refuses anchors that are not in the window", () => {
    const text = `${filler(20)} ${passage} ${filler(20)}`;
    const sliced = sliceByAnchors(text, "Then Temujin said to Jamukha: Let", "they rode that night.");
    expect(sliced).toBe(passage);
    // A zero-width space inside the window does not break the anchor.
    expect(sliceByAnchors(text.replace("Merkit our", "Merkit \u200b our"), "Then Temüjin said to Jamukha", "they rode that night.")).toBeDefined();
    expect(sliceByAnchors(text, "Then Temüjin said to Jamukha", "and burned the camp")).toBeUndefined();
    expect(sliceByAnchors(text, "they rode that night", "Then Temüjin said to Jamukha")).toBeUndefined();
    // Too short to be an excerpt.
    expect(sliceByAnchors(text, "Then Temüjin said to Jamukha", "make the Merkit our prey")).toBeUndefined();
  });

  it("keeps a document only when it carries one of the episode's own names", () => {
    const episode = { title: "The oath at the Onon", kind: "scene" as const, person: "Temüjin", place: "Onon river", date: "", document: "The Secret History of the Mongols", why: "", searchQueries: [] };
    const procopius: DossierDocument = { id: "d", title: "The Secret History of the Court of Justinian", url: "", host: "gutenberg", author: "", year: "", episodeTitle: episode.title, text: filler(600, "justinian") };
    const windows = candidateWindows(procopius, ["secret", "history", "temujin", "onon", "mongols"], { windowWords: 200, maxWindows: 2 });
    expect(documentIsRelevant(procopius, episode, windows)).toBe(false);
    const mongols: DossierDocument = { ...procopius, title: "The Outline of History/Chapter 34", text: `${filler(300)} Temüjin gathered the clans by the Onon. ${filler(300)}` };
    expect(documentIsRelevant(mongols, episode, candidateWindows(mongols, ["temujin", "onon"], { windowWords: 200, maxWindows: 2 }))).toBe(true);
    expect(documentIsRelevant({ title: "Mongols of the thirteenth century" }, episode, [])).toBe(true);
  });
});
