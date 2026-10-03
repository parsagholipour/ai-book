import { describe, expect, it } from "vitest";

import { type BookEditIntent } from "../bookEditIntent.js";
import { readerPageNumbering } from "../bookPageNumbering.js";
import { editProposalMessage, editProposalSummary, operationQueuedMessage, readerPagesPhrase } from "./bookEditCopy.js";

function editIntent(overrides: Partial<BookEditIntent>): BookEditIntent {
  return {
    kind: "page_rewrite",
    confidence: 0.9,
    reasoning: "r",
    assistantMessage: "a",
    affectedPageIndexes: [],
    scope: "none",
    impact: "style_rewrite",
    clarification: "none",
    ...overrides
  };
}

describe("a picture replacement's card", () => {
  it("names the page a picture is on when nothing describes the picture itself", () => {
    const intent = editIntent({
      kind: "add_image",
      affectedPageIndexes: [2],
      imageEdit: {
        subject: "Pim hugging the firefly",
        placement: "page",
        pageIndex: 2,
        replace: { operationId: "", assetId: "asset-2", oldSubject: "the illustration on page 2" }
      }
    } as Partial<BookEditIntent>);
    expect(editProposalSummary("add_image", [2], intent)).toBe(
      "Replace the illustration on page 2 with one of “Pim hugging the firefly”"
    );
  });
});

describe("a text edit's card sentence", () => {
  it("opens with a capital however the reader typed it, and leaves the stored instruction alone", () => {
    const intent = editIntent({
      kind: "local_patch",
      editInstruction: "replace the word Biscuit with Marmalade everywhere"
    });
    expect(editProposalMessage(intent.kind, [1, 2], intent)).toBe(
      "Replace the word Biscuit with Marmalade everywhere. Tap Apply to confirm, or Cancel to drop it."
    );
    expect(intent.editInstruction).toBe("replace the word Biscuit with Marmalade everywhere");
    // Not every script has case; those sentences pass through as typed.
    const persian = editIntent({ kind: "local_patch", editInstruction: "کلمه گربه را با پیشی عوض کن" });
    expect(editProposalSummary(persian.kind, [1], persian)).toBe("کلمه گربه را با پیشی عوض کن");
  });
});

describe("continuation and replan proposal contracts", () => {
  it("shows the resolved continuation instruction instead of contextual request copy", () => {
    const editInstruction =
      "Continue with two chapters in which Mina finds the missing map, follows it to the lighthouse, and reconciles with Arun.";
    const intent = editIntent({
      kind: "continue_book",
      // This models the contextual/raw wording that must not replace the
      // router's standalone contract on either proposal surface.
      assistantMessage: "Yes, do that for two more chapters.",
      editInstruction,
      continuation: { chapterCount: 2 }
    });

    expect(editProposalSummary(intent.kind, [], intent)).toBe(
      `Write 2 new chapters continuing your book: ${editInstruction}`
    );
    expect(editProposalMessage(intent.kind, [], intent)).toBe(
      `Write 2 new chapters continuing your book: ${editInstruction} Tap Apply to confirm, or Cancel to drop it.`
    );
    expect(editProposalSummary(intent.kind, [], intent)).not.toContain(intent.assistantMessage);
  });

  it("ends the summary's sentence once, whether or not the instruction already did", () => {
    const ended = editIntent({ kind: "local_patch", editInstruction: "Replace every \"tray\" with \"saucer\"." });
    const unended = editIntent({ kind: "local_patch", editInstruction: "Replace every \"tray\" with \"saucer\"" });
    for (const intent of [ended, unended]) {
      const message = editProposalMessage(intent.kind, [], intent);
      expect(message).not.toContain("..");
      expect(message).toMatch(/[^.]\. Tap Apply to confirm/);
    }
  });

  it("shows the resolved replan instruction alongside the priced rebuild settings", () => {
    const editInstruction =
      "Rebuild the book as a concise three-page guide for first-time managers, using examples from remote teams and no illustrations.";
    const intent = editIntent({
      kind: "book_replan",
      assistantMessage: "Yes, make those changes.",
      editInstruction,
      impact: "structural_replan",
      replanSettings: { targetPages: 3, fullIllustrations: false }
    });

    expect(editProposalSummary(intent.kind, [], intent)).toBe(
      `Rebuild as a new 3-page copy without illustrations: ${editInstruction}`
    );
    expect(editProposalMessage(intent.kind, [], intent)).toContain(editInstruction);
    expect(editProposalSummary(intent.kind, [], intent)).not.toContain(intent.assistantMessage);
  });

  it("keeps safe action-only copy for legacy intents without a durable instruction", () => {
    const continuation = editIntent({
      kind: "continue_book",
      continuation: { chapterCount: 1 }
    });
    const replan = editIntent({
      kind: "book_replan",
      impact: "structural_replan",
      replanSettings: { targetPages: 5 }
    });

    expect(editProposalSummary(continuation.kind, [], continuation)).toBe("Write the next chapter of your book");
    expect(editProposalSummary(replan.kind, [], replan)).toBe("Rebuild as a new 5-page copy");
  });
});

