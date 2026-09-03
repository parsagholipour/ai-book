import { describe, expect, it } from "vitest";
import { chapterEpigraph, epigraphText } from "./chapterApparatus.js";

const excerpt = (text: string, extra: Partial<{ speaker: string; author: string; year: string }> = {}) => ({
  id: "x",
  chapterIndex: 1,
  episodeTitle: "",
  documentTitle: "The Secret History of the Mongols",
  documentUrl: "",
  host: "wikisource",
  author: extra.author ?? "",
  year: extra.year ?? "",
  speaker: extra.speaker ?? "",
  text,
  words: text.split(/\s+/).length
});

describe("chapterApparatus", () => {
  it("keeps whole opening sentences under the cap and refuses a fragment", () => {
    const long = "First sentence of twelve words that runs on a little further than needed. " + "Second sentence here. " + "word ".repeat(70);
    expect(epigraphText(long)).toBe("First sentence of twelve words that runs on a little further than needed. Second sentence here.");
    expect(epigraphText("Too short.")).toBeUndefined();
  });

  it("prefers a named excerpt and sets it as an attributed block quote", () => {
    const unnamed = excerpt("An unnamed passage of about fourteen words that could also serve as an epigraph here.");
    const named = excerpt("Let us make the Merkit our prey, and take back what they took from us tonight.", { speaker: "Temüjin", year: "c. 1240" });
    expect(chapterEpigraph([unnamed, named])).toBe(
      "> “Let us make the Merkit our prey, and take back what they took from us tonight.”\n>\n> — Temüjin, *The Secret History of the Mongols* (c. 1240)"
    );
    expect(chapterEpigraph([excerpt("Short.")])).toBeUndefined();
  });
});
