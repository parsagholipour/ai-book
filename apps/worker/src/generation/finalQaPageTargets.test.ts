import { describe, expect, it } from "vitest";
import {
  extractRepairPageIndexes,
  extractRepairPageIndexesFromText,
  lastPageIndex,
  messageTargetsPage
} from "./finalQaPageTargets.js";

// Pure text in, page indexes out: no module mocks, no database, no config.

function finalQa(issues: string[], requiredFixes: string[] = []) {
  return { approved: false, score: 40, issues, requiredFixes, notes: "" };
}

describe("extractRepairPageIndexes repetition issues", () => {
  it("redrafts only the page that repeats an earlier one, never the page it repeats", () => {
    // The local QA rules (`pagesLocalQa.ts` in core) spell the earlier page as
    // "(from page N)" for exactly this harvest.
    const issue = "Page 9: Page title repeats the title of the page before it (from page 7).";

    expect(extractRepairPageIndexes(finalQa([issue]), 12)).toEqual([9]);
    expect(messageTargetsPage(issue, 7, 12)).toBe(false);
    expect(messageTargetsPage(issue, 9, 12)).toBe(true);
  });
});

describe("extractRepairPageIndexes opening issues", () => {
  it.each([
    "The opening is meta and never commits to the book's subject.",
    "The opening page reads as throat-clearing.",
    "The first paragraph gives the reader no reason to continue.",
    // Both apostrophes for every possessive phrasing: a model reviewer emits ’
    // as readily as ', and with the straight one alone these fell through —
    // "the opening" cannot rescue them either, because "the" is followed by
    // "book’s".
    "The book's opening is generic scene-setting.",
    "The book’s opening is generic scene-setting.",
    "The story's opening reads as throat-clearing.",
    "The story’s opening reads as throat-clearing.",
    "The manuscript's opening never commits to a subject.",
    "The manuscript’s opening never commits to a subject.",
    // The payload field names the final-QA prompt hands the reviewer and tells
    // it to judge the opening from. Neither has a space in it, so no phrasing
    // alternative built out of words reaches them.
    "openingHook is not delivered anywhere in the prose.",
    "openingPages is meta and throat-clearing."
  ])("targets page 1 for %s", (issue) => {
    // Final QA is told to reject a book on its opening, and that issue names no
    // page number. With no rule mapping it back, the repair set was empty, the
    // repair pass returned nothing, and the book exported permanently flagged.
    expect(extractRepairPageIndexes(finalQa([issue]), 30)).toContain(1);
    expect(messageTargetsPage(issue, 1, 30)).toBe(true);
  });

  it("reads requiredFixes as well as issues", () => {
    expect(extractRepairPageIndexes(finalQa([], ["Rewrite the opening page so it commits to the subject."]), 12)).toEqual([1]);
  });

  it.each([
    "Page 4 uses opening quotation marks that are never closed.",
    "The opening bracket on page 9 is unbalanced.",
    "Chapter 3 restates the same beat twice."
  ])("does not target page 1 for %s", (issue) => {
    expect(extractRepairPageIndexes(finalQa([issue]), 30)).not.toContain(1);
    expect(messageTargetsPage(issue, 1, 30)).toBe(false);
  });

  it.each<[string, number]>([
    ["Page 12: the opening paragraph restates the chapter title.", 12],
    ["The opening line on page 9 is unbalanced.", 9],
    ["Page 4's ending is flat and the scene stops mid-beat.", 4],
    ["The ending of page 7 resolves nothing.", 7]
  ])("repairs only the page %s names", (issue, named) => {
    // A message that names its own page has already been placed, so neither
    // edge heuristic may claim it as well. Adding page 1 (or the last page)
    // alongside bought a whole redraft — draft and review — of a page nobody
    // complained about, and handed it this message as its repair instruction.
    expect(extractRepairPageIndexes(finalQa([issue]), 30)).toEqual([named]);
    expect(messageTargetsPage(issue, named, 30)).toBe(true);
    expect(messageTargetsPage(issue, 1, 30)).toBe(false);
    expect(messageTargetsPage(issue, 30, 30)).toBe(false);
  });

  it("still targets the final page, and both ends together when both are named", () => {
    const indexes = extractRepairPageIndexes(
      finalQa(["The opening is meta.", "The ending resolves nothing."]),
      20
    );
    expect(indexes.sort((a, b) => a - b)).toEqual([1, 20]);
  });

  it.each([
    "The ending is abrupt — page 18 sets up a payoff that never lands.",
    "The book ends abruptly — page 18 sets up a payoff that never lands.",
    "The conclusion resolves nothing; page 18 promises a payoff and drops it."
  ])("still repairs the last page when an edge complaint only cites a page: %s", (issue) => {
    // A page a complaint *cites as evidence* has not placed that complaint.
    // Gating both heuristics on "the message names no page at all" made this
    // message repair page 18 alone: the unresolved ending survived, the second
    // `runFinalBookQa` rejected the book on the same complaint, and it exported
    // permanently flagged with no path back.
    expect(extractRepairPageIndexes(finalQa([issue]), 20).sort((a, b) => a - b)).toEqual([18, 20]);
    expect(messageTargetsPage(issue, 20, 20)).toBe(true);
    expect(messageTargetsPage(issue, 18, 20)).toBe(true);
  });

  it("still repairs page 1 when an opening complaint only cites a page", () => {
    const issue = "The opening is generic scene-setting — page 6 is where the book actually starts.";
    expect(extractRepairPageIndexes(finalQa([issue]), 20).sort((a, b) => a - b)).toEqual([1, 6]);
    expect(messageTargetsPage(issue, 1, 20)).toBe(true);
  });

  it("keeps each end for the complaint that speaks for it, in one message", () => {
    // The opening complaint is placed nowhere; the ending complaint is governed
    // by page 7. Both ends read from one message, and only one of them fires.
    const issue = "The opening is generic and the ending of page 7 resolves nothing.";
    expect(extractRepairPageIndexes(finalQa([issue]), 20).sort((a, b) => a - b)).toEqual([1, 7]);
    expect(messageTargetsPage(issue, 20, 20)).toBe(false);
  });

  it("answers a whole verdict at both ends and drops pages the book does not have", () => {
    const verdict = finalQa([
      "The opening is meta and never commits to the book's subject.",
      "Chapter 4 restates the same argument twice.",
      "The ending resolves nothing.",
      "Page 45 is unreadable."
    ]);
    expect(extractRepairPageIndexes(verdict, 20).sort((a, b) => a - b)).toEqual([1, 20]);
  });
});

