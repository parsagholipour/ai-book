import { describe, expect, it } from "vitest";
import { resolveStructuralPageEdit, type ExistingPage, type StructuralPageEdit } from "@book-maker/core";
import { type BookEditIntent, type BookEditPageContext } from "../bookEditIntent.js";
import { structuralPageEditFromMessage } from "../bookEditStructure.js";
import { MODEL_PAGE_NUMBERING } from "../bookPageNumbering.js";
import {
  canonicalStructuralEditInstruction,
  compoundStructuralReplanIntent,
  structuralCardPlanOf
} from "./structuralPageEdits.js";

/**
 * The durable half of a structural edit: the one string the proposal card
 * prints, `BookEditOperation.editInstruction` stores, and `replanBook.ts` hands
 * `strategy.revisePlan` as the whole-book brief when it turns out to be
 * compound. `structuralPageEdits.test.ts` covers the card and the resolver and
 * sits at its size budget, so the cases pinning *what that string says* — and
 * what it costs — live here beside it.
 */

const PAGES: ExistingPage[] = [1, 2, 3, 4, 5].map((index) => ({
  id: `page-${index}`,
  index,
  chapterId: null
}));
const TWENTY_PAGES: ExistingPage[] = Array.from({ length: 20 }, (_, offset) => ({
  id: `page-${offset + 1}`,
  index: offset + 1,
  chapterId: null
}));

const remove = (...pageIndexes: number[]): StructuralPageEdit => ({
  action: "delete",
  anchorPageIndex: null,
  pageIndexes,
  pageCount: 0
});
const carry = (anchorPageIndex: number | null, ...pageIndexes: number[]): StructuralPageEdit => ({
  action: "move",
  anchorPageIndex,
  pageIndexes,
  pageCount: 0
});
const write = (anchorPageIndex: number | null, pageCount = 1): StructuralPageEdit => ({
  action: "insert",
  anchorPageIndex,
  pageIndexes: [],
  pageCount
});

/**
 * Both halves of the contract, built the way `proposeBookEdit` builds them: one
 * resolved plan, the canonical instruction off it, then the repricing question
 * asked of that instruction rather than of the request — which is the order the
 * route uses, and the only order in which the two can be shown to agree.
 */
function contractFor(
  edit: StructuralPageEdit,
  request: string,
  pages: ExistingPage[] = PAGES
): { instruction: string; replan: BookEditIntent | null } {
  const resolved = resolveStructuralPageEdit(edit, pages);
  if (!resolved.ok) {
    throw new Error(`expected a plan, got refusal ${resolved.reason}`);
  }
  const intent: BookEditIntent = {
    kind: "restructure_pages",
    confidence: 0.9,
    reasoning: "structural",
    affectedPageIndexes: [],
    assistantMessage: "",
    scope: "none",
    impact: "structural_replan",
    clarification: "none",
    structuralEdit: edit,
    editInstruction: request
  };
  const plan = structuralCardPlanOf(intent, resolved.plan);
  const instruction = canonicalStructuralEditInstruction({ intent, numbering: MODEL_PAGE_NUMBERING, plan });
  return { instruction, replan: compoundStructuralReplanIntent({ ...intent, editInstruction: instruction }, plan) };
}

