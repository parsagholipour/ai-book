import { describe, expect, it } from "vitest";
import {
  MAX_DELETED_PAGES,
  MAX_INSERTED_PAGES,
  MAX_MOVED_PAGES,
  resolveStructuralPageEdit,
  type ExistingPage,
  type StructuralPageEdit
} from "@book-maker/core";
import { type BookEditIntent } from "../bookEditIntent.js";
import {
  bookPageMapForProject,
  MODEL_PAGE_NUMBERING,
  readerPageNumbering,
  type ReaderPageNumbering
} from "../bookPageNumbering.js";
import { editProposalSummary } from "./bookEditCopy.js";
import { type MobileBookEditOperationRecord } from "./dto.js";
import { currentActionForEditOperation } from "./editOperationCopy.js";
import {
  canonicalStructuralEditInstruction,
  compoundStructuralReplanIntent,
  structuralCardBlock,
  structuralCardPlanOf,
  structuralRefusalMessage
} from "./structuralPageEdits.js";

/**
 * The card is the confirmation for an insert, a delete *and* a move, so the
 * count it prints is what the reader is agreeing to. Plans come from the real
 * resolver rather than from hand-written literals: the card reads fields the
 * resolver fills per action, and a plan built by hand would keep agreeing with
 * the card long after the two had drifted apart.
 */

const PAGES: ExistingPage[] = [1, 2, 3, 4, 5].map((index) => ({
  id: `page-${index}`,
  index,
  chapterId: null
}));

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

/** The two calls `proposeBookEdit` makes, in the order it makes them. */
function cardFor(edit: StructuralPageEdit): Record<string, unknown> {
  return surfacesFor(edit).card;
}

/**
 * The sentence and the chip of one card, built the way `proposeBookEdit` builds
 * them: one resolved plan, one numbering, two surfaces. Asserted together
 * because a placement is only right if both halves of the card say it.
 */
function surfacesFor(
  edit: StructuralPageEdit,
  numbering: ReaderPageNumbering = MODEL_PAGE_NUMBERING
): { summary: string; card: Record<string, unknown> } {
  const resolved = resolveStructuralPageEdit(edit, PAGES);
  if (!resolved.ok) {
    throw new Error(`expected a plan, got refusal ${resolved.reason}`);
  }
  const intent = intentFor(edit);
  const plan = structuralCardPlanOf(intent, resolved.plan);
  return {
    summary: editProposalSummary("restructure_pages", [], intent, numbering, plan),
    card: structuralCardBlock(intent, plan, numbering)
  };
}

function canonicalInstruction(edit: StructuralPageEdit, instruction: string, pages = PAGES): string {
  const resolved = resolveStructuralPageEdit(edit, pages);
  if (!resolved.ok) {
    throw new Error(`expected a plan, got refusal ${resolved.reason}`);
  }
  const intent = { ...intentFor(edit), editInstruction: instruction };
  return canonicalStructuralEditInstruction({
    intent,
    numbering: MODEL_PAGE_NUMBERING,
    plan: structuralCardPlanOf(intent, resolved.plan)
  });
}

