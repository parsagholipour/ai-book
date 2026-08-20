import { describe, expect, it } from "vitest";
import { buildChapterNarration, DEFAULT_TTS_SAMPLE_RATE } from "@book-maker/core";
import {
  audiobookChapterDisplayTitle,
  audiobookChapterPlans,
  joinNarrationChunks,
  narratedChapterLabel,
  spokenChapterLabel,
  synthesizeChunks,
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

describe("audiobookChapterDisplayTitle", () => {
  it("localizes the display fallback for a chapter whose stored title is empty", () => {
    expect(audiobookChapterDisplayTitle({ index: 5, title: "" }, "fa")).toBe("فصل 5");
    expect(audiobookChapterDisplayTitle({ index: 5, title: "" }, "ar")).toBe("الفصل 5");
  });

  it("keeps a real chapter title unchanged", () => {
    expect(audiobookChapterDisplayTitle({ index: 5, title: "The Return" }, "fa")).toBe("The Return");
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

describe("synthesizeChunks", () => {
  const narration = buildChapterNarration({
    chapterIndex: 1,
    title: "",
    language: "en",
    // Twelve paragraphs, so there is plenty left to narrate after an early failure.
    pages: [{ index: 1, markdown: Array.from({ length: 12 }, (_, i) => `Paragraph ${i}.`).join("\n\n") }]
  });

  function stubSpeech(onCall: (text: string) => void) {
    return {
      synthesize: async ({ text }: { text: string }) => {
        onCall(text);
        // Yield, so the sibling workers get a chance to pick up more chunks.
        await Promise.resolve();
        return {
          provider: "stub",
          model: "stub",
          pcm: Buffer.alloc(DEFAULT_TTS_SAMPLE_RATE * 2),
          sampleRate: DEFAULT_TTS_SAMPLE_RATE,
          channels: 1,
          durationMs: 1000
        };
      }
    };
  }

  it("returns one chunk per narration chunk, in order", async () => {
    const seen: string[] = [];
    const results = await synthesizeChunks({
      narration,
      voice: "Kore",
      stylePrompt: "Read warmly.",
      speech: stubSpeech((text) => void seen.push(text))
    });

    expect(results).toHaveLength(narration.chunks.length);
    expect(seen).toHaveLength(narration.chunks.length);
  });

  it("stops the other requests once one fails, instead of narrating a chapter nobody keeps", async () => {
    let calls = 0;
    const speech = stubSpeech(() => {
      calls += 1;
      if (calls === 2) {
        throw new Error("Gemini TTS request failed (400)");
      }
    });

    await expect(
      synthesizeChunks({ narration, voice: "Kore", stylePrompt: "Read warmly.", speech })
    ).rejects.toThrow(/400/);

    // The in-flight siblings finish their own chunk; none of them start a new one.
    expect(calls).toBeLessThanOrEqual(3);
    expect(calls).toBeLessThan(narration.chunks.length);
  });

  it("reports the first failure, not whichever one landed last", async () => {
    let calls = 0;
    const speech = stubSpeech(() => {
      calls += 1;
      throw new Error(`failure ${calls}`);
    });

    await expect(
      synthesizeChunks({ narration, voice: "Kore", stylePrompt: "Read warmly.", speech })
    ).rejects.toThrow("failure 1");
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

describe("narratedChapterLabel", () => {
  it("announces chapters for a book the printed edition would number", () => {
    const pages = Array.from({ length: 24 }, (_, index) =>
      page(index + 1, { index: Math.ceil((index + 1) / 8), title: `Chapter ${Math.ceil((index + 1) / 8)}` })
    );
    expect(narratedChapterLabel(audiobookChapterPlans(pages), pages, "fa")).toBe("فصل");
  });

  it("says nothing before the title of a book too small to have chapters", () => {
    // Three one-page chapters over three pages: the printed book drops the word
    // too, so a ninety-second part is not announced as a chapter.
    const pages = Array.from({ length: 3 }, (_, index) =>
      page(index + 1, { index: index + 1, title: `Movement ${index + 1}` })
    );
    expect(narratedChapterLabel(audiobookChapterPlans(pages), pages, "fa")).toBeUndefined();
  });

  it("leaves the partition alone whatever it decides", () => {
    const pages = Array.from({ length: 3 }, (_, index) =>
      page(index + 1, { index: index + 1, title: `Movement ${index + 1}` })
    );
    const plans = audiobookChapterPlans(pages);
    narratedChapterLabel(plans, pages, "fa");
    // Chapter files and the READY-skip that resumes a failed narration are keyed
    // on these indexes; only the spoken words may change.
    expect(plans.map((plan) => plan.index)).toEqual([1, 2, 3]);
  });
});
