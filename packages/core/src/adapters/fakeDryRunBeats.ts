/**
 * The dry-run production tables the mock text adapter (`fake.ts`) assigns
 * pages from: one page's purpose, beat, continuity, ending pressure, visual
 * moment and evidence ledger, rotated out of five short tables whose periods
 * are coprime, so a `MOCK_AI` book of any length reads as distinct pages and
 * never trips the map integrity audit. Split out of `fake.ts` at its size
 * budget along this seam: nothing here knows a schema or a purpose string, and
 * `fake.ts` only calls the three functions at the bottom.
 */

const DRY_RUN_MOVES = [
  "Unlock a question about",
  "Settle an argument over",
  "Risk a safe routine on",
  "Weigh the cost of",
  "Hand a wary newcomer",
  "Abandon a plan built on",
  "Repair what was broken by"
];

const DRY_RUN_FIGURES = [
  "the night clerk",
  "a retired coach",
  "the youngest cousin",
  "a rival buyer",
  "the site manager",
  "an off-duty medic",
  "the shop owner",
  "a visiting auditor",
  "the last tenant"
];

const DRY_RUN_SETTINGS = [
  "In the flooded stairwell",
  "Halfway through a night shift",
  "In the emptied market",
  "Under a borrowed roof",
  "At the harvest weighing",
  "Outside a shuttered clinic",
  "On the earliest ferry",
  "In an archive basement",
  "Across a frozen yard",
  "Between two closed meetings",
  "At the quarry edge",
  "Through a wall of rehearsal noise",
  "Behind a rented van"
];

const DRY_RUN_DETAILS = [
  "a brass key",
  "a rain-dark window",
  "a folded letter",
  "a cracked stair",
  "a blue cup",
  "a quiet bell",
  "a chalk mark",
  "a locked drawer",
  "a warm lamp",
  "a silver thread"
];

const DRY_RUN_CONSEQUENCES = [
  "a debt comes due",
  "an ally takes notes",
  "one exit closes",
  "a supervisor demands names",
  "a promise turns official",
  "a storm resets everything",
  "a second copy surfaces",
  "money moves overnight",
  "a witness recants",
  "a deadline arrives early",
  "an old friend refuses"
];

export type DryRunPageBeat = {
  purpose: string;
  beat: string;
  requiredContinuity: string[];
  endingPressure: string;
  imageMoment: string;
  claim: string;
  evidenceAnchors: string[];
};

/**
 * One page's production assignment, in the shape both brief producers emit —
 * the whole-book page map and the per-chapter brief, which is the one a dry run
 * over 24 pages actually takes (`generateChunkedPageMap`). `variant` 1 is the
 * beat-dedup rewrite: each table is stepped by its own amount, so a rewrite
 * reproduces some page's assignment only where all five steps line up at once,
 * and the nearest page that happens for is 28,255 pages along.
 */
export function dryRunPageBeat(pageIndex: number, variant = 0): DryRunPageBeat {
  const move = rotate(DRY_RUN_MOVES, pageIndex + 3 * variant);
  const figure = rotate(DRY_RUN_FIGURES, pageIndex + 4 * variant);
  const detail = dryRunDetail(pageIndex + 5 * variant);
  const setting = rotate(DRY_RUN_SETTINGS, pageIndex + 6 * variant);
  const consequence = rotate(DRY_RUN_CONSEQUENCES, pageIndex + 7 * variant);
  return {
    purpose: `${move} ${detail}.`,
    beat: `${setting}, ${figure} reckons with ${detail}, so ${consequence}.`,
    requiredContinuity: [`Keep ${figure} and ${detail} consistent after page ${pageIndex}.`],
    endingPressure: `Page ${pageIndex} hands the next page one thing: ${consequence}.`,
    imageMoment: `${setting}, drawn tight on ${figure} beside ${detail}.`,
    // The evidence ledger an analytical dry run carries. Two anchors built from
    // two table pairs whose periods are coprime to each other's, so no two pages
    // of one chapter share one and the anchor audit stays quiet on a dry run.
    claim: `${figure} shows that ${consequence} once ${detail} is weighed.`,
    evidenceAnchors: [`${setting} ${detail}`, `${figure} sees ${consequence}`]
  };
}

/**
 * The entry a 1-based `pageIndex` lands on, wrapping in both directions.
 *
 * JavaScript's `%` keeps the sign of its left operand, so `pageIndex` 0 indexed
 * `table[-1]` and answered `undefined` — and the non-null assertion that used to
 * stand here suppressed the compiler where the mistake could still have been
 * seen, so `undefined` was interpolated instead: `dryRunPageBeat(0)` produced
 * the purpose "undefined a brass key.", and a dry run shipped the string
 * "undefined" into the fake page map, the beat-dedup rewrite branch and every
 * MOCK_AI book drafted off them. Nothing in the signature said the argument had
 * to be 1-based and `dryRunPageBeat` offsets it by `5 * variant` from three call
 * sites, so the modulo is made euclidean rather than the callers audited: every
 * integer now names a real entry. The assertion goes with it, leaving one way
 * past the lookup — a table with no entries, which is a mistake at the table and
 * throws there rather than five string interpolations downstream.
 */
export function rotate<T>(table: readonly T[], pageIndex: number): T {
  const slot = (((pageIndex - 1) % table.length) + table.length) % table.length;
  const entry = table[slot];
  if (entry === undefined) {
    throw new Error("Dry-run rotation table is empty.");
  }
  return entry;
}

export function dryRunDetail(pageIndex: number): string {
  return rotate(DRY_RUN_DETAILS, pageIndex);
}