describe("canonical structural edit instructions", () => {
  it("converts only compound delete/move instructions to a correctly sized replan", () => {
    const deleteIntent = {
      ...intentFor({ action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 }),
      editInstruction: "Remove page 2. Content requirements: Move its final quote to page 3."
    };
    const resolved = resolveStructuralPageEdit(deleteIntent.structuralEdit!, PAGES);
    if (!resolved.ok) throw new Error("expected delete plan");

    expect(compoundStructuralReplanIntent(deleteIntent, structuralCardPlanOf(deleteIntent, resolved.plan))).toMatchObject({
      kind: "book_replan",
      scope: "all_pages",
      editInstruction: deleteIntent.editInstruction,
      structuralEdit: deleteIntent.structuralEdit,
      replanSettings: { targetPages: 4 }
    });

    const pure = { ...deleteIntent, editInstruction: "Remove page 2" };
    expect(compoundStructuralReplanIntent(pure, structuralCardPlanOf(pure, resolved.plan))).toBeNull();

    const moveIntent = {
      ...intentFor({ action: "move", anchorPageIndex: 4, pageIndexes: [2], pageCount: 0 }),
      editInstruction: "Move page 2 after page 4. Content requirements: Preserve its final quote on page 3."
    };
    const moved = resolveStructuralPageEdit(moveIntent.structuralEdit!, PAGES);
    if (!moved.ok) throw new Error("expected move plan");
    expect(compoundStructuralReplanIntent(moveIntent, structuralCardPlanOf(moveIntent, moved.plan))).toMatchObject({
      kind: "book_replan",
      structuralEdit: { action: "move", pageIndexes: [2] },
      replanSettings: { targetPages: 5 }
    });
  });

  /**
   * The action clause and the page grammar are `@book-maker/core`'s now, and the
   * hand copy they replace was narrow in the same places core's was: "Delete the
   * last page of the book." kept "of the book" as a content requirement, and a
   * request in a language the clause cannot read kept all of itself. A canonical
   * instruction carrying a requirement nobody asked for is a whole-book replan,
   * quoted and charged for deleting one page. The language sweep is core's, in
   * `structuralInstruction.test.ts`; this is the extractor's half of it.
   */
  const bare = (action: "delete" | "move", pageIndexes: number[], anchorPageIndex: number | null) =>
    ({ action, anchorPageIndex, pageIndexes, pageCount: 0 }) as StructuralPageEdit;
  it.each([
    { source: "Delete the last page of the book.", edit: bare("delete", [5], null), expected: "Remove page 5" },
    { source: "Remove the final page of the story.", edit: bare("delete", [5], null), expected: "Remove page 5" },
    { source: "Cut page 4, thanks", edit: bare("delete", [4], null), expected: "Remove page 4" },
    { source: "صفحه ۴ را حذف کن", edit: bare("delete", [4], null), expected: "Remove page 4" },
    { source: "Move page 2 after page 4 please", edit: bare("move", [2], 4), expected: "Move page 2 after page 4" },
    { source: "صفحه ۲ را بعد از صفحه ۴ ببر", edit: bare("move", [2], 4), expected: "Move page 2 after page 4" }
  ])("leaves no content requirement on a bare page edit: $source", ({ source, edit, expected }) => {
    expect(canonicalInstruction(edit, source)).toBe(expected);
  });

  it.each([
    {
      name: "before",
      edit: { action: "insert", anchorPageIndex: 2, pageIndexes: [], pageCount: 2 } as StructuralPageEdit,
      source: "Insert two new pages before page 3 about Mina decoding the brass key.",
      expected: "Add 2 new pages after page 2. Content requirements: About Mina decoding the brass key."
    },
    {
      name: "after",
      edit: { action: "insert", anchorPageIndex: 3, pageIndexes: [], pageCount: 1 } as StructuralPageEdit,
      source: "Add a new page after page 3 that keeps the chase suspenseful.",
      expected: "Add 1 new page after page 3. Content requirements: That keeps the chase suspenseful."
    },
    {
      name: "end",
      edit: { action: "insert", anchorPageIndex: null, pageIndexes: [], pageCount: 1 } as StructuralPageEdit,
      source: "Write one new page at the end of the book where Mina returns the key.",
      expected: "Add 1 new page at the end of the book. Content requirements: Where Mina returns the key."
    }
  ])("normalizes an insert at the $name without losing its content", ({ edit, source, expected }) => {
    expect(canonicalInstruction(edit, source)).toBe(expected);
  });

  it.each([
    {
      name: "an after destination following an about phrase",
      edit: { action: "insert", anchorPageIndex: 100, pageIndexes: [], pageCount: 1 } as StructuralPageEdit,
      source: "Add a page about Mina after page 100",
      expected: "Add 1 new page after page 20. Content requirements: About Mina."
    },
    {
      name: "a before destination following an about phrase",
      edit: { action: "insert", anchorPageIndex: 99, pageIndexes: [], pageCount: 1 } as StructuralPageEdit,
      source: "Insert a page about Mina before page 100",
      expected: "Add 1 new page after page 20. Content requirements: About Mina."
    },
    {
      name: "an end destination following an about phrase",
      edit: { action: "insert", anchorPageIndex: null, pageIndexes: [], pageCount: 1 } as StructuralPageEdit,
      source: "Write a page about Mina at the end of the book",
      expected: "Add 1 new page at the end of the book. Content requirements: About Mina."
    }
  ])("removes $name after resolving the insert", ({ edit, source, expected }) => {
    const pages = Array.from({ length: 20 }, (_value, offset) => ({
      id: `page-${offset + 1}`,
      index: offset + 1,
      chapterId: null
    }));
    const canonical = canonicalInstruction(edit, source, pages);
    expect(canonical).toBe(expected);
    expect(canonicalInstruction(edit, canonical, pages)).toBe(canonical);
  });

  it("strips a move's immediate from/to coordinates but keeps its content clause", () => {
    const edit: StructuralPageEdit = { action: "move", anchorPageIndex: 4, pageIndexes: [2], pageCount: 0 };
    const canonical = canonicalInstruction(
      edit,
      "Move page 2 from page 2 to before page 5 while preserving Mina's final line."
    );

    expect(canonical).toBe(
      "Move page 2 after page 4. Content requirements: While preserving Mina's final line."
    );
    expect(canonicalInstruction(edit, canonical)).toBe(canonical);
  });

  it.each([
    'Add a page at the end of the book about Mina quoting the phrase "after page 100" exactly.',
    'Add a page at the end of the book about Mina discussing what happened after page 100.'
  ])("preserves a genuine content page reference: %s", (source) => {
    const edit: StructuralPageEdit = { action: "insert", anchorPageIndex: null, pageIndexes: [], pageCount: 1 };
    const canonical = canonicalInstruction(edit, source);
    expect(canonical).toContain("page 100");
    expect(canonicalInstruction(edit, canonical)).toBe(canonical);
  });

  it.each([
    {
      name: "a punctuation-free preserving clause",
      edit: { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 } as StructuralPageEdit,
      source: "Delete page 2 preserving its final quote on page 3",
      expected: "Remove page 2. Content requirements: Preserving its final quote on page 3."
    },
    {
      name: "a numeric range and keeping clause",
      edit: {
        action: "delete",
        anchorPageIndex: null,
        pageIndexes: [2, 3, 4],
        pageCount: 0
      } as StructuralPageEdit,
      source: "Delete pages 2-4 keeping the lighthouse reveal on page 5",
      expected: "Remove pages 2, 3, 4. Content requirements: Keeping the lighthouse reveal on page 5."
    },
    {
      name: "a copying clause with another page as its content destination",
      edit: { action: "delete", anchorPageIndex: null, pageIndexes: [2, 3], pageCount: 0 } as StructuralPageEdit,
      source: "Delete pages 2 and 3 copying their final footnote to page 5 without changing its wording",
      expected:
        "Remove pages 2, 3. Content requirements: Copying their final footnote to page 5 without changing its wording."
    },
    {
      name: "a moving clause with another page as its content destination",
      edit: { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 } as StructuralPageEdit,
      source: "Delete page 2 moving its final quote to page 3",
      expected: "Remove page 2. Content requirements: Moving its final quote to page 3."
    },
    {
      name: "a while clause",
      edit: { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 } as StructuralPageEdit,
      source: "Delete page 2 while keeping its title on page 3",
      expected: "Remove page 2. Content requirements: While keeping its title on page 3."
    },
    {
      name: "a leading so-that clause",
      edit: { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 } as StructuralPageEdit,
      source: "Delete page 2 so that page 3 opens with Mina finding the key",
      expected: "Remove page 2. Content requirements: So that page 3 opens with Mina finding the key."
    },
    {
      name: "a leading without clause",
      edit: { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 } as StructuralPageEdit,
      source: "Delete page 2 without changing the quote copied to page 3",
      expected: "Remove page 2. Content requirements: Without changing the quote copied to page 3."
    },
    {
      name: "a rewriting clause with so that",
      edit: { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 } as StructuralPageEdit,
      source: "Delete page 2 rewriting the bridge on page 3 so that Mina still finds the key",
      expected:
        "Remove page 2. Content requirements: Rewriting the bridge on page 3 so that Mina still finds the key."
    },
    {
      name: "a because clause",
      edit: { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 } as StructuralPageEdit,
      source: "Delete page 2 because it repeats the scene on page 1",
      expected: "Remove page 2. Content requirements: Because it repeats the scene on page 1."
    },
    {
      name: "a move/delete hybrid",
      edit: { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 } as StructuralPageEdit,
      source: "Delete page 2 and move its final quote to page 3",
      expected: "Remove page 2. Content requirements: Move its final quote to page 3."
    },
    {
      name: "non-English content after an unambiguous coordinate",
      edit: { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 } as StructuralPageEdit,
      source: "Delete page 2 conservando la cita final en la página 3 sin reescribirla",
      expected:
        "Remove page 2. Content requirements: Conservando la cita final en la página 3 sin reescribirla."
    },
    {
      name: "an Oxford-comma page selection",
      edit: {
        action: "delete",
        anchorPageIndex: null,
        pageIndexes: [1, 2, 3],
        pageCount: 0
      } as StructuralPageEdit,
      source: "Delete pages 1, 2, and 3 preserving the final quote on page 4",
      expected: "Remove pages 1, 2, 3. Content requirements: Preserving the final quote on page 4."
    }
  ])("keeps $name on a delete", ({ edit, source, expected }) => {
    const canonical = canonicalInstruction(edit, source);
    expect(canonical).toBe(expected);
    expect(canonicalInstruction(edit, canonical)).toBe(canonical);
  });

  it.each([
    "احذف الصفحة ٢ مع الاحتفاظ بالاقتباس الأخير في الصفحة ٣",
    "Delete the final spread while preserving its last quote on page 3"
  ])("retains an ambiguous instruction conservatively: %s", (source) => {
    const edit: StructuralPageEdit = {
      action: "delete",
      anchorPageIndex: null,
      pageIndexes: [2],
      pageCount: 0
    };
    const canonical = canonicalInstruction(edit, source);
    expect(canonical).toBe(`Remove page 2. Content requirements: ${source}.`);
    expect(canonicalInstruction(edit, canonical)).toBe(canonical);
  });

  it("keeps non-structural requirements on a move", () => {
    expect(
      canonicalInstruction(
        { action: "move", anchorPageIndex: 4, pageIndexes: [2], pageCount: 0 },
        "Move page 2 after page 4 while keeping the chapter headings unchanged."
      )
    ).toBe("Move page 2 after page 4. Content requirements: While keeping the chapter headings unchanged.");
  });

  it.each([
    {
      edit: { action: "move", anchorPageIndex: 4, pageIndexes: [2, 3], pageCount: 0 } as StructuralPageEdit,
      source: "Move pages 2 through 3 before page 5 while preserving page 4's final line",
      expected: "Move pages 2, 3 after page 4. Content requirements: While preserving page 4's final line."
    },
    {
      edit: { action: "move", anchorPageIndex: 4, pageIndexes: [2], pageCount: 0 } as StructuralPageEdit,
      source: "Move page 2 after page 5 and delete only its duplicate paragraph on page 3",
      expected:
        "Move page 2 after page 4. Content requirements: Delete only its duplicate paragraph on page 3."
    },
    {
      edit: { action: "insert", anchorPageIndex: 4, pageIndexes: [], pageCount: 1 } as StructuralPageEdit,
      source: "Add one new page after page 5 without changing page 3's opening",
      expected: "Add 1 new page after page 4. Content requirements: Without changing page 3's opening."
    }
  ])("removes only a move/insert action and its old placement", ({ edit, source, expected }) => {
    const result = canonicalInstruction(edit, source);
    expect(result).toBe(expected);
    expect(canonicalInstruction(edit, result)).toBe(result);
  });

  it("replaces a rich model instruction's impossible destination with the resolver clamp", () => {
    const pages = Array.from({ length: 20 }, (_value, offset) => ({
      id: `page-${offset + 1}`,
      index: offset + 1,
      chapterId: null
    }));
    const instruction = canonicalInstruction(
      { action: "insert", anchorPageIndex: 100, pageIndexes: [], pageCount: 1 },
      "Create one new page after page 100 that reveals Mina hid the brass key and keeps the tone ominous.",
      pages
    );

    expect(instruction).toBe(
      "Add 1 new page after page 20. Content requirements: That reveals Mina hid the brass key and keeps the tone ominous."
    );
    expect(instruction).not.toContain("100");
  });

  it("is stable when a pending proposal is canonicalized again during Apply", () => {
    const edit: StructuralPageEdit = { action: "insert", anchorPageIndex: 3, pageIndexes: [], pageCount: 1 };
    const first = canonicalInstruction(edit, "Add a page after page 3 about the missing compass.");
    expect(canonicalInstruction(edit, first)).toBe(first);
  });
});

