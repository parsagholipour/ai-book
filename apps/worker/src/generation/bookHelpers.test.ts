import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateProjectInput, PriorPageContext } from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  prisma: {
    page: { findMany: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []) }
  }
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/config.js", () => ({ config: { BOOK_STORAGE_DIR: "" } }));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: vi.fn() }));

// The final-QA verdict rules this file used to cover moved out with the code:
// they are pure text and live in `finalQaPageTargets.test.ts`, which needs no
// module mocks at all.
import { loadPageTextSnapshot, styleExcerptsForPage } from "./bookHelpers.js";

const input = { mediaSettings: {} } as CreateProjectInput;

function page(index: number, voice: string): PriorPageContext {
  return {
    index,
    title: `Page ${index}`,
    markdown: `${voice} ${"prose ".repeat(20)}`,
    summary: `Summary ${index}`
  };
}

describe("styleExcerptsForPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.page.findMany.mockResolvedValue([]);
  });

  it("loads nothing and pins nothing when the excerpts gate is off", async () => {
    const excerpts = await styleExcerptsForPage({
      projectId: "project-1",
      pageIndex: 21,
      recencyPages: [page(17, "late-voice")],
      input,
      quality: { enabled: () => false }
    });

    expect(excerpts).toEqual([]);
    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
  });

  it("pins the book's opening voice, not the recency window, when the lock has to be loaded", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "opening-voice"), page(2, "second-voice")]);
    const recency = [page(17, "late-voice"), page(18, "later-voice")];

    const excerpts = await styleExcerptsForPage({
      projectId: "project-1",
      pageIndex: 21,
      recencyPages: recency,
      input,
      quality: { enabled: (feature) => feature === "styleExcerpts" }
    });

    expect(mocks.prisma.page.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ index: { in: [1, 2] } }) })
    );
    expect(excerpts).toHaveLength(2);
    expect(excerpts[0]).toContain("opening-voice");
    expect(excerpts[1]).toContain("second-voice");
    expect(excerpts.join(" ")).not.toMatch(/late-voice|later-voice/);
  });

  it("does not reload pages 1 and 2 when they are already in the recency window", async () => {
    const recency = [page(1, "opening-voice"), page(2, "second-voice"), page(3, "third")];

    const excerpts = await styleExcerptsForPage({
      projectId: "project-1",
      pageIndex: 5,
      recencyPages: recency,
      input,
      quality: { enabled: (feature) => feature === "styleExcerpts" }
    });

    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
    expect(excerpts[0]).toContain("opening-voice");
    expect(excerpts[1]).toContain("second-voice");
  });
});

describe("loadPageTextSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.page.findMany.mockResolvedValue([]);
  });

  it("asks for the four columns a stand-down compares and nothing else", async () => {
    // The whole reason it exists beside `loadPagesForExport`. Its one caller
    // derives a set of moved page indexes, and it used to derive it from the
    // export set: every page's body plus an `images` and a `chapter` join per
    // row, on a 300-page book, issued while the compile that superseded this one
    // is rendering and publishing against the same database. `markdown` stays —
    // it is compared, not tested for emptiness, and it is what catches a writer
    // that rewrote a page without touching its `revision`.
    await loadPageTextSnapshot("project-1");

    expect(mocks.prisma.page.findMany).toHaveBeenCalledWith({
      where: { projectId: "project-1" },
      orderBy: { index: "asc" },
      select: { index: true, title: true, markdown: true, revision: true }
    });
  });
});
