import { prisma } from "./client.ts";
import {
  embeddingScopeConditions,
  mapRetrievalCandidates,
  retrievalTopK,
  type EmbeddingScopeFilter,
  type RetrievalCandidate,
  type RetrievalCandidateSqlRow
} from "./retrievalQuery.ts";

/**
 * The trigram (`pg_trgm`) arm of semantic retrieval — over embedding summaries
 * and over continuity notes — and the script fold both sides of a needle match
 * go through. `hybridRetrieval.ts` fuses this arm with the cosine one in
 * `embeddingRetrieval.ts`.
 */

/**
 * Noise floor for a `strict_word_similarity(needle, haystack)` score, derived
 * by measurement against pg_trgm with realistic text lengths (the opt-in suite
 * in `lexicalRetrieval.integration.test.ts` re-runs the measurements): a
 * phrase present verbatim in a ~370-char summary scores 1.0, keywords
 * scattered across it ≈ 0.46, a natural question containing the phrase ≈ 0.41,
 * and inflected Persian forms 0.57–0.67 — while the strongest measured noise
 * (a whole ~300-char brief against anything, or a five-letter name against
 * prose sharing only a function-word fragment) stays ≤ 0.29. 0.35 splits
 * signal from noise with margin on both sides.
 *
 * The *strict* variant matters for short needles: a name has so few trigrams
 * that plain `word_similarity` lets a shared "to" reach 0.33, and symmetric
 * `similarity()` is worse still — Jaccard over both trigram sets dilutes a
 * short needle in a long haystack toward zero (0.04 for that same verbatim
 * phrase), which is the failure this floor replaced.
 */
export const LEXICAL_SIMILARITY_FLOOR = 0.35;

/** Needles evaluated per retrieval; keeps the per-row scoring loop bounded. */
const LEXICAL_TERM_LIMIT = 8;

/** The ten digits of a contiguous Arabic-Indic block, against ASCII 0-9. */
function arabicIndicDigitPairs(zero: number): Array<readonly [string, string]> {
  return Array.from({ length: 10 }, (_, digit) => [String.fromCodePoint(zero + digit), String(digit)] as const);
}

/**
 * The script fold, as a 1:1 character map — kept as **one** `[from, to]` table
 * rather than as the two strings SQL wants, because those two carry an
 * equal-length invariant that nothing in the language holds them to.
 * `translate(col, from, to)` *deletes* every `from` character the `to` string
 * is too short to answer, so a `from`-only addition folds the haystack into a
 * space the needle is not folded into: the needle keeps that character, the
 * column loses it, every needle carrying it scores 0, and nothing anywhere
 * raises. Derived from the pairs, the two strings have no length to keep in
 * sync.
 *
 * Arabic kaf and yeh (and alef maksura) against their Persian counterparts, and
 * both Arabic-Indic digit ranges against ASCII — the codepoints that render
 * identically and are typed interchangeably depending on the keyboard.
 */
const LEXICAL_FOLD_PAIRS: ReadonlyArray<readonly [from: string, to: string]> = [
  ["\u0643", "\u06A9"], // Arabic kaf -> Persian keheh
  ["\u064A", "\u06CC"], // Arabic yeh -> Persian yeh
  ["\u0649", "\u06CC"], // Alef maksura -> Persian yeh
  ...arabicIndicDigitPairs(0x0660), // Arabic-Indic digits
  ...arabicIndicDigitPairs(0x06f0) // Extended Arabic-Indic (Persian) digits
];

/**
 * Builds the two `translate()` arguments and the needle-side map in one pass,
 * so they cannot come to describe different folds. What a pair table still
 * cannot state on its own, this refuses at module load rather than at some
 * later retrieval:
 *
 * - both halves of a pair are one *character* — counted in codepoints, because
 *   `translate()` counts characters while `String.length` counts UTF-16 units,
 *   so a fold reaching outside the BMP would disagree with a `.length` check.
 *   A two-character entry shifts every pair after it out of alignment inside
 *   the concatenated strings;
 * - no `from` character repeats, because `translate()` keeps the *first*
 *   mapping of a repeated character while `new Map` keeps the last;
 * - neither half carries `'` or a backslash, which is what lets
 *   {@link lexicalFoldSql} interpolate them straight into a SQL literal.
 *
 * Exported for its colocated test only — `src/index.ts` does not re-export it.
 */