describe("structuralCardBlock", () => {
  it("counts the pages an insert will write", () => {
    expect(cardFor({ action: "insert", anchorPageIndex: 2, pageIndexes: [], pageCount: 3 })).toMatchObject({
      action: "insert",
      pageCount: 3,
      totalPages: 8,
      afterReaderPage: 2
    });
  });

  it("marks an insert at the head of the book instead of leaving it anchorless", () => {
    // Anchor 0 is the front of the book, and the app reads a card with no
    // anchor on it as an append — so omitting the field told a reader asking
    // for a new opening page that it would be added at the end, on a card
    // whose own summary said "at the front of the book".
    const card = cardFor({ action: "insert", anchorPageIndex: 0, pageIndexes: [], pageCount: 1 });
    expect(card).toMatchObject({ action: "insert", pageCount: 1, totalPages: 6, atFrontOfBook: true });
    // Never a number: model page 0 is not a page, so there is no printed page
    // to name and the marker is the only honest thing to send.
    expect(card).not.toHaveProperty("afterReaderPage");
  });

  it("says the end of the book when the request named no place at all", () => {
    // The other reading of a missing anchor, and the one the front marker must
    // not swallow. It is the *end* rather than "after page 5": the resolver
    // clamps a null anchor to the last page, but the sentence beside this chip
    // says "at the end of the book" and the applied card says it again, so the
    // chip naming the clamp made one card speak of the same place two ways.
    // A build that predates `placement` reads a card carrying neither marker
    // nor anchor as exactly that append, which is why nothing else is sent.
    const card = cardFor({ action: "insert", anchorPageIndex: null, pageIndexes: [], pageCount: 1 });
    expect(card).toMatchObject({ action: "insert", placement: "end" });
    expect(card).not.toHaveProperty("atFrontOfBook");
    expect(card).not.toHaveProperty("afterReaderPage");
  });

  it("counts the pages a delete will remove", () => {
    expect(cardFor({ action: "delete", anchorPageIndex: null, pageIndexes: [2, 4], pageCount: 0 })).toMatchObject({
      action: "delete",
      pageCount: 2,
      totalPages: 3,
      readerPageNumbers: [2, 4]
    });
  });

  it("counts the pages a move will carry, which the plan names in neither list", () => {
    // A move creates and destroys nothing, so `newPageIndexes` and
    // `removedPageIds` are both empty; reading either reported "0 pages move".
    expect(cardFor({ action: "move", anchorPageIndex: 5, pageIndexes: [1, 2], pageCount: 0 })).toMatchObject({
      action: "move",
      pageCount: 2,
      totalPages: 5,
      readerPageNumbers: [1, 2]
    });
  });

  it("counts a single moved page once, however often the request named it", () => {
    // The resolver dedupes its selection, so the card has to as well or the
    // count would exceed the number of pages that actually travel.
    expect(cardFor({ action: "move", anchorPageIndex: 4, pageIndexes: [2, 2], pageCount: 0 })).toMatchObject({
      action: "move",
      pageCount: 1,
      totalPages: 5
    });
  });
});

