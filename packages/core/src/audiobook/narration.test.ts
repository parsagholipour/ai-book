import { describe, expect, it } from "vitest";
import {
  CHAPTER_TAIL_PAUSE_MS,
  PARAGRAPH_PAUSE_MS,
  SENTENCE_PAUSE_MS,
  TITLE_PAUSE_MS,
  buildChapterNarration,
  narrationParagraphs,
  splitIntoSegments
} from "./narration.js";
import { isRtlLanguage } from "../prompting/script.js";

describe("narration text pipeline", () => {
  it("keeps paragraph breaks and drops everything that is not speech", () => {
    const paragraphs = narrationParagraphs(
      [
        "# The Lighthouse",
        "",
        "![A beam over water](/assets/images/p/page-1.jpg)",
        "",
        "She climbed the **stairs** slowly.",
        "The lamp was already lit.",
        "",
        "---",
        "",
        "> Nobody had been there for a year.",
        "",
        "```",
        "const secret = 1;",
        "```"
      ].join("\n")
    );

    expect(paragraphs).toEqual([
      "The Lighthouse",
      "She climbed the stairs slowly. The lamp was already lit.",
      "Nobody had been there for a year."
    ]);
  });

  it("unwraps links and inline code to what a narrator would say", () => {
    expect(narrationParagraphs("See [the map](https://example.com) and `run()`.")).toEqual([
      "See the map and run()."
    ]);
  });

  it("splits paragraphs into sentences", () => {
    expect(splitIntoSegments("She waited. He did not come! Why?", "en")).toEqual([
      "She waited.",
      "He did not come!",
      "Why?"
    ]);
  });

  it("breaks a runaway sentence into clause-sized pieces a listener can follow", () => {
    const long = `${"a long clause that keeps going, ".repeat(20)}and then it finally stops.`;
    const segments = splitIntoSegments(long, "en");
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(360);
    }
    // No words may be lost when a sentence is split.
    expect(segments.join(" ").replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " ").trim());
  });

  it("speaks the chapter title first and gives it room to land", () => {
    const narration = buildChapterNarration({
      chapterIndex: 3,
      title: "The Lighthouse",
      language: "en",
      chapterLabel: "Chapter",
      pages: [{ index: 12, markdown: "She climbed the stairs." }]
    });

    expect(narration.segments[0]).toMatchObject({
      kind: "title",
      text: "Chapter 3. The Lighthouse",
      pageIndex: 12
    });
    expect(narration.chunks[0]?.pauseAfterMs).toBe(TITLE_PAUSE_MS);
  });

  it("does not repeat the label when the title already carries it", () => {
    const narration = buildChapterNarration({
      chapterIndex: 2,
      title: "Chapter Two: Low Tide",
      chapterLabel: "Chapter",
      pages: [{ index: 1, markdown: "Words." }]
    });
    expect(narration.segments[0]?.text).toBe("Chapter Two: Low Tide");
  });

  it("never packs more than one paragraph into a request, and pauses longer between them", () => {
    const narration = buildChapterNarration({
      chapterIndex: 1,
      title: "",
      pages: [{ index: 1, markdown: "One. Two.\n\nThree. Four." }]
    });

    // Two paragraphs, so at least two chunks, and no chunk spans both.
    for (const chunk of narration.chunks) {
      const paragraphs = new Set(
        chunk.segmentIndexes.map((index) => narration.segments[index]?.paragraph)
      );
      expect(paragraphs.size).toBe(1);
    }
    const pauses = narration.chunks.map((chunk) => chunk.pauseAfterMs);
    expect(pauses).toContain(PARAGRAPH_PAUSE_MS);
    expect(pauses[pauses.length - 1]).toBe(CHAPTER_TAIL_PAUSE_MS);
  });

  it("keeps each request under the provider's comfortable size", () => {
    const sentences = Array.from({ length: 40 }, (_, index) => `Sentence number ${index} of the page.`);
    const narration = buildChapterNarration({
      chapterIndex: 1,
      title: "",
      pages: [{ index: 1, markdown: sentences.join(" ") }]
    });

    expect(narration.chunks.length).toBeGreaterThan(1);
    for (const chunk of narration.chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(400);
    }
  });

  it("covers every segment exactly once across the chunks", () => {
    const narration = buildChapterNarration({
      chapterIndex: 1,
      title: "Tide",
      chapterLabel: "Chapter",
      pages: [
        { index: 1, markdown: "One. Two.\n\nThree." },
        { index: 2, markdown: "Four. Five." }
      ]
    });

    const covered = narration.chunks.flatMap((chunk) => chunk.segmentIndexes);
    expect(covered).toEqual(narration.segments.map((segment) => segment.index));
  });

  it("carries the page each sentence came from, so a listener can be placed in the book", () => {
    const narration = buildChapterNarration({
      chapterIndex: 1,
      title: "",
      pages: [
        { index: 7, markdown: "From page seven." },
        { index: 8, markdown: "From page eight." }
      ]
    });
    expect(narration.segments.map((segment) => segment.pageIndex)).toEqual([7, 8]);
  });

  it("marks right-to-left languages so the transcript lays out correctly", () => {
    // `Project.language` holds a code for some books and a name for others,
    // so both spellings have to resolve.
    expect(isRtlLanguage("fa")).toBe(true);
    expect(isRtlLanguage("Persian")).toBe(true);
    expect(isRtlLanguage("ar-EG")).toBe(true);
    expect(isRtlLanguage("en")).toBe(false);
    expect(isRtlLanguage("French")).toBe(false);
    expect(
      buildChapterNarration({ chapterIndex: 1, title: "", language: "he", pages: [{ index: 1, markdown: "שלום." }] })
        .direction
    ).toBe("rtl");
  });

  it("estimates a length before anything has been synthesized", () => {
    const narration = buildChapterNarration({
      chapterIndex: 1,
      title: "",
      pages: [{ index: 1, markdown: "A sentence with a reasonable number of words in it." }]
    });
    expect(narration.estimatedDurationMs).toBeGreaterThan(1000);
  });

  it("uses the short pause between sentences of one paragraph", () => {
    const narration = buildChapterNarration({
      chapterIndex: 1,
      title: "",
      pages: [{ index: 1, markdown: `${"Long sentence to force a chunk split. ".repeat(30)}` }]
    });
    expect(narration.chunks.slice(0, -1).map((chunk) => chunk.pauseAfterMs)).toContain(SENTENCE_PAUSE_MS);
  });

  it("produces nothing for a chapter with no words rather than an empty request", () => {
    const narration = buildChapterNarration({
      chapterIndex: 1,
      title: "",
      pages: [{ index: 1, markdown: "![only an image](/x.jpg)" }]
    });
    expect(narration.segments).toEqual([]);
    expect(narration.chunks).toEqual([]);
  });
});
