import { foldCharacterName, type BookPlan, type EmbeddingAdapter } from "@book-maker/core";
import {
  degradeRetrievalArm,
  pageScope,
  pageScopeIndexText,
  retrieveHybridEmbeddings,
  PAGE_SCOPE_PREFIX
} from "@book-maker/db";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { foldedMentions } from "./entityMentions.js";

/**
 * Continuity memory for long books.
 *
 * Pages beyond the recent window are recalled by embedding similarity rather
 * than by feeding the whole manuscript back to the model, and per-entity state
 * lines keep characters and locations consistent across chapters.
 *
 * This module is the `page:` scope's **read** side, and only that: the gate
 * writers ask before they store any of it (`strategyUsesSemanticMemory`) lives
 * with the writes, since no reader has ever consulted it. The state lines are
 * `entityState.ts`; the `research:` scope is `researchMemory.ts`; what goes into
 * the Embedding table is `embeddingWrites.ts`, and the pass that fills its holes
 * is `embeddingRepair.ts`.
 */

export const SEMANTIC_MEMORY_TOP_K = 6;
export const SEMANTIC_MEMORY_MIN_SIMILARITY = 0.25;
export const RECENT_PAGE_WINDOW = 18;

/**
 * Arm names for {@link degradeRetrievalArm}, and so the keys of its failure
 * census. Both of these fire once per page job on a fault that is usually an
 * environment fact — an embedding provider that answers nothing, a database
 * with neither `pg_trgm` nor `pgvector` — which is precisely the flood the
 * shared ladder exists to turn into a line per order of magnitude.
 */
const QUERY_EMBEDDING_ARM = "Semantic query embedding";
const PAGE_MEMORY_ARM = "Semantic memory retrieval";

/**
 * Best-effort embed of a page's semantic query so one vector can serve both
 * the research and the page-memory retrieval. Failures degrade to undefined
 * through the shared policy — the retrievals then fall back to embedding (or
 * failing) on their own — and a stop still travels, or a stopped run keeps
 * drafting.
 */
export async function embedSemanticQuery(
  embedding: EmbeddingAdapter,
  queryText: string,
  projectId: string
): Promise<number[] | undefined> {
  const query = queryText.trim();
  if (!query) {
    return undefined;
  }
  try {
    return await embedding.embed(query);
  } catch (error) {
    return degradeRetrievalArm<number[] | undefined>({
      arm: QUERY_EMBEDDING_ARM,
      projectId,
      error,
      fallback: undefined,
      // The rethrow this replaced: a provider outage narrows the query to its
      // lexical arm, a reader stopping the run must not be narrowed into
      // anything.
      rethrowIf: isStopRequestedError
    });
  }
}

/**
 * Distinctive needles for the trigram arm of a page's memory retrieval: the
 * plan's character and location names the composed query actually mentions.
 * The composed brief itself makes a useless needle — measured
 * `word_similarity` of a ~300-char brief never clears the lexical floor
 * against anything, and symmetric `similarity()` of it against short notes is
 * dominated by shared stop-word trigrams — while a name present in the
 * haystack scores 1.0 (see `LEXICAL_SIMILARITY_FLOOR` in `@book-maker/db`).
 * Both sides of the *mention check* go through `foldCharacterName`, so a
 * Persian plan character is still selected when the brief spells it from an
 * Arabic keyboard. Selecting it is only half of that promise: the name is
 * emitted raw, and the search it feeds scores it against prose spelled the
 * other way. `@book-maker/db` closes the other half — `foldLexicalText` folds
 * every needle and `lexicalFoldSql` folds the column, so the two meet in one
 * space. Emit the plan's own spelling, not a folded one: the fold that belongs
 * to a trigram search is not this one (`foldCharacterName` deletes the ZWNJ
 * that pg_trgm needs as a word break), and the db layer is where both sides
 * are visible at once.
 */
export function lexicalTermsForQuery(plan: BookPlan, queryText: string): string[] {
  const names = [...plan.characters.map((entry) => entry.name), ...plan.locations.map((entry) => entry.name)];
  const foldedQuery = foldCharacterName(queryText);
  return names.filter((name) => foldedMentions(foldedQuery, foldCharacterName(name)));
}