/**
 * One refusal, three requests.
 *
 * `resolveStructuralPageEdit` returns `nothing_to_do` for an insert of fewer
 * than one page, for a delete or a move that named no page at all, and for a
 * move whose pages are already in the order it asked for. The reply spoke only
 * the last of those, so a deletion the router left pageless — "delete the boring
 * pages" — was answered "those pages are already where you asked me to put
 * them": a different edit, and nothing the reader could act on. Every case here
 * goes through the real resolver, because the copy is only right if it is right
 * about the refusal that actually fires.
 */
describe("what the chat says when the resolver finds nothing to do", () => {
  function refusalFor(edit: StructuralPageEdit): string {
    const resolved = resolveStructuralPageEdit(edit, PAGES);
    if (resolved.ok) {
      throw new Error("expected a refusal, got a plan");
    }
    expect(resolved.reason).toBe("nothing_to_do");
    return structuralRefusalMessage(resolved.reason, intentFor(edit), MODEL_PAGE_NUMBERING);
  }

  it("asks which page to remove when the delete named none", () => {
    expect(refusalFor({ action: "delete", anchorPageIndex: null, pageIndexes: [], pageCount: 0 })).toBe(
      "I couldn’t tell which page to remove. Tell me the page number and I’ll take it out."
    );
  });

  it("asks which page to move, and where, when the move named neither", () => {
    expect(refusalFor({ action: "move", anchorPageIndex: null, pageIndexes: [], pageCount: 0 })).toBe(
      "I couldn’t tell which page to move. Tell me the page number and where it should go."
    );
  });

  it("asks how many pages to add when the insert counted none", () => {
    expect(refusalFor({ action: "insert", anchorPageIndex: 2, pageIndexes: [], pageCount: 0 })).toBe(
      "I couldn’t tell how many pages to add. Tell me how many, and the page they should follow."
    );
  });

  it("keeps the reorder sentence for the move that is already in that order", () => {
    // The one request the sentence was written for: pages were named, they
    // resolve, and the book already holds them that way.
    expect(refusalFor({ action: "move", anchorPageIndex: 1, pageIndexes: [2], pageCount: 0 })).toBe(
      "Those pages are already where you asked me to put them, so there’s nothing to change."
    );
  });
});

