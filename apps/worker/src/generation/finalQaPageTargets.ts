import type { FinalBookQa } from "@book-maker/core";

/**
 * What a final-QA verdict says about *pages*, and nothing else.
 *
 * Pure text analysis over reviewer prose: no database, no config, no job
 * lifecycle. It lives apart from `bookHelpers.ts` because two very different
 * callers need it and only one of them is a job handler — `exportQualityReview.ts`
 * formats the reader's quality card and has no business opening a Prisma client
 * or reading `BOOK_STORAGE_DIR` to ask which pages a sentence names. It stays in
 * the worker rather than in `packages/core` because both questions below are the
 * final-QA repair pass's own and nothing outside this app asks them; reaching it
 * through the core barrel would swap the three runtime imports it came here to
 * escape (`runtime/config.js`, `runtime/jobLifecycle.js`, `@book-maker/db`) for
 * the whole of core's — adapters, prompts, PDF — which is the same mistake one
 * size up.
 *
 * Every index here is a model page index (`Page.index`, 1-based), never a
 * printed page number.
 */

/**
 * Final QA is told to reject a book whose *opening* is meta, throat-clearing or
 * generic, and an issue phrased that way names no page number: "the opening
 * reads as a definition of the topic" is about page 1 without ever saying
 * "page 1". Without this twin of the final-page rule the repair set came back
 * empty, `repairPagesFromFinalQa` had nothing to redraft, and the book exported
 * permanently flagged "Final review still reports issues" with no path back.
 *
 * Every alternative names the book's own start, because a bare `opening` is
 * also how a reviewer writes "opening quotation marks" — a complaint about
 * typography on some other page, which would repair page 1 for nothing. That is
 * why "the opening" carries a lookahead and "opens with" is anchored to the
 * book rather than to a page that already names itself.
 *
 * Both apostrophes, because a model reviewer emits the typographic one as
 * readily as the straight one: with `'` alone, "the book's opening is generic"
 * matched and "the book’s opening is generic" did not — and neither did
 * `the\s+opening`, since "the" is followed by "book’s" — so the phrasing this
 * alternative exists for fell through on the spelling nobody types by hand.
 *
 * `openingHook` and `openingPages` are payload field names rather than prose:
 * the final-QA prompt hands the reviewer both and tells it to judge the
 * reader's first impression from `openingPages`, so a verdict echoing the field
 * it read is ordinary phrasing. Neither carries a space, so no alternative
 * built out of words can reach them.
 */