/**
 * The prose a structural edit promises.
 *
 * Every assertion here is also a guard against the copy printing `undefined`:
 * `structuralEdit` is optional on the intent, so anything read off it has to be
 * defaulted *and then printed from that default* — reading the raw optional a
 * second time is how "I'll write undefined new pages" gets promised to a reader
 * who is about to be charged for it.
 */
describe("structural page edit copy", () => {
  const structuralIntent = (structuralEdit?: NonNullable<BookEditIntent["structuralEdit"]>): BookEditIntent => ({
    kind: "restructure_pages",
    confidence: 0.9,
    reasoning: "r",
    assistantMessage: "a",
    affectedPageIndexes: [],
    scope: "none",
    impact: "style_rewrite",
    clarification: "none",
    ...(structuralEdit ? { structuralEdit } : {})
  });

  const insert = (pageCount: number, anchorPageIndex: number | null = null) =>
    structuralIntent({ action: "insert", anchorPageIndex, pageIndexes: [], pageCount });

  it("says how many pages an insert writes, and never says undefined", () => {
    expect(operationQueuedMessage("restructure_pages", [], insert(3))).toBe(
      "I’ll write 3 new pages in your book’s voice, renumber the rest of the book and refresh the exports."
    );
    expect(operationQueuedMessage("restructure_pages", [], insert(1))).toBe(
      "I’ll write a new page in your book’s voice, renumber the rest of the book and refresh the exports."
    );
  });

  it("falls back to a single page when the intent carries no structural edit", () => {
    // `structuralEditForProposal` reads a missing edit as an insert of one
    // page, so the reply has to say the same thing — and above all must not
    // interpolate the absent count into the sentence.
    const message = operationQueuedMessage("restructure_pages", [], structuralIntent());
    expect(message).not.toContain("undefined");
    expect(message).toBe(
      "I’ll write a new page in your book’s voice, renumber the rest of the book and refresh the exports."
    );
    expect(editProposalSummary("restructure_pages", [], structuralIntent())).not.toContain("undefined");
  });

  it("counts the pages a delete or a move names", () => {
    const deletion = (pageIndexes: number[]) =>
      structuralIntent({ action: "delete", anchorPageIndex: null, pageIndexes, pageCount: 0 });
    const move = (pageIndexes: number[]) =>
      structuralIntent({ action: "move", anchorPageIndex: 4, pageIndexes, pageCount: 0 });

    expect(operationQueuedMessage("restructure_pages", [], deletion([3]))).toBe(
      "I’ll take that page out, renumber the rest of the book and refresh the exports."
    );
    expect(operationQueuedMessage("restructure_pages", [], deletion([3, 5]))).toBe(
      "I’ll take those pages out, renumber the rest of the book and refresh the exports."
    );
    expect(operationQueuedMessage("restructure_pages", [], move([2]))).toBe(
      "I’ll move that page, renumber the rest of the book and refresh the exports."
    );
    expect(operationQueuedMessage("restructure_pages", [], move([2, 3]))).toBe(
      "I’ll move those pages, renumber the rest of the book and refresh the exports."
    );
  });

  it("names the count and the place on the proposal card", () => {
    expect(editProposalSummary("restructure_pages", [], insert(2, 1))).toBe("Add 2 new pages after page 1");
    expect(editProposalSummary("restructure_pages", [], insert(1, 0))).toBe("Add 1 new page at the front of the book");
    expect(editProposalSummary("restructure_pages", [], insert(1))).toBe("Add 1 new page at the end of the book");
  });

  it("uses the durable execution instruction as the proposal promise", () => {
    const intent = insert(1);
    intent.editInstruction =
      "Add a closing page that presents the survivor’s outcome as positive and recommends it to other couples.";

    expect(editProposalSummary("restructure_pages", [], intent)).toBe(intent.editInstruction);
  });

  it("names where a move lands, and says nothing when the request named nowhere", () => {
    const move = (anchorPageIndex: number | null) =>
      structuralIntent({ action: "move", anchorPageIndex, pageIndexes: [2], pageCount: 0 });

    expect(editProposalSummary("restructure_pages", [], move(4))).toBe("Move page 2 after page 4");
    expect(editProposalSummary("restructure_pages", [], move(0))).toBe("Move page 2 to the front of the book");
    // A move with no destination is one `resolveStructuralPageEdit` refuses, so
    // it never reaches a card — and the sentence used to answer it "to the
    // front of the book" anyway, which is a place the reader never named. The
    // same clause is dropped for an anchor the page map cannot place, where the
    // card really is reachable.
    expect(editProposalSummary("restructure_pages", [], move(null))).toBe("Move page 2");
  });

  it("does not interpolate an empty printed list into a delete or move card", () => {
    // Version-2 cover sheet: model page 1 lives only on PDF page 1, which has
    // no printed number, so displayPages([1]) is [] even though the index is known.
    const numbering = readerPageNumbering({
      version: 2,
      totalPdfPages: 4,
      hasCoverPage: true,
      pages: [
        { index: 1, startPdfPage: 1, endPdfPage: 1 },
        { index: 2, startPdfPage: 1, endPdfPage: 1 }
      ]
    });
    const deletion = (pageIndexes: number[]) =>
      structuralIntent({ action: "delete", anchorPageIndex: null, pageIndexes, pageCount: 0 });
    const move = (pageIndexes: number[], anchorPageIndex: number | null = null) =>
      structuralIntent({ action: "move", anchorPageIndex, pageIndexes, pageCount: 0 });

    const removeOne = editProposalSummary("restructure_pages", [], deletion([1]), numbering);
    expect(removeOne).not.toContain("Remove pages ");
    expect(removeOne).not.toMatch(/pages $/);
    expect(removeOne).toBe("Remove that page");

    const removeMany = editProposalSummary("restructure_pages", [], deletion([1, 2]), numbering);
    expect(removeMany).not.toContain("Remove pages ");
    expect(removeMany).toBe("Remove those pages");

    expect(editProposalSummary("restructure_pages", [], move([1]), numbering)).toBe("Move that page");
    expect(editProposalSummary("restructure_pages", [], move([1, 2]), numbering)).toBe("Move those pages");
    expect(editProposalSummary("restructure_pages", [], move([1], 0), numbering)).toBe(
      "Move that page to the front of the book"
    );
  });
});