export function compileLexicalFold(pairs: ReadonlyArray<readonly [string, string]>): {
  from: string;
  to: string;
  map: ReadonlyMap<string, string>;
} {
  const map = new Map<string, string>();
  let from = "";
  let to = "";
  for (const [fromChar, toChar] of pairs) {
    const pair = `${JSON.stringify(fromChar)} -> ${JSON.stringify(toChar)}`;
    if ([...fromChar].length !== 1 || [...toChar].length !== 1) {
      throw new Error(`lexical fold pair ${pair} is not one character on each side; translate() folds one character at a time`);
    }
    if (map.has(fromChar)) {
      throw new Error(
        `lexical fold pair ${pair} repeats a source character; translate() would keep the first mapping and the needle map the last`
      );
    }
    if (/['\\]/.test(fromChar + toChar)) {
      throw new Error(`lexical fold pair ${pair} carries a quote or a backslash, which cannot be interpolated into the SQL literal`);
    }
    map.set(fromChar, toChar);
    from += fromChar;
    to += toChar;
  }
  return { from, to, map };
}

const {
  from: LEXICAL_FOLD_FROM,
  to: LEXICAL_FOLD_TO,
  map: LEXICAL_FOLD_MAP
} = compileLexicalFold(LEXICAL_FOLD_PAIRS);

/**
 * Folds a *needle* into the space the haystack is folded into by
 * {@link lexicalFoldSql}. Applied inside {@link cleanLexicalTerms}, so it
 * reaches every needle this module scores and a caller cannot get the two
 * sides out of step — which is the whole failure this fold exists for.
 *
 * The worker selects a page's needles with `foldCharacterName` (its Persian
 * plan character is mentioned by a brief typed from an Arabic keyboard) and
 * then passed the *raw* plan name here, so the documented cross-script recall
 * stopped at the selection and never happened in the search. Measured against
 * pg_trgm, needle "علی" against a summary written with the Arabic yeh scores
 * 0.333 — under {@link LEXICAL_SIMILARITY_FLOOR}, so the page is never
 * returned; "یاسمین" scores 0.077 and "کریم" against Arabic kaf+yeh scores
 * 0.0, because a name is 3-6 letters and one differing codepoint takes out most
 * of its trigrams. Folded on both sides all three score 1.0. Latin needs none
 * of this: "José" against "Jose" already measures 0.43, since one differing
 * character in a longer word leaves most trigrams intact.
 *
 * **This is deliberately not `foldCharacterName`.** That fold answers "are
 * these two names the same person", and to do it it deletes ZWNJ, collapses
 * whitespace and drops the marks that are optional in the script they belong
 * to. pg_trgm scores *words*, and deleting a separator rewrites the
 * segmentation both sides are scored in: "علی" against "علی‌رضا" measures 1.0
 * today because the ZWNJ is a word break, and 0.375 once it is deleted. Its
 * mark list cannot come along either, whatever it holds: it is a per-script
 * enumeration (`\p{M}` wholesale was the bug that made it one — it ate the
 * Devanagari matras), and Postgres regex has no Unicode-property classes, so
 * bringing it here means copying the enumeration into a query — or worse an
 * index — and keeping the copy in step by migration. A 1:1 map can change
 * neither length nor word boundaries, so it can only ever raise a score.
 */
export function foldLexicalText(value: string): string {
  // `?? char` is `translate()`'s own rule for a character the `from` string does
  // not name: leave it alone. It stands in for no *pair* — every entry in the
  // map came from `LEXICAL_FOLD_PAIRS` with both halves present.
  return [...value].map((char) => LEXICAL_FOLD_MAP.get(char) ?? char).join("");
}

/**
 * The same fold over a haystack column. Folding only the needle would move the
 * mismatch rather than close it: the stored `text` is whatever the model wrote,
 * so a needle already in Persian form still faces an Arabic-form summary.
 *
 * `translate()` is IMMUTABLE and built in — no `unaccent`, no second
 * `CREATE EXTENSION` on top of the one this feature already cannot count on
 * (see {@link degradeRetrievalArm}), and no `normalize`/`regexp_replace` chain
 * whose ranges would have to be maintained against Unicode. Nothing is lost to
 * the extra per-row work: migration `000055_trigram_memory_search` deleted the
 * trigram GIN indexes on these columns on purpose, because `gin_trgm_ops`
 * cannot serve a `strict_word_similarity(...) > floor` function-call predicate
 * at all — the scan is already bounded by btree on `(projectId, scope)`, which
 * a fold over `text` does not touch. Being IMMUTABLE, it also stays indexable
 * by expression if that ever changes. The constants carry no quote to escape,
 * which {@link compileLexicalFold} asserts rather than assumes.
 *
 * Exported for the colocated tests, which run this exact expression against a
 * real Postgres to measure that a column folds to what {@link foldLexicalText}
 * makes of the needle; `src/index.ts` does not re-export it.
 */
export function lexicalFoldSql(column: string): string {
  return `translate(${column}, '${LEXICAL_FOLD_FROM}', '${LEXICAL_FOLD_TO}')`;
}

declare const cleanLexicalTermsBrand: unique symbol;

/**
 * Needles already through {@link cleanLexicalTerms} — folded, trimmed, deduped
 * and cut to {@link LEXICAL_TERM_LIMIT}. The brand exists only in the type
 * system; at runtime this is an ordinary `string[]`.
 *
 * It is here so "already cleaned" can be a *signature* rather than a comment.
 * A caller that has to look at the cleaned terms for its own reasons — the
 * hybrid retrieval reads their count to decide whether the lexical arm is
 * engaged at all — would otherwise clean them, hand the raw ones on, and have
 * this module clean them a second time: the same fold over every needle twice
 * per retrieval, and, the part that actually matters, two independent
 * derivations of a question the failure policy in `hybridRetrieval.ts` settles
 * a whole call on.
 */
export type CleanLexicalTerms = string[] & { readonly [cleanLexicalTermsBrand]: true };

export function cleanLexicalTerms(terms: string[]): CleanLexicalTerms {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const term of terms) {
    // Folded before the dedupe, so two spellings of one name cost one needle.
    const trimmed = foldLexicalText(term.trim());
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    cleaned.push(trimmed);
    if (cleaned.length >= LEXICAL_TERM_LIMIT) {
      break;
    }
  }
  // The one place the brand is applied, which is what makes it mean anything:
  // every other value of this type came out of here.
  return cleaned as CleanLexicalTerms;
}