const OPENING_ISSUE_PATTERN =
  /\b(?:opening|first)\s+(?:page|pages|paragraph|paragraphs|line|lines|sentence|sentences|scene)\b|\b(?:book|story|manuscript)['’]?s?\s+opening\b|\bthe\s+opening\b(?!\s+(?:quot|bracket|parenthes|tag|mark|delimiter))|\b(?:book|story|manuscript)\s+opens\s+with\b|\bopening(?:hook|pages?)\b/i;

/**
 * The final-page twin of `OPENING_ISSUE_PATTERN`: a book whose ending resolves
 * nothing is the last page's problem, and that verdict names no page number
 * either.
 *
 * `<book|story|manuscript> ends` is the verbal alternative, the twin of the
 * opening pattern's `book opens with`: "the book ends abruptly" is among the
 * most ordinary ways a reviewer phrases exactly this failure and carries none
 * of the four nouns above. It is anchored to the book for the same reason the
 * opening's verbal form is — a bare `\bends\b` is also how you say "page 4 ends
 * mid-beat", which is that page's complaint and not the book's.
 */
const ENDING_ISSUE_PATTERN = /\b(?:final page|ending|conclusion|resolution)\b|\b(?:book|story|manuscript)\s+ends\b/i;

/**
 * The parts a reviewer names *inside* a book, in one vocabulary, because all
 * three government tests below ask the same question of it: is the thing
 * qualifying this edge phrase the book, or something smaller?
 *
 * Deliberately short. `part` is left out because "in part" is an adverbial a
 * reviewer writes far more often than it writes "of part two", and every word
 * in here suppresses a heuristic — a word that misfires costs a book the repair
 * of an end nobody else will fix. `act` is left out as a drama word this
 * product's books rarely carry.
 */
const SUB_BOOK_UNIT = "pages?|chapters?|sections?|scenes?|paragraphs?";

/**
 * How the number after one of those units is written, because a reviewer spells
 * it out as readily as it types a digit: "Chapter two's ending is abrupt" was
 * the whole book's last page being redrafted for chapter two, on a possessor
 * pattern whose number group was `\d+` and could not see the word.
 *
 * Cardinals only, and only the ones that sit *after* the unit. The ordinal-first
 * form — "the first paragraph", "the opening page" — is exactly what
 * `OPENING_ISSUE_PATTERN` reads as the book's own start, so teaching these tests
 * to claim it would take page 1's complaint away from page 1. Twelve is where it
 * stops for the reason `SUB_BOOK_UNIT` is short: every word in here suppresses a
 * heuristic, and a book whose reviewer counts past twelve in words is rarer than
 * the misfire would be.
 */
const SUB_BOOK_NUMBER = String.raw`\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve`;

/**
 * A message that opens by naming its scope scopes *the whole complaint* to that
 * scope, however far into the sentence the rest of it runs: "Page 12: the
 * opening paragraph restates the chapter title" is page 12's problem, not the
 * book's opening, and "Chapter 2: the opening drags" is chapter 2's.
 * Distance-free for that reason, unlike the two patterns below.
 *
 * **And a subject needs no punctuation.** This asked for a delimiter after the
 * number, which is a proxy for "the reference is what the sentence is about"
 * that holds only when the reviewer reaches for a colon. "Page 12 repeats the
 * opening." is the same sentence with the same subject and gets " repeats", so
 * the possessor and complement tests found nothing either and `the opening`
 * spoke for the book: page 1 was redrafted for a complaint about page 12, and
 * handed that very sentence as its required revision. A leading unit reference
 * is the scope whatever follows it, so the delimiter is gone — and with it the
 * number chain, which existed only to reach across "3, 5 and 7" to reach a
 * delimiter that is no longer there.
 */
const LEADING_UNIT_SCOPE_PATTERN = new RegExp(
  `^\\s*(?:on\\s+|in\\s+|at\\s+|for\\s+)?(?:${SUB_BOOK_UNIT})\\s+(?:${SUB_BOOK_NUMBER})\\b`,
  "i"
);

/**
 * A sub-book unit owning the edge phrase just after it: "page 4's ending",
 * "chapter 4's opening", "the scene's ending". The number is optional because
 * "the chapter's opening" says the same thing without one.
 *
 * The possessor is held to the unit vocabulary rather than to any word, so
 * "the book's ending" and "the author's ending" still speak for the book —
 * a person who owns a book owns its ending, and excluding only
 * `book|story|manuscript` by name would have quietly taken the rest away.
 *
 * The number is `SUB_BOOK_NUMBER` rather than `\d+`, because "chapter two's
 * ending is abrupt" is a spelling of the same sentence and used to reach the
 * book's last page.
 */
const SUB_BOOK_POSSESSOR_PATTERN = new RegExp(
  `\\b(?:${SUB_BOOK_UNIT})(?:\\s+(?:${SUB_BOOK_NUMBER}))?\\s*['’]s\\b[\\s\\w,]{0,12}$`,
  "i"
);

/**
 * A sub-book unit completing the edge phrase just before it: "the ending of
 * page 7", "the opening line on page 9", "the opening of chapter 2". The
 * bounded run of words in between is the whole window — `OPENING_ISSUE_PATTERN`
 * can end mid-phrase ("The opening" out of "The opening line"), and a head noun
 * or two is the ordinary gap.
 *
 * The object is a sub-book unit and not any noun, because the preposition can
 * also be the sentence's own ("the ending is abrupt for readers"): matching any
 * object would suppress the heuristic on the plainest book-ending complaint
 * there is. "of the book" is not in the vocabulary, so it goes on speaking for
 * the book, which is the point.
 */
const SUB_BOOK_COMPLEMENT_PATTERN = new RegExp(
  `^[\\s\\w,]{0,20}?\\b(?:of|on|in|at|for)\\s+(?:the\\s+)?(?:${SUB_BOOK_UNIT})\\b`,
  "i"
);

/**
 * Whether an edge complaint is about the book's own edge, or about the part of
 * the book it names.
 *
 * This is the gate on both edge heuristics, and getting it wrong costs a book at
 * one end or the other. The first shape of it was "the message names no page at
 * all", which fixed one end by breaking the other: "Page 12: the opening
 * paragraph restates the chapter title" stopped redrafting page 1 for nothing,
 * but "the ending is abrupt — page 18 sets up a payoff that never lands"
 * stopped reaching the last page, so the unresolved ending survived the repair
 * pass, the second `runFinalBookQa` rejected the book on the same complaint, and
 * it exported permanently flagged "Final review still reports issues" — the
 * exact dead end the opening rule was added to close, reopened at the other end.
 *
 * What separates the two is *government*, not position: a reference that is the
 * message's leading scope, the possessor of the edge phrase, or the object of a
 * preposition attached to it says what the complaint is **about**, while one
 * standing as a clause subject of its own ("— page 18 sets up …") is evidence
 * the complaint **cites**, and the complaint is still about its own subject.
 * Position alone cannot carry it, because "the opening line on page 9" and "the
 * ending of page 7" both put the edge phrase first and are still that page's
 * complaint.
 *
 * **And the governor is any part of the book, not only a page.** All three tests
 * asked for `page \d+` exactly, so "Page 3 and the opening of chapter 2 duplicate
 * the same anecdote" governed nothing they could see — the leading-scope test
 * wants a delimiter after the digit and got "and", the complement test wants
 * "of page 3" and got "of chapter 2" — and the bare `the opening` alternative
 * carried the whole message to page 1: a model redraft of a page nobody
 * complained about, with that complaint handed to it as the repair instruction.
 * The rule the three tests were always reaching for is that an *unanchored* edge
 * phrase speaks for the book only when nothing smaller than the book has claimed
 * it, so they ask about `SUB_BOOK_UNIT` now. The alternatives anchored to
 * `book|story|manuscript` never needed the help and are unaffected by it.
 */
function edgeComplaintSpeaksForTheBook(message: string, pattern: RegExp): boolean {
  const match = pattern.exec(message);
  if (!match) {
    return false;
  }
  if (LEADING_UNIT_SCOPE_PATTERN.test(message)) {
    return false;
  }
  if (SUB_BOOK_POSSESSOR_PATTERN.test(message.slice(0, match.index))) {
    return false;
  }
  return !SUB_BOOK_COMPLEMENT_PATTERN.test(message.slice(match.index + match[0].length));
}

/** Every complaint a final-QA verdict makes, in one list. */
function finalQaComplaints(finalQa: FinalBookQa): string[] {
  return [...finalQa.issues, ...finalQa.requiredFixes];
}

export function messageTargetsPage(message: string, pageIndex: number, lastPage: number): boolean {
  const pageIndexes = extractRepairPageIndexesFromText(message, lastPage);
  if (pageIndexes.includes(pageIndex)) {
    return true;
  }
  if (pageIndex === 1 && edgeComplaintSpeaksForTheBook(message, OPENING_ISSUE_PATTERN)) {
    return true;
  }
  // Scoping is looser than selection at this end only: "incomplete" hands the
  // final page a message it may need to read, without being reason enough on
  // its own to redraft that page in `extractRepairPageIndexes`. It carries no
  // edge phrase for `edgeComplaintSpeaksForTheBook` to weigh, so it keeps the
  // blunter gate: a message that named any page has placed itself, and the last
  // page is not it.
  return (
    pageIndex === lastPage &&
    (edgeComplaintSpeaksForTheBook(message, ENDING_ISSUE_PATTERN) ||
      (pageIndexes.length === 0 && /\bincomplete\b/i.test(message)))
  );
}

/** The complaints a page has to answer, or the verdict's issues when none is its own. */
export function finalQaMessagesForPage(finalQa: FinalBookQa, pageIndex: number, lastPage: number): string[] {
  const scoped = finalQaComplaints(finalQa).filter((message) => messageTargetsPage(message, pageIndex, lastPage));
  return scoped.length > 0 ? scoped : finalQa.issues;
}

/**
 * The pages the final-QA repair pass must redraft.
 *
 * Both prose heuristics are on, and that is the whole difference between this
 * question and the reader's quality card: a redraft nobody needed costs one
 * model call, while a card linking to a page nobody complained about spends the
 * reader's trust. The card asks `extractRepairPageIndexesFromText` per message
 * instead (`exportQualityReview.ts`).
 */
export function extractRepairPageIndexes(finalQa: FinalBookQa, lastPage: number): number[] {
  const indexes = new Set<number>();
  for (const message of finalQaComplaints(finalQa)) {
    for (const pageIndex of extractRepairPageIndexesFromText(message, lastPage)) {
      indexes.add(pageIndex);
    }
    // Per message, and both ends by one rule: a page a complaint merely cites
    // as evidence leaves that complaint speaking for the book's edge, while a
    // part of the book that governs it takes the complaint with it.
    if (edgeComplaintSpeaksForTheBook(message, OPENING_ISSUE_PATTERN)) {
      indexes.add(1);
    }
    if (edgeComplaintSpeaksForTheBook(message, ENDING_ISSUE_PATTERN)) {
      indexes.add(lastPage);
    }
  }
  return [...indexes].filter((pageIndex) => pageIndex >= 1 && pageIndex <= lastPage);
}

/**
 * What one page reference may put between two of its numbers, and which of those
 * separators means "and everything in between".
 *
 * The keyword may be repeated after any of them, because a reviewer writes "from
 * page 4 to page 6" and "page 3, page 5 and page 7" as readily as the
 * bare-number forms — and a repeated keyword used to split one reference into
 * separate matches, of which only the last survived.
 */
const PAGE_REFERENCE_SEPARATOR = String.raw`(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s+(?:to|through)\s+|\s*[-–—]\s*)`;
const PAGE_RANGE_SEPARATOR_PATTERN = /\b(?:to|through)\b|[-–—]/i;

/** One whole reference: the keyword, its first number, and everything chained on. */
const PAGE_REFERENCE_PATTERN = new RegExp(
  String.raw`\bpages?\s+\d+(?:${PAGE_REFERENCE_SEPARATOR}(?:pages?\s+)?\d+)*`,
  "gi"
);

/** Each number inside one reference, carrying the separator that reached it. */
const PAGE_REFERENCE_STEP_PATTERN = new RegExp(
  String.raw`(?:^|(${PAGE_REFERENCE_SEPARATOR}))(?:pages?\s+)?(\d+)`,
  "gi"
);

/**
 * How wide a span may be before it stops naming pages and starts naming the
 * book.
 *
 * A span is *expanded*, because both callers want every page in it: the card
 * prints them under the complaint and opens Edit Mode at the first
 * (`book_screen_body.dart`), so a human gets every page they can turn to, and
 * the repair pass redrafts what the complaint names — "pages 4 to 6 restate the
 * premise" is about page 5 exactly as much as about page 6. Past a dozen it is a
 * complaint about the whole book wearing numbers, and expanding it would print a
 * screenful of tap targets and bill a redraft for each: a span that wide keeps
 * only the two pages the sentence actually types, each still dropped if the book
 * has no such page.
 */
const MAX_ENUMERATED_RANGE_PAGES = 12;

type PageReferenceStep = { readonly value: number; readonly spansFromPrevious: boolean };

function pageReferenceSteps(reference: string): PageReferenceStep[] {
  const steps: PageReferenceStep[] = [];
  for (const step of reference.matchAll(PAGE_REFERENCE_STEP_PATTERN)) {
    const digits = step[2];
    if (digits !== undefined) {
      steps.push({ value: Number(digits), spansFromPrevious: PAGE_RANGE_SEPARATOR_PATTERN.test(step[1] ?? "") });
    }
  }
  return steps;
}

/**
 * The pages one sentence names outright, bounded by the book's own page count.
 *
 * **The whole reference, not its last number.** This captured at most two digits
 * and kept `second ?? first`, so "Pages 4 to 6 restate the premise" came back as
 * page 6 alone, and "Pages 3, 5 and 7 repeat the opening" as page 5 — once
 * "pages 3, 5" was consumed the trailing "and 7" had no keyword left to match.
 * Survivable while the verdict's whole union was stamped on every issue, because
 * a dropped page was still reachable from some other message; the reader's
 * quality card asks this per message now (`exportQualityReview.ts`), so a
 * complaint about pages 4-6 printed "Pages 6 · Open Edit Mode" and tapped
 * through to a page it had not complained about.
 *
 * A lone "from page 4" is still nobody's page: it says where something *came*
 * from, and the complaint is about wherever it landed ("move the epigraph from
 * page 4 onto page 9"). That guard also used to drop the start of a "from page 4
 * to page 6" span, which is one chained reference now and expands like any
 * other.
 */
export function extractRepairPageIndexesFromText(text: string, lastPage: number): number[] {
  const indexes = new Set<number>();
  const addIndex = (pageIndex: number): void => {
    if (pageIndex >= 1 && pageIndex <= lastPage) {
      indexes.add(pageIndex);
    }
  };

  for (const reference of text.matchAll(PAGE_REFERENCE_PATTERN)) {
    const steps = pageReferenceSteps(reference[0] ?? "");
    if (steps.length === 1 && /\bfrom\s+$/i.test(text.slice(Math.max(0, reference.index - 8), reference.index))) {
      continue;
    }
    for (const [position, step] of steps.entries()) {
      const previous = position > 0 ? steps[position - 1] : undefined;
      if (!previous || !step.spansFromPrevious) {
        addIndex(step.value);
        continue;
      }
      // Clamped before it is walked, never after: "pages 2 to 400" of a 20-page
      // book must not enumerate 400 entries for the bound to drop 380 of them.
      const from = Math.max(previous.value, 1);
      const to = Math.min(step.value, lastPage);
      if (step.value < previous.value || to - from + 1 > MAX_ENUMERATED_RANGE_PAGES) {
        addIndex(previous.value);
        addIndex(step.value);
        continue;
      }
      for (let pageIndex = from; pageIndex <= to; pageIndex += 1) {
        addIndex(pageIndex);
      }
    }
  }

  return [...indexes];
}

/**
 * The bound both questions above are asked in: the last page a reader can
 * actually open.
 *
 * Not `input.targetPages`, which is the *plan's* page count and a different
 * number — `runLocalFinalQa` reports `pages.length !== targetPages` as a
 * mismatch of its own, so the two genuinely disagree: a drafting pass that
 * settled on another count, or a plan-version snapshot lagging a structural
 * insert. Bounded by the plan, every index past it was dropped without a trace,
 * so a complaint about the tail of a book longer than its plan reached the
 * reader's card with no page link at all and the repair pass with nothing to
 * redraft; the other way round, the card offered a tap into a page the book does
 * not have.
 */
export function lastPageIndex(pages: readonly { readonly index: number }[]): number {
  return pages.reduce((last, page) => (page.index > last ? page.index : last), 0);
}
