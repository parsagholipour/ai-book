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

  it("treats a model failure as no issues, but still propagates a user stop", async () => {
    generateJsonWithRetry.mockRejectedValue(new Error("model outage"));
    await expect(runBoundedChapterQualityReview(baseOptions([exportPage(1)]))).resolves.toEqual([]);

    generateJsonWithRetry.mockRejectedValue(new StopRequestedError());
    await expect(runBoundedChapterQualityReview(baseOptions([exportPage(1)]))).rejects.toBeInstanceOf(
      StopRequestedError
    );
  });
});