describe("the durable instruction a structural edit is approved and executed under", () => {
  /**
   * The commonest phrasing there is. A reader looking at a page says "remove
   * this page", and the generic page object read every determiner but the two
   * demonstratives — so a delete the resolver had already pinned to one row was
   * routed to `book_replan`, which copies the project and regenerates the whole
   * book at whole-book credits while the reader's own book keeps the page.
   */
  it.each([
    [remove(4), "Remove this page", "Remove page 4"],
    [remove(4), "Delete this page", "Remove page 4"],
    [remove(4, 5), "Remove these pages", "Remove pages 4, 5"],
    [carry(5, 4), "Move this page to the end", "Move page 4 after page 5"]
  ] as const)("keeps a demonstrative page edit on the free structural path: %#", (edit, request, expected) => {
    const { instruction, replan } = contractFor(edit, request);
    expect(instruction).toBe(expected);
    expect(replan).toBeNull();
  });

  /**
   * The article used to be legal where a page *number* goes and carried no word
   * boundary, so the delete prefix consumed "Delete the page a" and left
   * "bout the storm" — capitalised into "Bout the storm" and shipped as the
   * brief a paid book was replanned from. The request is ambiguous enough to
   * stay conservative; what it may never be is a sliced word.
   */
  it("never briefs a replan from a sliced word", () => {
    const { instruction, replan } = contractFor(remove(4), "Delete the page about the storm");
    expect(instruction).toBe("Remove page 4. Content requirements: Delete the page about the storm.");
    expect(instruction).not.toContain("Bout the storm");
    expect(replan).toMatchObject({ kind: "book_replan" });
  });

  /**
   * The free path is not an English-speaker's path. Neither the closed English
   * grammar nor a budget on what it could not read could answer these: the
   * first knows none of the verbs, and the second cannot separate "Slett side
   * 4" from a request that also asks for a rewrite.
   */
  it.each([
    [remove(4), "Supprime la page 4"],
    [remove(4), "Supprimez la page 4 du livre"],
    [remove(4), "Sayfa 4'ü sil"],
    [remove(4), "Slett side 4"],
    [remove(4), "Usuń stronę 4"],
    [remove(4), "صفحه ۴ را حذف کن"]
  ] as const)("charges nothing for a bare page delete in another language: %#", (edit, request) => {
    const { instruction, replan } = contractFor(edit, request);
    expect(instruction).toBe("Remove page 4");
    expect(replan).toBeNull();
  });

  /**
   * The expensive direction, and the one worth failing on. A reader who asks
   * for two things and is delivered one is told nothing at all: the canonical
   * instruction drops the rewrite, `guardCompoundStructuralDelivery` in the
   * worker re-reads that same instruction and agrees, and the row deletion
   * lands alone. So the requirement has to survive into the instruction.
   */
  it.each([
    [remove(4), "صفحه ۴ را حذف کن و بامزه‌ترش کن"],
    [remove(4), "删除第4页并让它更有趣"],
    [remove(4), "4ページを削除して面白くして"],
    [remove(4), "4페이지 삭제하고 더 재미있게"],
    [remove(4), "Supprime la page 4 et rends la fin plus drôle"],
    [remove(4), "Usuń stronę 4 i zmień zakończenie"]
  ] as const)("keeps the rewrite half of a compound request in the contract: %#", (edit, request) => {
    const { instruction, replan } = contractFor(edit, request);
    expect(instruction).toBe(`Remove page 4. Content requirements: ${request}.`);
    expect(replan).toMatchObject({ kind: "book_replan", replanSettings: { targetPages: 4 } });
  });
});

/**
 * The same contract, but with the *message* deciding the edit, because that is
 * the pairing the repricing bug lived in: `structuralPageEditFromMessage` reads
 * a request into an edit off its own verb lists, and the core grammar is then
 * asked what is left once that edit's clause is gone.
 */
const MESSAGE_PAGES: BookEditPageContext[] = PAGES.map((page) => ({
  id: page.id,
  index: page.index,
  title: `Page ${page.index}`,
  summary: "",
  previewText: ""
}));
const TWENTY_MESSAGE_PAGES: BookEditPageContext[] = TWENTY_PAGES.map((page) => ({
  id: page.id,
  index: page.index,
  title: `Page ${page.index}`,
  summary: "",
  previewText: ""
}));

function contractForMessage(
  message: string,
  pages: BookEditPageContext[] = MESSAGE_PAGES
): { action: string; instruction: string; replan: BookEditIntent | null } {
  const recognised = structuralPageEditFromMessage(message, pages, {});
  if (!recognised) {
    throw new Error(`expected a structural recognition for ${JSON.stringify(message)}`);
  }
  const existingPages = pages.map(({ id, index }) => ({ id, index, chapterId: null }));
  const { instruction, replan } = contractFor(recognised.edit, message, existingPages);
  return { action: recognised.edit.action, instruction, replan };
}