/**
 * One refusal, three caps.
 *
 * `too_many_pages` is returned against `MAX_INSERTED_PAGES`, `MAX_DELETED_PAGES`
 * and `MAX_MOVED_PAGES`, and the reply only ever branched on the delete — so an
 * over-long move was told "I can add up to 10 pages at a time", which names the
 * insert cap. It reads correct only because those two caps happen to be equal;
 * the assertions below are written against the constants so that coincidence
 * cannot hide the wrong arm being taken.
 */
describe("what the chat says when the request is over a cap", () => {
  // Long enough that a delete of `MAX_DELETED_PAGES + 1` pages is over the cap
  // rather than unknown or book-emptying — both of those refuse first.
  const LONG_BOOK: ExistingPage[] = Array.from({ length: MAX_DELETED_PAGES + 5 }, (_value, offset) => ({
    id: `page-${offset + 1}`,
    index: offset + 1,
    chapterId: null
  }));

  function refusalFor(edit: StructuralPageEdit): string {
    const resolved = resolveStructuralPageEdit(edit, LONG_BOOK);
    if (resolved.ok) {
      throw new Error("expected a refusal, got a plan");
    }
    expect(resolved.reason).toBe("too_many_pages");
    return structuralRefusalMessage(resolved.reason, intentFor(edit), MODEL_PAGE_NUMBERING);
  }

  const runOf = (length: number, from: number): number[] =>
    Array.from({ length }, (_value, offset) => from + offset);

  it("names the insert cap, and the pages an insert leaves behind for the next request", () => {
    expect(
      refusalFor({ action: "insert", anchorPageIndex: 2, pageIndexes: [], pageCount: MAX_INSERTED_PAGES + 1 })
    ).toBe(`I can add up to ${MAX_INSERTED_PAGES} pages at a time. Ask again for more once these are in.`);
  });

  it("names the delete cap, which is not the insert one", () => {
    expect(
      refusalFor({
        action: "delete",
        anchorPageIndex: null,
        pageIndexes: runOf(MAX_DELETED_PAGES + 1, 1),
        pageCount: 0
      })
    ).toBe(`I can remove up to ${MAX_DELETED_PAGES} pages at a time. Try it in smaller batches.`);
  });

  it("names the move cap and asks for a smaller move, rather than offering to add pages", () => {
    // "Move pages 1 to 11 to after page 25" — the case that was answered with
    // the insert sentence, telling the reader to ask again for the rest. A move
    // does not accumulate the way an insert does: carrying ten of eleven pages
    // across leaves the eleventh somewhere new, so repeating the request would
    // name different pages.
    const refusal = refusalFor({
      action: "move",
      anchorPageIndex: LONG_BOOK.length,
      pageIndexes: runOf(MAX_MOVED_PAGES + 1, 1),
      pageCount: 0
    });
    expect(refusal).toBe(
      `I can move up to ${MAX_MOVED_PAGES} pages at a time. Name fewer pages, or split it into separate moves that each say where those pages go.`
    );
    expect(refusal).not.toContain("add up to");
  });
});