/**
 * Hybrid (vector + trigram) search over stored page-summary embeddings for
 * long-range continuity outside the recency window. The lexical arm is what
 * recalls a page by the distinctive name or object it mentions even when its
 * whole-summary embedding sits far from the query.
 *
 * Best effort at three depths, and the middle one is load-bearing: an embedding
 * outage drops the query to lexical-only; either arm of the retrieval failing
 * leaves the other arm's rows (`retrieveHybridEmbeddings` settles them
 * separately, so a database with no `pg_trgm` no longer costs a book its
 * *vector* recall as well); and a retrieval where nothing answered becomes an
 * empty result rather than a failed page job. The last is the widest net —
 * empty memory here means a page written with the recency window alone, so the
 * degrade below is the only trace that anything went wrong. It reports on
 * {@link degradeRetrievalArm}'s ladder rather than once per page job, because a
 * database missing both arms' extensions is one fact about the deployment and
 * not three hundred facts about the book.
 *
 * **Only pages before `beforePageIndex` can come back.** The bound is required,
 * not defaulted, because the Embedding table is not a prefix of the manuscript:
 * pages generate in parallel waves, and a FAILED_QA retry redrafts a page whose
 * successors are already COMPLETED and embedded. Without it a page being
 * rewritten could recall `Page 41:` as "earlier continuity" — the same leak
 * `lookupStoredPage` and the `lookup_page` tool clamp against — and the
 * `search_memory` tool description promises the model these are earlier pages.
 * `excludePageIndexes` cannot stand in for it: that list is the recency window,
 * which says nothing about what lies ahead.
 */
export async function retrieveSemanticPageMemory(options: {
  projectId: string;
  queryText: string;
  /**
   * Needles for the trigram arm — entity names for a composed brief, or the
   * model's own query when it searches. Never the whole brief: a long needle
   * scores below the lexical floor against everything, silently disarming
   * the arm this retrieval exists to add.
   */
  lexicalTerms: string[];
  embedding: EmbeddingAdapter;
  excludePageIndexes: number[];
  /**
   * Exclusive upper bound in *model* page index — `Page.index`, the space
   * every `page:<index>` scope is written in, never a printed PDF page number.
   * Pass the index of the page being drafted.
   */
  beforePageIndex: number;
  /** Precomputed query vector, so one embedding call serves both retrievals. */
  vector?: number[] | undefined;
}): Promise<string[]> {
  const query = options.queryText.trim();
  if (!query) {
    return [];
  }
  try {
    // The lexical arm still works without a vector, so an embedding failure
    // narrows recall rather than losing it.
    const vector = options.vector ?? (await embedSemanticQuery(options.embedding, query, options.projectId)) ?? [];
    const rows = await retrieveHybridEmbeddings({
      projectId: options.projectId,
      vector,
      queryTerms: options.lexicalTerms,
      topK: SEMANTIC_MEMORY_TOP_K * 2,
      scopePrefix: PAGE_SCOPE_PREFIX,
      excludeScopes: options.excludePageIndexes.map((index) => pageScope(index)),
      // In SQL, so both arms bound before they pool and fuse before the cut.
      // Filtering the fused rows here instead would let a later page consume a
      // top-K slot and silently shrink what the page actually recalls.
      beforePageIndex: options.beforePageIndex,
      // Or a stopped arm degrades to the other arm's rows, and the stop never
      // reaches the `catch` below that re-throws it.
      rethrowIf: isStopRequestedError
    });
    const seenScopes = new Set<string>();
    const memory: string[] = [];
    for (const row of rows) {
      // Keep a row the cosine arm rated relevant, or one the lexical arm
      // vouched for — a nonzero trigram score means a needle cleared
      // LEXICAL_SIMILARITY_FLOOR, not merely that some trigrams overlapped.
      const relevant = row.cosineSimilarity >= SEMANTIC_MEMORY_MIN_SIMILARITY || row.lexicalSimilarity > 0;
      if (!relevant || seenScopes.has(row.scope)) {
        continue;
      }
      seenScopes.add(row.scope);
      memory.push(`Page ${pageScopeIndexText(row.scope)}: ${row.text}`);
      if (memory.length >= SEMANTIC_MEMORY_TOP_K) {
        break;
      }
    }
    return memory;
  } catch (error) {
    return degradeRetrievalArm<string[]>({
      arm: PAGE_MEMORY_ARM,
      projectId: options.projectId,
      error,
      fallback: [],
      // Same predicate `retrieveHybridEmbeddings` was handed above, for the
      // same reason: nothing below this line may turn a stop into a thinner
      // result.
      rethrowIf: isStopRequestedError
    });
  }
}
