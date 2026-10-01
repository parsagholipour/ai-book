import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());

import { readerPageNumbering } from "../bookPageNumbering.js";
import { type MobileEditChangesDto, type MobileEditPageChangeDto } from "./dto.js";
import { withReaderPages } from "./editChanges.js";

function page(pageIndex: number, extra: Partial<MobileEditPageChangeDto> = {}): MobileEditPageChangeDto {
  return {
    pageIndex,
    titleBefore: "T",
    titleAfter: "T",
    titleChanged: false,
    blocks: [],
    addedWords: 1,
    removedWords: 1,
    illustrationChanged: false,
    ...extra
  };
}

function changes(pages: MobileEditPageChangeDto[]): MobileEditChangesDto {
  return {
    operationId: "op-1",
    kind: "local_patch",
    status: "applied",
    request: "Replace the word sandals with slippers",
    creditsCharged: 0,
    appliedAt: null,
    undone: false,
    pages,
    addedWords: pages.length,
    removedWords: pages.length
  };
}

describe("the changes view's page numbers", () => {
  // The card opening it said "Pages 2, 3, 4"; its headings said "Page 1" and "Page 3".
  const numbering = readerPageNumbering({
    version: 2,
    totalPdfPages: 8,
    hasCoverPage: true,
    pages: [
      { index: 1, startPdfPage: 3, endPdfPage: 3 },
      { index: 3, startPdfPage: 4, endPdfPage: 5 }
    ]
  });

  it("puts each page's printed number beside the model page it navigates by", () => {
    const result = withReaderPages(changes([page(1), page(3)]), numbering);
    expect(result.pages.map((entry) => [entry.pageIndex, entry.readerPage])).toEqual([
      [1, 2],
      [3, 3]
    ]);
  });

  it("gives a removed page no number, because its old index names another page now", () => {
    const result = withReaderPages(changes([page(3, { structuralChange: "removed" })]), numbering);
    expect(result.pages[0]).not.toHaveProperty("readerPage");
  });

  it("leaves a book with no page map on model numbers", () => {
    const original = changes([page(1)]);
    expect(withReaderPages(original, readerPageNumbering(undefined))).toBe(original);
  });
});