/**
 * One insert, three surfaces, one page number.
 *
 * The bubble, the chip and the card left behind after Apply are written by
 * three different modules, and only the chip used to read the resolver.
 * `resolveStructuralPageEdit` treats an anchor past the end of the book as an
 * append and clamps it, so "add a page after page 100" to a twenty-page book
 * had the chip saying page 20, the sentence above it page 100, and the applied
 * card page 100 again.
 *
 * Every assertion is in {@link MODEL_PAGE_NUMBERING}, which is the numbering a
 * book with no translatable page map still chats in — a pre-map compile or a
 * failed measurement — and the one where the unclamped number reaches the
 * reader verbatim.
 */
describe("the page an insert says it landed after", () => {
  const TWENTY_PAGES: ExistingPage[] = Array.from({ length: 20 }, (_value, offset) => ({
    id: `page-${offset + 1}`,
    index: offset + 1,
    chapterId: null
  }));

  /** The row `restructurePages` leaves behind: the request, and the pages written. */
  function appliedInsert(edit: StructuralPageEdit, newPageIndexes: number[]): MobileBookEditOperationRecord {
    return {
      id: "operation-1",
      projectId: "project-1",
      kind: "RESTRUCTURE_PAGES",
      status: "APPLIED",
      request: "Add a page after page 100.",
      classifier: { structuralEdit: edit, structuralApplication: { action: "insert" } },
      affectedPageIndexes: newPageIndexes,
      creditsCharged: 30,
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
      appliedAt: new Date("2026-08-16T00:01:00.000Z")
    };
  }

  it("is the resolver's clamped anchor on the bubble, the chip and the applied card alike", () => {
    const edit: StructuralPageEdit = { action: "insert", anchorPageIndex: 100, pageIndexes: [], pageCount: 1 };
    const intent = intentFor(edit);
    const resolved = resolveStructuralPageEdit(edit, TWENTY_PAGES);
    if (!resolved.ok) {
      throw new Error(`expected a plan, got refusal ${resolved.reason}`);
    }
    // The clamp itself, so the three sentences below are read against it rather
    // than against each other.
    expect(resolved.plan.insertAfterIndex).toBe(20);
    expect(resolved.plan.newPageIndexes).toEqual([21]);

    const structuralPlan = structuralCardPlanOf(intent, resolved.plan);
    expect(structuralCardBlock(intent, structuralPlan, MODEL_PAGE_NUMBERING)).toMatchObject({
      afterReaderPage: 20
    });
    expect(
      editProposalSummary("restructure_pages", [], intent, MODEL_PAGE_NUMBERING, structuralPlan)
    ).toBe("Add 1 new page after page 20");
    expect(
      currentActionForEditOperation(
        appliedInsert(edit, resolved.plan.newPageIndexes),
        MODEL_PAGE_NUMBERING
      )
    ).toBe("1 new page added after page 20.");
  });

  it("still speaks the request's own reading of the front and the end of the book", () => {
    // The two placements the resolver collapses: it clamps a null anchor to the
    // last page, so only the request can say the reader named no place at all.
    const front: StructuralPageEdit = { action: "insert", anchorPageIndex: 0, pageIndexes: [], pageCount: 1 };
    const append: StructuralPageEdit = { action: "insert", anchorPageIndex: null, pageIndexes: [], pageCount: 2 };
    const planFor = (edit: StructuralPageEdit) => {
      const resolved = resolveStructuralPageEdit(edit, TWENTY_PAGES);
      if (!resolved.ok) {
        throw new Error(`expected a plan, got refusal ${resolved.reason}`);
      }
      return resolved.plan;
    };

    const summaryFor = (edit: StructuralPageEdit) =>
      editProposalSummary(
        "restructure_pages",
        [],
        intentFor(edit),
        MODEL_PAGE_NUMBERING,
        structuralCardPlanOf(intentFor(edit), planFor(edit))
      );

    expect(summaryFor(front)).toBe("Add 1 new page at the front of the book");
    expect(summaryFor(append)).toBe("Add 2 new pages at the end of the book");
    expect(currentActionForEditOperation(appliedInsert(front, [1]), MODEL_PAGE_NUMBERING)).toBe(
      "1 new page added at the front of the book."
    );
    expect(currentActionForEditOperation(appliedInsert(append, [21, 22]), MODEL_PAGE_NUMBERING)).toBe(
      "2 new pages added at the end of the book."
    );
  });
});

/**
 * A model page is a *range* of printed sheets, and "after page N" names the far
 * end of it.
 *
 * `anchorPageIndexFromDecision` already resolves an "after" anchor with
 * `Math.max` over the model pages a printed number widens to — the whole reason
 * the two numbering systems need translating at all — while the three copy
 * surfaces read `displayPage`, which is the *first* sheet the anchor prints on.
 * So an insert after a model page spanning printed 3–4 promised page 3 on the
 * chip, in the bubble and on the applied card, and then wrote the pages after
 * printed 4: the one number on the card, wrong on every surface at once.
 */
