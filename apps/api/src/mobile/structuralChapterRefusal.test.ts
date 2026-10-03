import { describe, expect, it } from "vitest";
import { resolveStructuralPageEdit, type StructuralPageEdit } from "@book-maker/core";
import { type BookEditIntent } from "../bookEditIntent.js";
import { MODEL_PAGE_NUMBERING } from "../bookPageNumbering.js";
import {
  multipleStructuralActionsMessage,
  structuralPagesOf,
  structuralRefusalMessage,
  unswappablePagesMessage
} from "./structuralPageEdits.js";

/**
 * "delete pages 2, 4 and 6" was refused with "That would leave one of the
 * chapters with no pages at all" — true, and nothing the reader could act on,
 * because which pages a chapter owns is not visible from the request
 * (2026-10-02). The refusal names the chapter it would empty, and its pages.
 */
const book = {
  chapters: [
    { id: "chapter-1", index: 1, title: "The Dark Outside", summary: "" },
    { id: "chapter-2", index: 2, title: "A Tiny Glow", summary: "" },
    { id: "chapter-3", index: 3, title: "Friends in the Night", summary: "" }
  ],
  pages: [1, 2, 3, 4, 5, 6].map((index) => ({
    id: `page-${index}`,
    index,
    chapter: { index: Math.ceil(index / 2) }
  }))
} as unknown as Parameters<typeof structuralPagesOf>[0];

function intentFor(edit: StructuralPageEdit): BookEditIntent {
  return {
    kind: "restructure_pages",
    confidence: 0.9,
    reasoning: "structural",
    affectedPageIndexes: [],
    assistantMessage: "",
    scope: "none",
    impact: "structural_replan",
    clarification: "none",
    structuralEdit: edit
  };
}

function refusalFor(edit: StructuralPageEdit): string {
  const resolved = resolveStructuralPageEdit(edit, structuralPagesOf(book));
  if (resolved.ok) {
    throw new Error("expected a refusal, got a plan");
  }
  expect(resolved.reason).toBe("would_empty_chapter");
  return structuralRefusalMessage(resolved, intentFor(edit), MODEL_PAGE_NUMBERING, book);
}

describe("refusing an edit that would empty a chapter", () => {
  it("names the chapter and the pages it holds", () => {
    expect(refusalFor({ action: "delete", anchorPageIndex: null, pageIndexes: [3, 4], pageCount: 0 })).toBe(
      "That would take out every page of the chapter “A Tiny Glow” (pages 3–4), and a chapter can’t be left empty. Keep at least one of its pages, or ask me to rewrite or replan that chapter instead."
    );
  });

  it("names every chapter it would empty, in book order", () => {
    expect(refusalFor({ action: "delete", anchorPageIndex: null, pageIndexes: [1, 2, 5, 6], pageCount: 0 })).toBe(
      "That would take out every page of the chapters “The Dark Outside” (pages 1–2) and “Friends in the Night” (pages 5–6), and a chapter can’t be left empty. Keep at least one page of each, or ask me to rewrite or replan those chapters instead."
    );
  });

  it("names the chapter a move would leave behind empty", () => {
    expect(refusalFor({ action: "move", anchorPageIndex: 6, pageIndexes: [1, 2], pageCount: 0 })).toContain(
      "the chapter “The Dark Outside” (pages 1–2)"
    );
  });

  it("falls back to the general sentence when it was not handed the book", () => {
    const resolved = resolveStructuralPageEdit(
      { action: "delete", anchorPageIndex: null, pageIndexes: [3, 4], pageCount: 0 },
      structuralPagesOf(book)
    );
    expect(resolved.ok).toBe(false);
    expect(
      structuralRefusalMessage(
        resolved.ok ? "nothing_to_do" : resolved.reason,
        intentFor({ action: "delete", anchorPageIndex: null, pageIndexes: [3, 4], pageCount: 0 }),
        MODEL_PAGE_NUMBERING
      )
    ).toBe("That would leave one of the chapters with no pages at all. Ask me to rewrite or replan the chapter instead.");
  });
});

describe("answering a swap no single move performs", () => {
  const move = intentFor({ action: "move", anchorPageIndex: 1, pageIndexes: [5], pageCount: 0 });
  const project = { ...book, pdfPageMap: null, contentRevision: 1, status: "COMPLETE" } as unknown as Parameters<
    typeof unswappablePagesMessage
  >[2];

  it("says it takes two moves and names the first one", () => {
    expect(unswappablePagesMessage("swap pages 2 and 5", move, project)).toBe(
      "Swapping pages 2 and 5 takes two moves, and I make one at a time. Ask me to move page 5 before page 2 first, then tell me where page 2 should go."
    );
  });

  it("leaves a swap of neighbours, and everything that is not a swap, to the card", () => {
    expect(unswappablePagesMessage("swap pages 2 and 3", move, project)).toBeNull();
    expect(unswappablePagesMessage("move page 5 before page 2", move, project)).toBeNull();
    expect(unswappablePagesMessage("swap pages 2 and 5", intentFor({ action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 }), project)).toBeNull();
  });

  it("reads the same swap in Persian", () => {
    expect(unswappablePagesMessage("صفحه ۲ و ۵ را جابجا کن", move, project)).toContain("takes two moves");
    expect(unswappablePagesMessage("صفحه ۲ و ۳ را جابجا کن", move, project)).toBeNull();
  });

  it("names a page given twice", () => {
    expect(unswappablePagesMessage("swap page 3 with page 3", move, project)).toContain("names page 3 twice");
  });
});

describe("answering a message that asks for more than one page change", () => {
  it("names both changes and asks which comes first", () => {
    expect(multipleStructuralActionsMessage("add a page after page 4 and delete page 9")).toBe(
      "That asks for adding pages and removing pages at once, and I make one page change at a time so each gets its own card and its own Undo. Tell me which to do first, and ask for the next once it’s in."
    );
    expect(multipleStructuralActionsMessage("delete page 3, move page 5 to the end and add a page")).toContain(
      "adding pages, removing pages and moving pages"
    );
  });

  it("leaves one change alone, however it is phrased", () => {
    for (const request of [
      "add a page after page 4 about leftovers",
      "put page 3 after page 1",
      "remove page 5, it repeats page 4",
      "swap pages 2 and 3",
      "delete page 3 and add page numbers"
    ]) {
      expect(multipleStructuralActionsMessage(request), request).toBeNull();
    }
  });
});