/**
 * How a query spells the table it scores. Both fields are module constants at
 * their call sites — `e."text"` over `Embedding`, `note."body"` over
 * `ContinuityNote` — and are the only thing {@link lexicalMatchSql}
 * interpolates that is not fixed text, exactly as `scopeColumn` is for
 * {@link embeddingScopeConditions}. Nothing a request can reach comes near
 * either; the needles are the only user input here and they are bound.
 *
 * The alias is taken once and used twice — for the scored column and for the
 * `createdAt` tiebreak — so a query cannot rank one table by another's clock.
 */
type LexicalMatchTarget = {
  /** The table's alias in this query: `e`, `note`. */
  alias: string;
  /** The prose column, quoted and unqualified: `"text"`, `"body"`. */
  textColumn: string;
};

/**
 * The scoring block both trigram searches are assembled from: the lateral that
 * scores every needle against the folded prose column and keeps the best, the
 * floor that best score has to clear, and the ranking that puts the best first.
 *
 * **It takes the needles themselves rather than a placeholder, and that is the
 * point.** {@link lexicalFoldSql} over a column is only correct paired with
 * {@link foldLexicalText} over the needle it is scored against — the invariant
 * this module exists to hold — and the two used to be paired by being
 * transcribed next to each other, twice. Here the folded column and the
 * parameter the needles bind to come out of one call whose `terms` can only be
 * a {@link CleanLexicalTerms}, so there is no way to emit the `translate()`
 * without also binding needles that have been folded by `cleanLexicalTerms`.
 * A fold widened on one side alone stops being reachable rather than staying
 * merely unlikely.
 *
 * Parameters come back the way {@link embeddingScopeConditions} returns them —
 * the needle placeholder numbered off `precedingParams` rather than written out
 * — so it cannot come to name a value that is not there, and the caller passes
 * the returned `params` on to whatever numbers itself after this.
 *
 * Only what the two queries genuinely share is here. Their `SELECT` lists,
 * their tables, their ownership predicates and their two different page bounds
 * — the embeddings arm bounds on the `page:<index>` scope, the notes search on
 * the `pageId` foreign key — stay at the call sites, because those are
 * different filters over different tables and not one filter with a flag.
 *
 * Not in `retrievalQuery.ts` beside the fragments the two *arms* of a hybrid
 * retrieval share: this one is the lexical arm's own, and moving it there would
 * make that module import the fold from this one, which imports it back.
 */