describe("an anchor whose model page prints across two sheets", () => {
  // Cover on PDF 1 (unnumbered), Contents on PDF 2 (printed 1), then the prose.
  // Model page 2 runs PDF 4–5, i.e. printed 3–4.
  const SPANNING_MAP = {
    version: 2,
    totalPdfPages: 9,
    hasCoverPage: true,
    contentsStartPdfPage: 2,
    pages: [
      { index: 1, startPdfPage: 3, endPdfPage: 3 },
      { index: 2, startPdfPage: 4, endPdfPage: 5 },
      { index: 3, startPdfPage: 6, endPdfPage: 6 },
      { index: 4, startPdfPage: 7, endPdfPage: 7 },
      { index: 5, startPdfPage: 8, endPdfPage: 9 }
    ],
    contentRevision: 4
  };
  const numbering = readerPageNumbering(
    bookPageMapForProject({ pdfPageMap: SPANNING_MAP, contentRevision: 4 })
  );

  it("names the sheet the new pages actually follow, on all three surfaces", () => {
    // The divergence the assertions below turn on: the reader calls model page 2
    // "page 3", and what follows it starts after printed page 4.
    expect(numbering.displayPage(2)).toBe(3);
    expect(numbering.displayPageEnd(2)).toBe(4);

    const edit: StructuralPageEdit = { action: "insert", anchorPageIndex: 2, pageIndexes: [], pageCount: 2 };
    const intent = intentFor(edit);
    const resolved = resolveStructuralPageEdit(edit, PAGES);
    if (!resolved.ok) {
      throw new Error(`expected a plan, got refusal ${resolved.reason}`);
    }
    expect(resolved.plan.newPageIndexes).toEqual([3, 4]);

    const structuralPlan = structuralCardPlanOf(intent, resolved.plan);
    expect(structuralCardBlock(intent, structuralPlan, numbering)).toMatchObject({ afterReaderPage: 4 });
    expect(editProposalSummary("restructure_pages", [], intent, numbering, structuralPlan)).toBe(
      "Add 2 new pages after page 4"
    );
    // The applied card reads the anchor back off the pages the apply wrote, and
    // an insert leaves the anchor's own span where it was — so the confirmation
    // after the fact names the same sheet the proposal did.
    expect(
      currentActionForEditOperation(
        {
          id: "operation-1",
          projectId: "project-1",
          kind: "RESTRUCTURE_PAGES",
          status: "APPLIED",
          request: "Add two pages after page 3.",
          classifier: { structuralEdit: edit, structuralApplication: { action: "insert" } },
          affectedPageIndexes: resolved.plan.newPageIndexes,
          creditsCharged: 60,
          createdAt: new Date("2026-08-16T00:00:00.000Z"),
          appliedAt: new Date("2026-08-16T00:01:00.000Z")
        } satisfies MobileBookEditOperationRecord,
        numbering
      )
    ).toBe("2 new pages added after page 4.");
  });

  it("puts a move's destination past the whole anchor page too", () => {
    // A move's anchor is the same "after" anchor, and the pages it carries are
    // still named by every sheet they print on.
    const edit: StructuralPageEdit = { action: "move", anchorPageIndex: 2, pageIndexes: [5], pageCount: 0 };
    expect(editProposalSummary("restructure_pages", [], intentFor(edit), numbering)).toBe(
      "Move pages 7, 8 after page 4"
    );
    // And the chip beside that sentence names the same sheet, rather than the
    // first of the anchor's two.
    expect(surfacesFor(edit, numbering).card).toMatchObject({ placement: "after", afterReaderPage: 4 });
  });

  it("keeps naming every printed sheet a deleted page covers", () => {
    // Unchanged behaviour: a delete names the pages themselves rather than an
    // anchor, so both ends of the span belong in the sentence.
    const edit: StructuralPageEdit = { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 };
    expect(editProposalSummary("restructure_pages", [], intentFor(edit), numbering)).toBe("Remove pages 3, 4");
  });

  it("drops the numbers from a delete whose pages print on the unnumbered cover", () => {
    const coverOnly = readerPageNumbering({
      version: 2,
      totalPdfPages: 4,
      hasCoverPage: true,
      pages: [{ index: 1, startPdfPage: 1, endPdfPage: 1 }]
    });
    const edit: StructuralPageEdit = { action: "delete", anchorPageIndex: null, pageIndexes: [1], pageCount: 0 };
    const summary = editProposalSummary("restructure_pages", [], intentFor(edit), coverOnly);
    expect(summary).not.toContain("Remove pages ");
    expect(summary).not.toMatch(/pages $/);
    expect(summary).toBe("Remove that page");
  });
});

/**
 * One placement, both halves of the card.
 *
 * The three places a structural edit can put its pages were written out twice —
 * as prose in `structuralProposalSummary` and as wire fields in
 * `structuralCardBlock` — and the copies had already drifted: both fields were
 * gated on `action === "insert"`, so the chip beside "Move page 2 after page 4"
 * named no destination at all. Every case below asserts the sentence and the
 * chip together, because that is the only way a placement can be said to agree.
 */
