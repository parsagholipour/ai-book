import { describe, expect, it } from "vitest";
import { candidateWindows, documentIsRelevant, sliceByAnchors, type DossierDocument } from "./dossier.js";

const filler = (n: number, word = "lorem") => Array.from({ length: n }, (_, i) => `${word}${i % 7}`).join(" ");
const passage =
  "Then Temüjin said to Jamukha: “Let us make the Merkit our prey, and take back what they took from us; let no man of them escape across the Selenge.” And they rode that night.";

describe("dossier", () => {
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
