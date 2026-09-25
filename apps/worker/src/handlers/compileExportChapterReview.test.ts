import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import { StopRequestedError } from "../runtime/jobTypes.js";

const { generateJsonWithRetry } = vi.hoisted(() => ({ generateJsonWithRetry: vi.fn() }));

vi.mock("@book-maker/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@book-maker/core")>();
  return { ...actual, generateJsonWithRetry };
});

import { runBoundedChapterQualityReview } from "./compileExportChapterReview.js";

function exportPage(index: number, overrides: Partial<ExportPageForRepair> = {}): ExportPageForRepair {
  return {
    id: `page-${index}`,
    index,
    title: `Page ${index}`,
    markdown: `Page ${index} actual manuscript prose about the walk home.`,
    summary: `Planning summary for page ${index}, not the prose.`,
    imagePrompt: null,
    status: "COMPLETED",
    revision: 1,
    chapter: null,
    images: [],
    ...overrides
  } as ExportPageForRepair;
}

const baseOptions = (pages: ExportPageForRepair[]) =>
  ({
    input: { language: "en", mediaSettings: {} },
    plan: { title: "Book", chapters: [{ index: 1, title: "Openings" }] },
    pages,
    textModel: {},
    projectId: "project-1"
  }) as never;

describe("runBoundedChapterQualityReview", () => {
  beforeEach(() => {
    generateJsonWithRetry.mockReset();
  });

  it("returns nothing for an empty book without calling the model", async () => {
    await expect(runBoundedChapterQualityReview(baseOptions([]))).resolves.toEqual([]);
    expect(generateJsonWithRetry).not.toHaveBeenCalled();
  });

  it("does not mistake the twelfth sampled chapter for the ending of a fifteen-chapter story", async () => {
    // Exact retained sparse Quick counterexample: pages 29–30 paid off the
    // deadline, but the old first-12-chapters payload ended at page 24.
    const prose = new Map([
      [2, "“We should reach it before moonrise,” said Rabbit. Wise Turtle nodded. “First, we must find our lights.”"],
      [24, "All six lanterns now stood where they belonged, glowing toward the meadow."],
      [29, "The group stepped from the woodland path into the meadow before moonrise. No one had been left behind."],
      [30, "Warm lanterns shone along the path behind them. The picnic was underway, right on time."]
    ]);
    const pages = Array.from({ length: 30 }, (_, i) => exportPage(i + 1, {
      markdown: prose.get(i + 1) ?? `The friends follow the woodland path on page ${i + 1}.`,
      chapter: { id: `chapter-${Math.floor(i / 2) + 1}`, productionBrief: null,
        index: Math.floor(i / 2) + 1, title: `Chapter ${Math.floor(i / 2) + 1}` }
    }));
    const unsupported = { code: "CHAPTER_COHERENCE", affectedPageIndexes: [2, 24],
      message: "The story establishes that the friends should reach the meadow before moonrise, but the final excerpt only restores the lanterns and leaves their arrival and the picnic unresolved.",
      guidance: "Add a brief ending showing whether they reach the meadow before moonrise and what happens to the picnic, or clarify that restoring the lights—not reaching the meadow—is the goal." };
    const local = { code: "CHAPTER_COHERENCE", affectedPageIndexes: [23, 24], message: "A local contradiction.", guidance: "Clarify these two excerpts." };
    const adjacent = { code: "CHAPTER_TRANSITION", affectedPageIndexes: [22, 23], message: "An abrupt handoff.", guidance: "Bridge these adjacent excerpts." };
    generateJsonWithRetry.mockResolvedValue({ data: { issues: [unsupported, local, adjacent,
      { ...adjacent, affectedPageIndexes: [2, 24] }, { ...local, affectedPageIndexes: [29, 30] }] } });
    const issues = await runBoundedChapterQualityReview(baseOptions([...pages].reverse()));
    const request = generateJsonWithRetry.mock.calls[0]![1];
    const payload = JSON.parse(request.messages[1].content);
    expect(payload.reviewScope).toMatchObject({ kind: "sampled_chapter_boundaries", totalStoryPages: 30,
      finalStoryPageIndex: 30, totalChapters: 15, omittedChapterIndexes: [13, 14, 15], allowsWholeBookAbsenceClaims: false });
    expect(payload.chapters).toHaveLength(12);
    expect(payload.chapters.at(-1).closingProse.pageIndex).toBe(24);
    expect(payload.bookEndingContext.map((page: { pageIndex: number }) => page.pageIndex)).toEqual([29, 30]);
    expect(payload.bookEndingContext[0].excerpt).toContain("into the meadow before moonrise");
    expect(payload.bookEndingContext[1].excerpt).toContain("picnic was underway");
    expect(request.messages[0].content).toMatch(/last sampled chapter is not necessarily the book ending/);
    expect(issues.map(({ code, affectedPageIndexes }) => ({ code, affectedPageIndexes }))).toEqual([
      { code: local.code, affectedPageIndexes: [23, 24] }, { code: adjacent.code, affectedPageIndexes: [22, 23] }
    ]);
  });

  it("sends labeled actual prose excerpts and summaries that cannot be mistaken for prose", async () => {
    generateJsonWithRetry.mockResolvedValue({
      data: {
        issues: [
          { code: "CHAPTER_TRANSITION", message: "Abrupt jump.", guidance: "Bridge it.", affectedPageIndexes: [8, 9] }
        ]
      }
    });
    const pages = Array.from({ length: 9 }, (_, index) => exportPage(index + 1));

    const issues = await runBoundedChapterQualityReview(baseOptions(pages));

    const payload = JSON.parse(
      (generateJsonWithRetry.mock.calls[0]![1] as { messages: Array<{ content: string }> }).messages[1]!.content
    ) as {
      chapters: Array<{
        index: number;
        title: string;
        openingProse: { contentKind: string; label: string };
        pageSummaries: Array<{ contentKind: string; label: string; summary: string }>;
      }>;
      transitions: Array<{
        contentKind: string;
        ending: { contentKind: string; label: string };
      }>;
    };
    const system = (generateJsonWithRetry.mock.calls[0]![1] as { messages: Array<{ content: string }> }).messages[0]!
      .content;
    expect(payload.chapters.map((chapter) => chapter.index)).toEqual([1, 2]);
    expect(payload.chapters[0]?.title).toBe("Openings");
    expect(payload.chapters[1]?.title).toBe("Chapter 2");
    expect(payload.chapters[0]?.openingProse.contentKind).toBe("prose");
    expect(payload.chapters[0]?.openingProse.label).toMatch(/actual/i);
    expect(payload.chapters[0]?.pageSummaries.every((entry) => entry.contentKind === "summary")).toBe(true);
    expect(payload.chapters[0]?.pageSummaries[0]?.summary).toMatch(/Planning summary/);
    expect(payload.transitions).toHaveLength(1);
    expect(payload.transitions[0]?.contentKind).toBe("transition_excerpt");
    expect(payload.transitions[0]?.ending.contentKind).toBe("prose");
    expect(system).toMatch(/not the full book/i);
    expect(system).toMatch(/not manuscript prose/i);
    expect(JSON.stringify(payload.chapters[0])).not.toMatch(/"prose":"Page 1 actual manuscript prose/);
    expect(issues).toEqual([
      expect.objectContaining({ code: "CHAPTER_TRANSITION", severity: "warning", source: "model" })
    ]);
  });

  it("sends figure-free opening and closing excerpts, not chart JSON", async () => {
    generateJsonWithRetry.mockResolvedValue({ data: { issues: [] } });
    const fence =
      "```figure\n" +
      JSON.stringify({
        kind: "bar",
        title: "Carts by decade",
        categories: ["1500", "1510"],
        series: [{ name: "Carts", values: [120, 140] }],
        source: "The ledger"
      }) +
      "\n```";
    const chapter1Prose = "The clerks counted the carts at the north gate and wrote every name in the ledger.";
    const chapter2Prose = "The towns felt the change first, and the road out of town still carried the dust.";

    await runBoundedChapterQualityReview(
      baseOptions([
        exportPage(1, {
          chapter: { id: "ch-1", index: 1, productionBrief: null },
          markdown: `${chapter1Prose}\n\n${fence}`,
          summary: `Planning summary for the carts.\n\n${fence}`
        }),
        exportPage(2, {
          chapter: { id: "ch-2", index: 2, productionBrief: null },
          markdown: `${fence}\n\n${chapter2Prose}`
        })
      ])
    );

    const payload = JSON.parse(
      (generateJsonWithRetry.mock.calls[0]![1] as { messages: Array<{ content: string }> }).messages[1]!.content
    ) as {
      chapters: Array<{
        openingProse: { excerpt: string };
        closingProse: { excerpt: string };
        pageSummaries: Array<{ summary: string }>;
      }>;
      transitions: Array<{ ending: { excerpt: string }; opening: { excerpt: string } }>;
    };
    const excerpts = [
      payload.chapters[0]?.openingProse.excerpt,
      payload.chapters[0]?.closingProse.excerpt,
      payload.chapters[1]?.openingProse.excerpt,
      payload.chapters[1]?.closingProse.excerpt,
      payload.transitions[0]?.ending.excerpt,
      payload.transitions[0]?.opening.excerpt
    ];
    expect(excerpts[0]).toContain(chapter1Prose);
    expect(excerpts[1]).toContain(chapter1Prose);
    expect(excerpts[2]).toContain(chapter2Prose);
    expect(excerpts[3]).toContain(chapter2Prose);
    expect(excerpts[4]).toContain(chapter1Prose);
    expect(excerpts[5]).toContain(chapter2Prose);
    for (const excerpt of excerpts) {
      expect(excerpt).not.toContain("```figure");
      expect(excerpt).not.toContain('"kind"');
      expect(excerpt).not.toContain('"categories"');
      expect(excerpt).not.toContain('"series"');
    }
    const pageSummary = payload.chapters[0]?.pageSummaries[0]?.summary ?? "";
    expect(pageSummary).toContain(chapter1Prose);
    expect(pageSummary).not.toMatch(/Planning summary for the carts/);
    expect(pageSummary).not.toContain("```figure");
    expect(pageSummary).not.toContain('"kind"');
    expect(pageSummary).not.toContain("Carts by decade");
  });

  it("does not send fence-free leaked figure JSON as a page summary", async () => {
    generateJsonWithRetry.mockResolvedValue({ data: { issues: [] } });
    const prose = "The clerks counted the carts at the north gate and wrote every name in the ledger.";
    const leakedSummary = JSON.stringify({
      kind: "line",
      title: "Into the unknown",
      categories: ["1900", "1910"],
      series: [{ name: "Intake", values: [12, 40] }],
      source: "What came next: the beginning of the record"
    });

    await runBoundedChapterQualityReview(baseOptions([exportPage(1, { markdown: prose, summary: leakedSummary })]));

    const payload = JSON.parse(
      (generateJsonWithRetry.mock.calls[0]![1] as { messages: Array<{ content: string }> }).messages[1]!.content
    ) as { chapters: Array<{ pageSummaries: Array<{ summary: string }> }> };
    const pageSummary = payload.chapters[0]?.pageSummaries[0]?.summary ?? "";
    expect(pageSummary).toContain(prose);
    expect(pageSummary).not.toContain('"kind"');
    expect(pageSummary).not.toContain('"categories"');
    expect(pageSummary).not.toContain("Into the unknown");
  });

  it("marks a model check unavailable while still propagating a user stop", async () => {
    generateJsonWithRetry.mockRejectedValue(new Error("model outage"));
    await expect(runBoundedChapterQualityReview(baseOptions([exportPage(1)]))).resolves.toEqual([expect.objectContaining({ code: "CHAPTER_REVIEW_UNAVAILABLE", severity: "warning" })]);

    generateJsonWithRetry.mockRejectedValue(new StopRequestedError());
    await expect(runBoundedChapterQualityReview(baseOptions([exportPage(1)]))).rejects.toBeInstanceOf(
      StopRequestedError
    );
  });
});