describe("the placement the sentence and the chip both name", () => {
  it("says the same thing three ways for the three places an insert can land", () => {
    const front = surfacesFor({ action: "insert", anchorPageIndex: 0, pageIndexes: [], pageCount: 1 });
    expect(front.summary).toBe("Add 1 new page at the front of the book");
    expect(front.card).toMatchObject({ placement: "front", atFrontOfBook: true });

    const after = surfacesFor({ action: "insert", anchorPageIndex: 2, pageIndexes: [], pageCount: 2 });
    expect(after.summary).toBe("Add 2 new pages after page 2");
    expect(after.card).toMatchObject({ placement: "after", afterReaderPage: 2 });

    const end = surfacesFor({ action: "insert", anchorPageIndex: null, pageIndexes: [], pageCount: 1 });
    expect(end.summary).toBe("Add 1 new page at the end of the book");
    expect(end.card).toMatchObject({ placement: "end" });
    expect(end.card).not.toHaveProperty("afterReaderPage");
  });

  it("names a move's destination on the chip, not in the sentence alone", () => {
    const edit: StructuralPageEdit = { action: "move", anchorPageIndex: 4, pageIndexes: [2], pageCount: 0 };
    // The trap the shared resolution has to avoid: `resolveStructuralPageEdit`
    // fills `insertAfterIndex` for an insert and leaves it `0` on every other
    // plan, so a move whose destination were read off the plan — the way an
    // insert's is — would report every move as going to the front of the book.
    const resolved = resolveStructuralPageEdit(edit, PAGES);
    if (!resolved.ok) {
      throw new Error(`expected a plan, got refusal ${resolved.reason}`);
    }
    expect(resolved.plan.insertAfterIndex).toBe(0);

    const { summary, card } = surfacesFor(edit);
    expect(summary).toBe("Move page 2 after page 4");
    expect(card).toMatchObject({ action: "move", placement: "after", afterReaderPage: 4, readerPageNumbers: [2] });
    expect(card).not.toHaveProperty("atFrontOfBook");
  });

  it("marks a move to the head of the book the way an insert there is marked", () => {
    const { summary, card } = surfacesFor({ action: "move", anchorPageIndex: 0, pageIndexes: [3], pageCount: 0 });
    expect(summary).toBe("Move page 3 to the front of the book");
    // Model page 0 is not a page, so the front is marked rather than numbered —
    // for a move for the same reason it is for an insert.
    expect(card).toMatchObject({ action: "move", placement: "front", atFrontOfBook: true });
    expect(card).not.toHaveProperty("afterReaderPage");
  });

  it("gives a delete no destination on either surface", () => {
    const { summary, card } = surfacesFor({ action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 });
    expect(summary).toBe("Remove page 2");
    expect(card).toMatchObject({ action: "delete", placement: "unnamed" });
    expect(card).not.toHaveProperty("afterReaderPage");
    expect(card).not.toHaveProperty("atFrontOfBook");
  });
});

/**
 * A destination the map cannot place is left out of both halves.
 *
 * An edit whose recompile has not published yet leaves the book holding pages
 * the in-force map was measured before: the map places the first three model
 * pages and knows nothing of the two an earlier edit added. `displayPageEnd`
 * answers such a page with the model index — the right degradation inside a
 * *list* of pages, and the wrong one for a place, because "after page 4" is read
 * as a printed number and printed 4 is a different page here. So the sentence
 * and the chip both ask `printedPageEnd` and both say nothing when it has no
 * answer, exactly as the applied insert's card already does.
 */
describe("an anchor no printed page holds", () => {
  const PARTIAL_MAP = {
    version: 2,
    totalPdfPages: 5,
    hasCoverPage: true,
    contentsStartPdfPage: 2,
    pages: [
      { index: 1, startPdfPage: 3, endPdfPage: 3 },
      { index: 2, startPdfPage: 4, endPdfPage: 4 },
      { index: 3, startPdfPage: 5, endPdfPage: 5 }
    ],
    contentRevision: 9
  };
  const numbering = readerPageNumbering(bookPageMapForProject({ pdfPageMap: PARTIAL_MAP, contentRevision: 9 }));

  it("has no printed number for the anchor, while the fallback would hand out a model index", () => {
    expect(numbering.printedPageEnd(4)).toBeUndefined();
    expect(numbering.displayPageEnd(4)).toBe(4);
    // Which is a number this book already prints, on a different page: model
    // page 3 is the reader's page 4.
    expect(numbering.displayPage(3)).toBe(4);
  });

  it("drops the clause from an insert's sentence and from its chip", () => {
    const { summary, card } = surfacesFor(
      { action: "insert", anchorPageIndex: 4, pageIndexes: [], pageCount: 2 },
      numbering
    );
    expect(summary).toBe("Add 2 new pages");
    expect(card).toMatchObject({ action: "insert", pageCount: 2, placement: "unnamed" });
    expect(card).not.toHaveProperty("afterReaderPage");
    expect(card).not.toHaveProperty("atFrontOfBook");
  });

  it("drops it from a move's, which named a destination it cannot print", () => {
    const { summary, card } = surfacesFor(
      { action: "move", anchorPageIndex: 4, pageIndexes: [2], pageCount: 0 },
      numbering
    );
    // The moved page is still named: model page 2 is the reader's page 3, and a
    // page the map does place belongs in the sentence.
    expect(summary).toBe("Move page 3");
    expect(card).toMatchObject({ action: "move", placement: "unnamed", readerPageNumbers: [3] });
    expect(card).not.toHaveProperty("afterReaderPage");
  });
});
