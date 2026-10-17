/**
 * What a final-QA verdict says about *pages*, and nothing else.
 *
 * Pure text analysis over reviewer prose: no database, no config, no job
 * lifecycle. It lives apart from `bookHelpers.ts` because two very different
 * callers need it and only one of them is a job handler — `exportQualityReview.ts`
 * formats the reader's quality card and has no business opening a Prisma client
 * or reading stored exports to ask which pages a sentence names. It stays in
 * the worker rather than in `packages/core` because nothing outside this app asks
 * which pages a sentence names; reaching it
 * through the core barrel would swap the three runtime imports it came here to
 * escape (`runtime/config.js`, `runtime/jobLifecycle.js`, `@book-maker/db`) for
 * the whole of core's — adapters, prompts, PDF — which is the same mistake one
 * size up.
 *
 * Every index here is a model page index (`Page.index`, 1-based), never a
 * printed page number. The repair pass chose its pages from the whole verdict
 * with prose heuristics for the book's opening and ending (`extractRepairPageIndexes`);
 * it went with the per-page repair loop on 2026-10-16, and the defect screen's
 * repair reads the pages its own findings name (`quickDraftQaTargets`).
 */

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
 * The bound a verdict's page numbers are read in: the last page a reader can
 * actually open.
 *
 * Not `input.targetPages`, which is the *plan's* page count and a different
 * number — the deterministic manuscript audit reports a page count off the
 * target as a mismatch of its own, so the two genuinely disagree: a drafting pass that
 * settled on another count, or a plan-version snapshot lagging a structural
 * insert. Bounded by the plan, every index past it was dropped without a trace,
 * so a complaint about the tail of a book longer than its plan reached the
 * reader's card with no page link at all; the other way round, the card offered a tap into a page the book does
 * not have.
 */
export function lastPageIndex(pages: readonly { readonly index: number }[]): number {
  return pages.reduce((last, page) => (page.index > last ? page.index : last), 0);
}
