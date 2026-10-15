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

describe("a router's paraphrase of a bare structural request", () => {
  /**
   * Live, 2026-10-02: "delete page 5" came back from the router as "Delete
   * printed page 5 from the book, removing the content that appears on that
   * page". The grammar strips neither "printed" nor the restating tail, so the
   * leftover was read as a content requirement and the card quoted a whole
   * rebuild at 540 credits for a free row deletion.
   */
  function contractWithParaphrase(edit: StructuralPageEdit, request: string, paraphrase: string) {
    const resolved = resolveStructuralPageEdit(edit, PAGES);
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
      editInstruction: paraphrase
    };
    const plan = structuralCardPlanOf(intent, resolved.plan);
    const instruction = canonicalStructuralEditInstruction({ intent, numbering: MODEL_PAGE_NUMBERING, plan, request });
    return { instruction, replan: compoundStructuralReplanIntent({ ...intent, editInstruction: instruction }, plan) };
  }

  it("keeps the delete free when the reader asked for nothing but the delete", () => {
    const { instruction, replan } = contractWithParaphrase(
      remove(4),
      "delete page 4",
      "Delete printed page 4 from the book, removing the content that appears on that page."
    );
    expect(instruction).toBe("Remove page 4");
    expect(replan).toBeNull();
  });

  /**
   * Live, 2026-10-02: "add a page after page 11 about …" was briefed as
   * "Insert one new page immediately after printed page 11 (the final page of
   * the book, "The Weekly Reset Checklist"). The new page should be about …",
   * and the card read "Content requirements: Immediately after printed page 11
   * (…)". The adverb, "printed" and the aside naming the anchor are placement.
   */
  it.each([
    [
      'Insert one new page immediately after printed page 4 (the final page of the book, "The Weekly Reset Checklist"). The new page should be about Monday lunches.',
      "The new page should be about Monday lunches."
    ],
    ["Add a new page right after printed page 4. Cover Monday lunches.", "Cover Monday lunches."],
    ["Add a page about Monday lunches directly after printed page 4", "About Monday lunches."],
    [
      'Add one new page immediately after printed page 4, which is the final page of the book ("The Weekly Reset Checklist"). The new page should be about Monday lunches.',
      "The new page should be about Monday lunches."
    ]
  ] as const)("reads a router's placement restatement as placement: %#", (paraphrase, requirement) => {
    const { instruction } = contractWithParaphrase(write(4), "add a page after page 4 about Monday lunches", paraphrase);
    expect(instruction).toBe(`Add 1 new page after page 4. Content requirements: ${requirement}`);
  });

  it("keeps an aside that says what the new page holds", () => {
    const { instruction } = contractWithParaphrase(
      write(4),
      "add a page after page 4",
      "Add a page after page 4 (the page should cover Monday lunches)."
    );
    expect(instruction).toBe("Add 1 new page after page 4. Content requirements: (the page should cover Monday lunches).");
    expect(
      contractWithParaphrase(write(4), "add a page after page 4", "Add a page after page 4, which is where Mina should find the key.")
        .instruction
    ).toBe("Add 1 new page after page 4. Content requirements: Which is where Mina should find the key.");
  });

  it.each(["delte page 4", "please dleete page 4", "remvoe page 4"])(
    "keeps a delete free when its verb was only misspelled: %s",
    (request) => {
      // Live, 2026-10-02: "delte page 3" came back as "Delete the pages that carry
      // printed page 3: …", the restatement survived as a requirement, and the
      // free deletion was quoted as a 540-credit rebuild.
      const { instruction, replan } = contractWithParaphrase(
        remove(4),
        request,
        'Delete the pages that carry printed page 4: the page titled "Jordan Builds a Four-Dinner Week".'
      );
      expect(instruction).toBe("Remove page 4");
      expect(replan).toBeNull();
    }
  );

  it("does not read a different word as a misspelled verb", () => {
    const { replan } = contractWithParaphrase(
      remove(4),
      "summarize page 4 and then delete it",
      "Delete printed page 4 after summarizing it into page 3."
    );
    expect(replan?.kind).toBe("book_replan");
  });

  it.each([
    ["Insert one new page before the current first page. The new page should explain why dinners matter.", "The new page should explain why dinners matter."],
    ["Add a page after the existing last page. Cover leftovers.", "Cover leftovers."],
    [
      "Insert a new page at the very beginning of the book, before the current first page, that explains why family dinners matter.",
      "The new page explains why family dinners matter."
    ],
    [
      "Insert 2 new pages into the book immediately after printed page 4 and before printed page 5. The new pages should bridge the shopping list and the dinner categories.",
      "The new pages should bridge the shopping list and the dinner categories."
    ],
    ["Add 2 pages between page 4 and page 5. Cover meal prep.", "Cover meal prep."],
    ["Add 1 new page that explains why dinners matter.", "The new page explains why dinners matter."],
    [
      "Insert 2 new pages after printed page 4, so they fall between printed page 4 and printed page 5. The new pages should continue the book's flow.",
      "The new pages should continue the book's flow."
    ],
    ["Add a page after page 4. It should land right after the shopping list.", "It should land right after the shopping list."],
    [
      'Insert 2 new pages immediately after the page titled "Finish the List and Keep Moving" (printed page 4), so they fall between printed page 4 and printed page 5. The new pages should cover a schedule that shifts.',
      "The new pages should cover a schedule that shifts."
    ],
    [
      "Insert 2 new pages immediately after printed page 4 (before printed page 5), continuing the book's flow into the dinner framework.",
      "Continuing the book's flow into the dinner framework."
    ],
    [
      "Insert 2 new pages immediately after printed page 4 (internal page index 4) and before printed page 5. The new pages should bridge the two chapters.",
      "The new pages should bridge the two chapters."
    ],
    [
      'Add a page after the page titled "Finish the List. Then Rest" and explain leftovers.',
      'After the page titled "Finish the List. Then Rest" and explain leftovers.'
    ]
  ] as const)("reads an edge named by the page it borders as placement: %#", (paraphrase, requirement) => {
    const anchor = paraphrase.includes("first") ? 0 : null;
    const { instruction } = contractWithParaphrase(write(anchor), "add a page", paraphrase);
    expect(instruction).toMatch(new RegExp(`Content requirements: ${requirement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  });

  it("still prices the prose work a reader did ask for", () => {
    const { replan } = contractWithParaphrase(
      remove(4),
      "delete page 4 and rewrite page 5 so the story still flows",
      "Delete printed page 4. Rewrite page 5 so the story still flows."
    );
    expect(replan?.kind).toBe("book_replan");
  });
});

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
   * brief a paid book was replanned from. A request that asks for more stays
   * conservative; what it may never be is a sliced word. Asking for the page
   * about the storm and nothing else is the free delete it reads as.
   */
  it("never briefs a replan from a sliced word", () => {
    const { instruction, replan } = contractFor(remove(4), "Delete the page about the storm and keep its last line");
    expect(instruction).toBe(
      "Remove page 4. Content requirements: Delete the page about the storm and keep its last line."
    );
    expect(instruction).not.toContain("Bout the storm");
    expect(replan).toMatchObject({ kind: "book_replan" });
    expect(contractFor(remove(4), "Delete the page about the storm")).toMatchObject({
      instruction: "Remove page 4",
      replan: null
    });
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
    // Named from the side the reader named it: "after page 10" is the same place.
    ["move", "Move the twentieth page before page eleven", "Move page 20 before page 11"]
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
   * `quotedSpanReader` makes a quoted span opaque so a page reference the
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

describe("the content requirement's trim across the linear rewrite", () => {
  // Captured from the instruction builder as it stood before its trims, its
  // placement strips and its quoted-span scan were made linear: the string the
  // card prints and the replan briefs from may not move by a byte.
  const CORPUS: ReadonlyArray<readonly [StructuralPageEdit, string, string, string | null]> = [
    [write(2), "add a page about the storm", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page about the storm,", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page about the storm, , ,", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page about the storm —", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page about the storm –-", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page about the storm:;", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page about the storm;  ", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page about the storm ,,, x", "Add 1 new page after page 2. Content requirements: About the storm,,, x.", null],
    [write(2), "add a page about the storm, then", "Add 1 new page after page 2. Content requirements: About the storm, then.", null],
    [write(2), "add a page about the storm - and the rescue -", "Add 1 new page after page 2. Content requirements: About the storm - and the rescue.", null],
    [write(2), "add a page about the storm!", "Add 1 new page after page 2. Content requirements: About the storm!", null],
    [write(2), "add a page about the storm?,", "Add 1 new page after page 2. Content requirements: About the storm?", null],
    [write(2), "add a page about the storm .", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page about the storm , .", "Add 1 new page after page 2. Content requirements: About the storm,.", null],
    [write(2), "add a page, about the storm", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page: about the storm", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page — about the storm", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page and then about the storm", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page that explains the storm,", "Add 1 new page after page 2. Content requirements: The new page explains the storm.", null],
    [write(2), "add a page after page 2, that explains the storm;", "Add 1 new page after page 2. Content requirements: The new page explains the storm.", null],
    [write(2), "add a page after page 2 (the final page) about the storm,", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(null), "add a page about the storm after page 4,", "Add 1 new page at the end of the book. Content requirements: About the storm.", null],
    [write(null), "add a page about 'the storm, the rain' -", "Add 1 new page at the end of the book. Content requirements: About 'the storm, the rain'.", null],
    [write(null, 2), "add 2 pages about the storm and the rescue :", "Add 2 new pages at the end of the book. Content requirements: About the storm and the rescue.", null],
    [write(0), "add a page at the front about the cover story ;;", "Add 1 new page at the front of the book. Content requirements: About the cover story.", null],
    [write(2), "add a page about the storm\t,\t", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page about the storm\n,\n", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page about the storm ,\u00a0", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page about the storm，", "Add 1 new page after page 2. Content requirements: About the storm，.", null],
    [write(2), "add a page about the storm،", "Add 1 new page after page 2. Content requirements: About the storm،.", null],
    [write(2), "add a page about the storm،،", "Add 1 new page after page 2. Content requirements: About the storm،،.", null],
    [write(2), "صفحه‌ای درباره طوفان اضافه کن،", "Add 1 new page after page 2. Content requirements: صفحه‌ای درباره طوفان اضافه کن،.", null],
    [write(2), "یک صفحه درباره مینا اضافه کن -", "Add 1 new page after page 2. Content requirements: یک صفحه درباره مینا اضافه کن.", null],
    [write(2), "añade una página sobre la tormenta,", "Add 1 new page after page 2. Content requirements: Añade una página sobre la tormenta.", null],
    [write(2), "ajoute une page sur l'orage —", "Add 1 new page after page 2. Content requirements: Ajoute une page sur l'orage.", null],
    [remove(3), "delete page 3 and make it funny,", "Remove page 3. Content requirements: Make it funny.", "book_replan"],
    [remove(3), "delete page 3, and make page 4 funnier ;", "Remove page 3. Content requirements: Make page 4 funnier.", "book_replan"],
    [remove(3), "delete page 3 then rewrite page 4 –", "Remove page 3. Content requirements: Rewrite page 4.", "book_replan"],
    [remove(3), "delete page 3 from the book, and add a joke:", "Remove page 3. Content requirements: Add a joke.", "book_replan"],
    [remove(3), "delete page 3,,,", "Remove page 3", null],
    [remove(3), "delete page 3 -", "Remove page 3", null],
    [carry(4, 2), "move page 2 after page 4 and rewrite it,", "Move page 2 after page 4. Content requirements: Rewrite it.", "book_replan"],
    [carry(4, 2), "move page 2 after page 4, then shorten it -;", "Move page 2 after page 4. Content requirements: Shorten it.", "book_replan"],
    [carry(4, 2), "move page 2 from page 2 to after page 4, and add a title :", "Move page 2 after page 4. Content requirements: Add a title.", "book_replan"],
    [carry(1, 3), "move page 3 to the front and make it sad,—", "Move page 3 after page 1. Content requirements: Make it sad.", "book_replan"],
    // The placement strips, the relative clause and the quoted-span scan.
    [write(2), "add a page after page 2 , and before page 3 about the storm", "Add 1 new page after page 2. Content requirements: About the storm.", null],
    [write(2), "add a page after page 2  and  before page 3, that explains the storm", "Add 1 new page after page 2. Content requirements: The new page explains the storm.", null],
    [write(2), "add a page after page 2  that explains the storm", "Add 1 new page after page 2. Content requirements: The new page explains the storm.", null],
    [write(2), "add a page after page 2 - that explains the storm", "Add 1 new page after page 2. Content requirements: The new page explains the storm.", null],
    [write(2), "add a page after page 2,,, ;  that explains the storm", "Add 1 new page after page 2. Content requirements: The new page explains the storm.", null],
    [write(null), "add a page about the storm after page 4 after page 2", "Add 1 new page at the end of the book. Content requirements: About the storm after page 2.", null],
    [write(null), "add a page about 'the storm after page 4' after page 2", "Add 1 new page at the end of the book. Content requirements: About 'the storm after page 4'.", null],
    [write(null), "add a page about the quote after page 4 and the storm after page 2", "Add 1 new page at the end of the book. Content requirements: About the quote after page 4 and the storm after page 2.", null],
    [write(null), "add a page about the storm   after page 4", "Add 1 new page at the end of the book. Content requirements: About the storm.", null],
    [carry(4, 2), "move page 2 after page 4 , and before page 5", "Move page 2 after page 4", null],
    [carry(4, 2), "move page 2 after page 4   and shorten it", "Move page 2 after page 4. Content requirements: Shorten it.", "book_replan"]
  ];

  it("builds every instruction, and every repricing, the way it did before", () => {
    const moved = CORPUS.flatMap(([edit, request, instructionBefore, replanBefore]) => {
      const { instruction, replan } = contractFor(edit, request);
      return instruction === instructionBefore && (replan?.kind ?? null) === replanBefore
        ? []
        : [{ request, instructionBefore, instruction, replanBefore, replan: replan?.kind ?? null }];
    });
    expect(moved).toEqual([]);
  });
});

describe("the canonical instruction on adversarial input", () => {
  // The trailing trim was tried from every character of a run of commas that
  // did not reach the end: 10,000 of them took 170 ms of the API's only thread.
  // The insert's strip took one separator a pass, its placement scan tried a
  // run of spaces from every space, every placement re-read the quotes from the
  // start, and `\s*,?\s*` after a placement and before "that" split one run of
  // spaces two ways — each quadratic, 40–150 ms at 10k. Timed at 1k before 10k,
  // so a quadratic regression fails fast.
  const fill =
    (head: string, filler: string, tail = "y") =>
    (length: number): string => {
      const room = length - head.length - tail.length;
      return head + filler.repeat(Math.ceil(room / filler.length)).slice(0, room) + tail;
    };
  const ADVERSARIAL: ReadonlyArray<readonly [StructuralPageEdit, string, (length: number) => string]> = [
    [write(2), "an insert + a run of commas", fill("add a page about x", ",")],
    [write(2), "an insert + a run of dashes", fill("add a page about x", "-")],
    [write(2), "an insert + spaced semicolons", fill("add a page about x", " ;")],
    [write(2), "an insert + spaces", fill("add a page about x", " ")],
    [write(2), "an insert + spaced commas and tabs", fill("add a page", " ,\t ")],
    [write(2), "an insert + a run of separators", fill("add a page", ",")],
    [write(2), "an insert + repeated placements", fill("add a page", " after page 2")],
    [write(2), "quoted placements", fill('add a page about "x', " after page 1", '"')],
    [write(2), "placements after a cue", fill("add a page about the quote", " after page 1")],
    [write(2), "a placement + whitespace", fill("add a page after page 2", "\t  \t", "x")],
    [carry(4, 2), "a move's placement + whitespace", fill("move page 2 after page 4", " \t\n", "x")],
    [write(2), "an insert + a long number", fill("add a page about x", "21", "x")],
    [carry(4, 2), "a move + a long number", fill("move page 2 after page 4", "1", "x")],
    [remove(3), "a compound delete + a run of commas", fill("delete page 3 and make it funny", ",")],
    [carry(4, 2), "a compound move + dashes and spaces", fill("move page 2 after page 4 and shorten it", " -")]
  ];
  const readMs = (run: () => unknown): number => {
    // Best of two, so one slow read under load is not a failure.
    let best = Number.POSITIVE_INFINITY;
    for (let read = 0; read < 2; read += 1) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  it("stays linear on long runs of punctuation", () => {
    for (const [length, budgetMs] of [
      [1_000, 200],
      [10_000, 1_000]
    ] as const) {
      for (const [edit, label, build] of ADVERSARIAL) {
        const text = build(length);
        expect(text).toHaveLength(length);
        const ms = readMs(() => contractFor(edit, text));
        expect(ms, `${label} at ${length} chars: ${ms.toFixed(1)} ms`).toBeLessThan(budgetMs);
      }
    }
  });
});