describe("an edge phrase a part of the book has claimed", () => {
  it.each<[string, number[]]>([
    // The compound subject. `LEADING_UNIT_SCOPE_PATTERN` wants a delimiter after
    // the digit and gets "and"; the possessor wants "'s"; the complement used to
    // want "of page N" and gets "of chapter 2" — so the bare `the opening`
    // alternative carried the whole message to page 1, a model redraft of a page
    // nobody complained about, with this complaint as its repair instruction.
    ["Page 3 and the opening of chapter 2 duplicate the same anecdote.", [3]],
    // The ending twin of the same shape. (Its opening twin, "Chapter 4's opening
    // restates the thesis", never matched `OPENING_ISSUE_PATTERN` at all — that
    // alternative needs the word "the" before "opening" — so the possessive case
    // only ever cost the book its last page.)
    ["Chapter 4's ending restates the thesis.", []],
    ["Chapter 4's opening line restates the thesis.", []],
    // Named in `exportQualityReview.ts` as a guess the card must not make.
    ["The conclusion of chapter 2 is muddled.", []],
    // A leading scope naming any part of the book, not only a page.
    ["Chapter 2: the opening drags.", []],
    // The subject with no punctuation after it. All three tests missed this:
    // the leading scope wanted a delimiter and got " repeats", and neither the
    // possessor nor the complement has anything to find — so page 1 was
    // redrafted for a complaint about page 12, with this sentence handed to it
    // as the revision it had to make.
    ["Page 12 repeats the opening.", [12]],
    ["Pages 3 and 5 both restate the opening.", [3, 5]],
    // The same subject with its number spelled out. The possessor's number
    // group was `\d+`, so the book's last page was redrafted for chapter two.
    ["Chapter two's ending is abrupt.", []],
    ["Chapter twelve's ending is abrupt.", []],
    ["Section three repeats the opening.", []]
  ])("does not reach an end of the book for %s", (issue, expected) => {
    expect(extractRepairPageIndexes(finalQa([issue]), 20).sort((a, b) => a - b)).toEqual(expected);
    expect(messageTargetsPage(issue, 1, 20)).toBe(false);
    expect(messageTargetsPage(issue, 20, 20)).toBe(false);
  });

  it.each<[string, number]>([
    // The vocabulary is parts *inside* a book, so a qualifier that is the book
    // itself — or a person who owns it — leaves the complaint speaking for the
    // book. Excluding `book|story|manuscript` by name instead would have taken
    // the author with it.
    ["The ending of the book is abrupt.", 20],
    ["The book's ending resolves nothing.", 20],
    ["The story's ending resolves nothing.", 20],
    ["The author's ending is unearned.", 20],
    // The preposition can also be the sentence's own: an object that is any noun
    // would suppress the plainest book-ending complaint there is.
    ["The ending is abrupt for readers.", 20],
    ["The opening of the book is throat-clearing.", 1]
  ])("still speaks for the book in %s", (issue, target) => {
    expect(extractRepairPageIndexes(finalQa([issue]), 20)).toEqual([target]);
    expect(messageTargetsPage(issue, target, 20)).toBe(true);
  });
});