describe("readerPagesPhrase", () => {
  // Undo of a seven-page word swap said "I restored pages 3, 4, 6, 7, 9, 11,
  // 12" — model indexes — beside a card naming printed pages 3, 4, 5, 6 +5 more.
  const numbering = readerPageNumbering({
    version: 2,
    totalPdfPages: 14,
    hasCoverPage: true,
    pages: [
      { index: 1, startPdfPage: 1, endPdfPage: 1 },
      { index: 3, startPdfPage: 4, endPdfPage: 5 },
      { index: 4, startPdfPage: 5, endPdfPage: 6 },
      { index: 6, startPdfPage: 7, endPdfPage: 8 },
      { index: 12, startPdfPage: 13, endPdfPage: 14 }
    ]
  });

  it("names the printed pages, not the model indexes", () => {
    expect(readerPagesPhrase([3], numbering)).toBe("pages 3 and 4");
    expect(readerPagesPhrase([3, 4, 6, 12], numbering)).toBe("pages 3, 4, 5, 6 and 3 more");
  });

  it("never prints an empty list", () => {
    expect(readerPagesPhrase([1], numbering)).toBe("that page");
  });

  it("keeps model indexes when the book has no page map", () => {
    expect(readerPagesPhrase([2])).toBe("page 2");
    expect(readerPagesPhrase([2, 5])).toBe("pages 2 and 5");
  });

  it("names a verified swap's pages in the queued reply, never the whole book", () => {
    const intent = editIntent({ kind: "local_patch", scope: "all_pages", affectedPageIndexes: [3, 4, 6] });
    expect(operationQueuedMessage("local_patch", [3, 4, 6], intent, numbering)).toBe(
      "I’ll edit the whole book and refresh the exports."
    );
    expect(operationQueuedMessage("local_patch", [3, 4, 6], intent, numbering, { exact: true })).toBe(
      "I’ll make that change on pages 3, 4, 5, 6 and 1 more and refresh the exports."
    );
  });
});
