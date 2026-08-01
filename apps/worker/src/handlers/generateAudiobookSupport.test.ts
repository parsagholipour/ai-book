import { describe, expect, it } from "vitest";
import { buildChapterNarration, DEFAULT_TTS_SAMPLE_RATE } from "@book-maker/core";
import {
  audiobookChapterPlans,
  joinNarrationChunks,
  spokenChapterLabel,
  type AudiobookSourcePage
} from "./generateAudiobookSupport.js";

function page(index: number, chapter: { index: number; title: string } | null = null): AudiobookSourcePage {
  return { index, title: `Page ${index}`, markdown: `Words on page ${index}.`, chapter };
}

describe("audiobookChapterPlans", () => {
  it("groups pages by the book's own chapters, in reading order", () => {
    const chapterOne = { index: 1, title: "Low Tide" };
    const chapterTwo = { index: 2, title: "The Lamp" };
    const plans = audiobookChapterPlans([
      page(1, chapterOne),
      page(2, chapterOne),
      page(3, chapterTwo)
    ]);

    expect(plans.map((plan) => [plan.index, plan.title])).toEqual([
      [1, "Low Tide"],
      [2, "The Lamp"]
    ]);
    expect(plans[0]?.pages.map((entry) => entry.index)).toEqual([1, 2]);
    expect(plans[1]?.pages.map((entry) => entry.index)).toEqual([3]);
  });

  it("sorts chapters even when the pages arrive out of order", () => {
    const plans = audiobookChapterPlans([
      page(9, { index: 3, title: "Third" }),
      page(1, { index: 1, title: "First" }),
      page(5, { index: 2, title: "Second" })
    ]);
    expect(plans.map((plan) => plan.index)).toEqual([1, 2, 3]);
  });

  it("is stable across attempts, so a retry cannot renumber finished audio", () => {
    const pages = Array.from({ length: 24 }, (_, index) => page(index + 1));
    const first = audiobookChapterPlans(pages);
    const second = audiobookChapterPlans(pages);
    expect(second).toEqual(first);
  });

  it("falls back to deterministic chapters for a book with none of its own", () => {
    const plans = audiobookChapterPlans(Array.from({ length: 24 }, (_, index) => page(index + 1)));
    expect(plans.length).toBeGreaterThan(1);
    // Every page must land in exactly one chapter, or narration would skip text.
    expect(plans.flatMap((plan) => plan.pages.map((entry) => entry.index))).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1)
    );
  });

  it("treats a partially chaptered book as unchaptered rather than dropping pages", () => {
    const plans = audiobookChapterPlans([
      page(1, { index: 1, title: "Only Chapter" }),
      page(2),
      page(3)
    ]);
    expect(plans.flatMap((plan) => plan.pages.map((entry) => entry.index))).toEqual([1, 2, 3]);
  });

  it("keeps a short book as one untitled chapter instead of inventing divisions", () => {
    const plans = audiobookChapterPlans([page(1), page(2)]);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ index: 1, title: "" });
    expect(plans[0]?.pages).toHaveLength(2);
  });

  it("has nothing to narrate for a book with no finished pages", () => {
    expect(audiobookChapterPlans([])).toEqual([]);
  });
});

describe("joinNarrationChunks", () => {
  const narration = buildChapterNarration({
    chapterIndex: 1,
    title: "",
    language: "en",
    pages: [{ index: 1, markdown: "One.\n\nTwo." }]
  });

  function chunkOf(seconds: number) {
    return {
      pcm: Buffer.alloc(DEFAULT_TTS_SAMPLE_RATE * 2 * seconds),
      sampleRate: DEFAULT_TTS_SAMPLE_RATE,
      channels: 1
    };
  }

  it("inserts exactly the pauses the timeline was built from", () => {
    const chunks = narration.chunks.map(() => chunkOf(1));
    const joined = joinNarrationChunks(chunks, narration);

    const speechBytes = chunks.reduce((total, chunk) => total + chunk.pcm.length, 0);
    const pauseBytes = narration.chunks.reduce(
      (total, chunk) => total + Math.round((DEFAULT_TTS_SAMPLE_RATE * chunk.pauseAfterMs) / 1000) * 2,
      0
    );
    expect(joined.length).toBe(speechBytes + pauseBytes);
  });

  it("returns nothing for a chapter that produced no audio", () => {
    expect(joinNarrationChunks([], narration).length).toBe(0);
  });
});

describe("spokenChapterLabel", () => {
  it("says the word the printed book prints", () => {
    expect(spokenChapterLabel("en")).toBe("Chapter");
    expect(spokenChapterLabel("fr")).toBe("Chapitre");
    expect(spokenChapterLabel("fa")).toBe("فصل");
  });

  it("falls back to English for a language with no label of its own", () => {
    expect(spokenChapterLabel("sv")).toBe("Chapter");
    expect(spokenChapterLabel(null)).toBe("Chapter");
  });
});