describe("the verbs the model-free recogniser and the core grammar have to share", () => {
  /**
   * The API parser has always resolved spoken existing-page numbers through
   * twenty. Core stopped at ten when it removed that same clause from the
   * durable instruction, so the leftover request was labelled prose and a
   * free row edit was repriced as a whole-book replan.
   */
  it.each([
    ["delete", "Delete page eleven", "Remove page 11"],
    ["delete", "Remove the twentieth page", "Remove page 20"],
    ["move", "Move page eleven after page twelve", "Move page 11 after page 12"],
    ["move", "Move the twentieth page before page eleven", "Move page 20 after page 10"]
  ] as const)(
    "keeps a spoken page reference through twenty on the free structural path: %#",
    (action, message, expected) => {
      const contract = contractForMessage(message, TWENTY_MESSAGE_PAGES);
      expect(contract.action).toBe(action);
      expect(contract.instruction).toBe(expected);
      expect(contract.replan).toBeNull();
    }
  );

  /**
   * Two copies of one grammar are two chances to be narrow, and this is the
   * expensive direction: `bookEditStructure.ts` resolved "shift page 3 to the
   * end" and "put page 3 at the end" into a free row reorder that core knew no
   * verb for, so the whole sentence survived as the content requirement and
   * `compoundStructuralReplanIntent` repriced it as a whole book regenerated.
   * `put` reached the insert list the same way and briefed a new page with
   * "Put a new page after page 3". Every verb that recogniser accepts is driven
   * through here, so widening one side alone fails rather than charging a
   * reader for a reorder.
   */
  it.each([
    ["move", "Move page 3 after page 1"],
    ["move", "Reorder page 3 after page 1"],
    ["move", "Relocate page 3 after page 1"],
    ["move", "Shift page 3 after page 1"],
    ["move", "Put page 3 after page 1"],
    ["move", "Shift page 3 to the end"],
    ["move", "Put page 3 at the end"],
    ["delete", "Delete page 3"],
    ["delete", "Remove page 3"],
    ["delete", "Drop page 3"],
    ["delete", "Cut page 3"],
    ["delete", "Get rid of page 3"],
    ["delete", "Take out page 3"],
    ["insert", "Add a page after page 3"],
    ["insert", "Insert a page after page 3"],
    ["insert", "Append a page after page 3"],
    ["insert", "Write a page after page 3"],
    ["insert", "Put a page after page 3"]
  ] as const)("leaves no requirement behind for a recognised %s: %#", (action, message) => {
    const contract = contractForMessage(message);
    expect(contract.action).toBe(action);
    expect(contract.instruction).not.toContain("Content requirements");
    expect(contract.replan).toBeNull();
  });
});

describe("what survives the structural clause", () => {
  /**
   * The article's boundary was written on the number and never on the branch
   * that ends in the page noun, so the delete and move prefixes went on ending
   * inside a word: "remove a pageant scene" was consumed as "remove a page" and
   * "ant scene" became the brief — the "Bout the storm" shape exactly. The
   * request stays conservative; what it may never be is a sliced word.
   */
  it.each([
    [remove(4), "Remove a pageant scene", "Remove page 4. Content requirements: Remove a pageant scene.", "Ant scene"],
    [
      remove(4),
      "Delete three pageants from the fair",
      "Remove page 4. Content requirements: Delete three pageants from the fair.",
      "Ants from the fair"
    ],
    [
      carry(1, 4),
      "Move three pageants to the end",
      "Move page 4 after page 1. Content requirements: Move three pageants to the end.",
      "Ants to the end"
    ]
  ] as const)("never slices the page noun out of a longer word: %#", (edit, request, expected, sliced) => {
    const { instruction } = contractFor(edit, request);
    expect(instruction).toBe(expected);
    expect(instruction).not.toContain(sliced);
  });

  /**
   * `isInsideQuotedSpan` makes a quoted span opaque so a page reference the
   * reader is *writing about* is never mistaken for a placement. Its straight
   * apostrophe was a plain toggle, and a plural possessive is shaped exactly
   * like a closing quote — so `dogs'` opened a span nothing could close, the
   * trailing placement read as quoted, and the contradictory destination
   * survived into the instruction the card prints and the drafting reads.
   */
  it.each([
    ["add a page about the dogs' first outing after page 100", "About the dogs' first outing."],
    ["add a page about the 1990s' fashion after page 100", "About the 1990s' fashion."],
    ["add a page about James' journey after page 100", "About James' journey."],
    // The curly closer and the intra-word apostrophe were never the bug, and
    // must not become one.
    ["add a page about the dogs’ first outing after page 100", "About the dogs’ first outing."],
    ["add a page about the dog's first outing after page 100", "About the dog's first outing."]
  ] as const)("drops a placement a possessive only looked like a quote around: %#", (request, requirement) => {
    const { instruction } = contractFor(write(null), request);
    expect(instruction).toBe(`Add 1 new page at the end of the book. Content requirements: ${requirement}`);
  });

  /**
   * The other side of the same rule: a placement the reader really did quote is
   * still theirs, and so is one an opened span has not closed yet.
   */
  it.each([
    ["add a page about 'the storm after page 4' and the rescue", "About 'the storm after page 4' and the rescue."],
    ['add a page about "the storm after page 4" and the rescue', 'About "the storm after page 4" and the rescue.']
  ] as const)("keeps a placement inside a quoted span: %#", (request, requirement) => {
    const { instruction } = contractFor(write(null), request);
    expect(instruction).toBe(`Add 1 new page at the end of the book. Content requirements: ${requirement}`);
  });
});