describe("extractRepairPageIndexesFromText", () => {
  it("takes the named pages and nothing else", () => {
    // The reader's quality card asks this one per message: no edge heuristic, so
    // a complaint that named no page links nowhere rather than to a guess.
    expect(extractRepairPageIndexesFromText("The opening is meta.", 20)).toEqual([]);
    expect(extractRepairPageIndexesFromText("Page 40 repeats page 3.", 20)).toEqual([3]);
  });

  it.each<[string, number[]]>([
    // The two shapes that used to lose pages. Both were survivable while the
    // verdict's whole union was stamped on every issue; the card asks this per
    // message, so the first printed "Pages 6 · Open Edit Mode" for a complaint
    // about three pages and tapped through to the wrong one, and the second lost
    // page 7 entirely — after "pages 3, 5" was consumed, the trailing "and 7"
    // had no keyword left to match.
    ["Pages 4 to 6 restate the premise.", [4, 5, 6]],
    ["Pages 3, 5 and 7 repeat the opening.", [3, 5, 7]],
    // Every dash a model emits, the serial comma, and the keyword repeated
    // after a separator — which used to break one reference into two matches.
    ["Pages 4-6 restate the premise.", [4, 5, 6]],
    ["Pages 4–6 restate the premise.", [4, 5, 6]],
    ["Pages 3 through 5 and 8 to 9 repeat the same beat.", [3, 4, 5, 8, 9]],
    ["Pages 3, 5, and 7 repeat the opening.", [3, 5, 7]],
    ["Page 3, page 5 and page 7 repeat the opening.", [3, 5, 7]],
    // A span is expanded because the card prints every page a human can turn
    // to and the repair redrafts what the complaint names — until it is wide
    // enough to be a complaint about the book, when only the two pages the
    // sentence types survive.
    ["Pages 1 to 20 all restate the premise.", [1, 20]],
    // Descending is two references, not a span.
    ["Pages 6 to 4 are out of order.", [6, 4]]
  ])("answers the whole reference in %j", (message, expected) => {
    expect(extractRepairPageIndexesFromText(message, 20)).toEqual(expected);
  });

  it("clamps a span to the book before walking it, never after", () => {
    // A 20-page book has no page 400, and enumerating up to one would build 399
    // entries for the bound to drop 380 of them. Over the span cap, so only the
    // pages the sentence names are offered, and only the one that exists.
    expect(extractRepairPageIndexesFromText("Pages 2 to 400 restate the premise.", 20)).toEqual([2]);
    // A span whose end is past the last page still hands over the pages that
    // are there — the reviewer's numbers came from a manuscript, not a plan.
    expect(extractRepairPageIndexesFromText("Pages 4 to 6 restate the premise.", 5)).toEqual([4, 5]);
    expect(extractRepairPageIndexesFromText("Pages 40 to 60 restate the premise.", 20)).toEqual([]);
  });

  it("still reads a lone 'from page N' as provenance rather than as a target", () => {
    // Where something came from is not what the complaint is about.
    expect(extractRepairPageIndexesFromText("Move the epigraph from page 4 onto page 9.", 20)).toEqual([9]);
    // But the guard used to swallow the start of a span written this way, and
    // the rest of it collapsed to its last number.
    expect(extractRepairPageIndexesFromText("Copy the quote from page 4 to page 6 verbatim.", 20)).toEqual([
      4, 5, 6
    ]);
  });
});

describe("lastPageIndex", () => {
  it("is the book's own last page, not the plan's page count", () => {
    // `runLocalFinalQa` reports `pages.length !== targetPages` as a mismatch, so
    // the two genuinely disagree — and the reader can only open the pages that
    // exist.
    expect(lastPageIndex([{ index: 1 }, { index: 2 }, { index: 3 }])).toBe(3);
    expect(lastPageIndex([])).toBe(0);
  });

  it("bounds a tail complaint into the book a longer manuscript actually has", () => {
    const pages = Array.from({ length: 24 }, (_, position) => ({ index: position + 1 }));
    // Bounded by a 20-page plan, page 23 was dropped and the card showed no link
    // at all for a complaint about the tail.
    expect(extractRepairPageIndexesFromText("Page 23 trails off.", 20)).toEqual([]);
    expect(extractRepairPageIndexesFromText("Page 23 trails off.", lastPageIndex(pages))).toEqual([23]);
  });
});