function lexicalMatchSql(options: {
  target: LexicalMatchTarget;
  terms: CleanLexicalTerms;
  precedingParams: unknown[];
}): { lateral: string; floorCondition: string; ranking: string; params: unknown[] } {
  const { alias, textColumn } = options.target;
  const params = [...options.precedingParams, options.terms];
  const needles = `$${params.length}`;
  return {
    lateral: `CROSS JOIN LATERAL (
       SELECT max(strict_word_similarity(t."needle", ${lexicalFoldSql(`${alias}.${textColumn}`)})) AS "similarity"
       FROM unnest(${needles}::text[]) AS t("needle")
     ) AS match`,
    floorCondition: `match."similarity" > ${LEXICAL_SIMILARITY_FLOOR}`,
    ranking: `match."similarity" DESC, ${alias}."createdAt" DESC`,
    params
  };
}

export type RetrieveLexicalEmbeddingsOptions = EmbeddingScopeFilter & {
  projectId: string;
  /**
   * Short, distinctive needles — a character name, a named object, a typed
   * search phrase. Each is matched needle-in-haystack against `Embedding.text`
   * — both sides script-folded, see {@link foldLexicalText} — and a row is
   * ranked by its best needle. Whole briefs or paragraphs make
   * useless needles: `word_similarity` of a ~300-char string never clears
   * {@link LEXICAL_SIMILARITY_FLOOR} against anything, so callers must extract
   * the distinctive terms rather than pass composed prompt text.
   */
  queryTerms: string[];
  topK?: number | undefined;
};

export type RetrieveCleanedLexicalEmbeddingsOptions = Omit<RetrieveLexicalEmbeddingsOptions, "queryTerms"> & {
  /** Needles that have already been through {@link cleanLexicalTerms}. */
  queryTerms: CleanLexicalTerms;
};

/**
 * Trigram (`pg_trgm`) needle search over the Embedding table's `text`. This is
 * the lexical half of hybrid retrieval: it surfaces rows containing the rare
 * distinctive tokens a story turns on — names, places, objects — that a
 * whole-string embedding barely registers. Ranked by
 * `strict_word_similarity(needle, text)`, pg_trgm's asymmetric
 * needle-in-haystack score, because the haystack is a long summary and
 * symmetric `similarity()` dilutes a short needle below any usable floor.
 * Script-agnostic, so it works on Persian/CJK text with no stemmer — and both
 * the needles and this column go through {@link foldLexicalText} /
 * `lexicalFoldSql` first, so a name typed from a different keyboard than the
 * one the page was written on is still the same needle. `similarity` on the
 * returned rows is the best needle's trigram score, not cosine; the returned
 * `text` is the stored prose, never the folded form.
 *
 * Needles are cleaned here, once. A caller that already had to derive something
 * from the cleaned terms calls {@link retrieveCleanedLexicalEmbeddings} with
 * them instead of handing the raw ones back — see {@link CleanLexicalTerms} for
 * why that seam is a type rather than a convention.
 */
export async function retrieveLexicalEmbeddings(
  options: RetrieveLexicalEmbeddingsOptions
): Promise<RetrievalCandidate[]> {
  return retrieveCleanedLexicalEmbeddings({ ...options, queryTerms: cleanLexicalTerms(options.queryTerms) });
}

/**
 * {@link retrieveLexicalEmbeddings} over needles already cleaned. A seam inside
 * this package's retrieval split — `src/index.ts` re-exports neither this nor
 * {@link cleanLexicalTerms}, and a caller outside the package could not hold a
 * {@link CleanLexicalTerms} to call it with anyway.
 *
 * Empty terms still answer `[]` rather than assert: that keeps the wrapper
 * above trivially correct for a caller whose needles all folded away, and the
 * one caller that passes its own cleaned terms only reaches this when it has
 * already found some.
 */
export async function retrieveCleanedLexicalEmbeddings(
  options: RetrieveCleanedLexicalEmbeddingsOptions
): Promise<RetrievalCandidate[]> {
  const terms = options.queryTerms;
  if (terms.length === 0) {
    return [];
  }
  const topK = retrievalTopK(options.topK);

  // `$1` is this arm's own and `$2` is the needles the match block bound; the
  // scope filter numbers itself from what that returned, and is the *same*
  // filter the cosine arm applies — see the builder.
  const match = lexicalMatchSql({
    target: { alias: "e", textColumn: `"text"` },
    terms,
    precedingParams: [options.projectId]
  });
  const scope = embeddingScopeConditions({
    filter: options,
    scopeColumn: `e."scope"`,
    precedingParams: match.params
  });
  const conditions = [`e."projectId" = $1`, `e."text" <> ''`, ...scope.conditions];

  const rows = await prisma.$queryRawUnsafe<RetrievalCandidateSqlRow[]>(
    `SELECT e."id", e."scope", e."sourceId", e."text", match."similarity"
     FROM "Embedding" AS e
     ${match.lateral}
     WHERE ${conditions.join(" AND ")} AND ${match.floorCondition}
     ORDER BY ${match.ranking}
     LIMIT ${topK}`,
    ...scope.params
  );

  return mapRetrievalCandidates(rows);
}

export type LexicalContinuityNote = { id: string; body: string };

export type RetrieveLexicalContinuityNotesOptions = {
  projectId: string;
  queryTerms: string[];
  /**
   * Exclusive upper bound in *model* page index — `Page.index`, never a printed
   * page number — or `null` for a load that deliberately spans the whole book
   * (a review, a replan, a page inserted into finished prose).
   *
   * Required rather than optional-with-a-default, because the `ContinuityNote`
   * table is not a prefix of the manuscript: pages generate in parallel waves
   * and a FAILED_QA retry redrafts a page whose successors are already
   * COMPLETED and have written notes of their own. Unbounded, a page-30 redraft
   * in a finished 60-page book ranks the notes pages 41-60 wrote about that
   * page's *own* cast — those are the rows naming it most, so they score
   * highest — into the tail of a list every prompt truncates from the front.
   * {@link EmbeddingScopeFilter.beforePageIndex} stays optional
   * because `research:` scopes share that sweep and have no place on the page
   * axis; every continuity note is owned by a page, so there is nothing here for
   * an absent bound to mean.
   *
   * Applied through the `pageId` foreign key, not through `pageScopeIndexSql`
   * (`retrievalQuery.ts`). The scope is display text the schema explicitly
   * refuses to treat as identity, and it is not always `page:<index>`: an edit
   * writes `page:<index>:edit:<operationId>`, which that pattern resolves to
   * NULL — bounding on it would drop every edited page's notes out of the
   * search instead of placing them in time. A surviving note with no `pageId`
   * is project-scoped, because the ownership filter below has already removed
   * the ambiguous page-scoped ones, and a note belonging to no page is bounded
   * by none.
   */
  beforePageIndex: number | null;
  topK?: number | undefined;
};

/**
 * Trigram needle search over a project's continuity notes, scored and ranked by
 * the same {@link lexicalMatchSql} block {@link retrieveLexicalEmbeddings} uses
 * rather than by a second transcription of it: a note is scored by its best
 * `strict_word_similarity(needle, body)` and nothing below
 * {@link LEXICAL_SIMILARITY_FLOOR} survives, so an empty result means "no note
 * mentions these terms", never "here are the least unrelated notes".
 *
 * Mirrors the ownership filter of the worker's `loadContinuityNotes`:
 * page-scoped rows that lost their Page cannot safely be matched back from
 * `page:<index>` because a structural edit may have reused that index. And it
 * mirrors that function's page bound — see
 * {@link RetrieveLexicalContinuityNotesOptions.beforePageIndex}, which both
 * arms of the note load apply, in the query and ahead of the `LIMIT`: a bound
 * taken over the returned rows would shrink a late page's recall to whatever
 * happened to survive the cut rather than hand it its own past.
 */
export async function retrieveLexicalContinuityNotes(
  options: RetrieveLexicalContinuityNotesOptions
): Promise<LexicalContinuityNote[]> {
  const terms = cleanLexicalTerms(options.queryTerms);
  if (terms.length === 0) {
    return [];
  }
  const topK = retrievalTopK(options.topK);
  const match = lexicalMatchSql({
    target: { alias: "note", textColumn: `"body"` },
    terms,
    precedingParams: [options.projectId]
  });
  const params = match.params;
  let pageBound = "";
  if (options.beforePageIndex !== null) {
    // The project is named inside the anti-forward-leak `EXISTS` as well, so it
    // resolves through `Page_projectId_index_key` rather than scanning every
    // project's pages for a low enough index.
    pageBound =
      ` AND (note."pageId" IS NULL OR EXISTS (
         SELECT 1 FROM "Page" AS p
         WHERE p."id" = note."pageId" AND p."projectId" = $1 AND p."index" < $3::int
       ))`;
    params.push(Math.floor(options.beforePageIndex));
  }
  return prisma.$queryRawUnsafe<LexicalContinuityNote[]>(
    `SELECT note."id", note."body"
     FROM "ContinuityNote" AS note
     ${match.lateral}
     WHERE note."projectId" = $1
       AND NOT (note."pageId" IS NULL AND note."scope" LIKE 'page:%')${pageBound}
       AND ${match.floorCondition}
     ORDER BY ${match.ranking}
     LIMIT ${topK}`,
    ...params
  );
}
