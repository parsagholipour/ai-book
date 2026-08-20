import { retrieveSimilarEmbeddings } from "./embeddingRetrieval.ts";
import { cleanLexicalTerms, retrieveCleanedLexicalEmbeddings } from "./lexicalRetrieval.ts";
import { degradeRetrievalArm } from "./retrievalArms.ts";
import { retrievalTopK, type EmbeddingScopeFilter, type RetrievalCandidate } from "./retrievalQuery.ts";

/**
 * Reciprocal-rank fusion of the cosine arm (`embeddingRetrieval.ts`) and the
 * trigram arm (`lexicalRetrieval.ts`), and the independent-failure policy that
 * keeps one arm's fault from taking the other's rows down with it.
 */

export type HybridEmbedding = RetrievalCandidate & {
  /** Reciprocal-rank-fusion score across the vector and lexical rankings. */
  fusedScore: number;
  /** Cosine similarity from the vector arm (0 when the row was a lexical-only hit). */
  cosineSimilarity: number;
  /** Trigram similarity from the lexical arm (0 when the row was a vector-only hit). */
  lexicalSimilarity: number;
};

export type RetrieveHybridEmbeddingsOptions = EmbeddingScopeFilter & {
  projectId: string;
  /** Query vector for the cosine arm; pass an empty array to run lexical-only. */
  vector: number[];
  /** Distinctive needles for the trigram arm; pass an empty array to run vector-only. */
  queryTerms: string[];
  topK?: number | undefined;
  /**
   * Errors neither arm may swallow, handed to {@link degradeRetrievalArm} — the
   * worker passes its stop-signal predicate — or `null` for a call site with no
   * cancellation to honour (the package's own integration suites).
   *
   * Required rather than optional-with-a-default, for the reason
   * {@link RetrieveLexicalContinuityNotesOptions.beforePageIndex} is: every
   * production caller of this function is inside a page job a reader can stop,
   * and the whole hazard here is that a degrade *looks* like success. An
   * optional predicate is silently absent at a new call site, and what that
   * costs is a stopped generation settling as a thinner result instead of as a
   * stop — precisely how this hole came to exist, since `loadContinuityNotes`
   * had been passing one all along. `null` is a claim, not an opt-out.
   */
  rethrowIf: ((error: unknown) => boolean) | null;
};

/** Reciprocal-rank-fusion constant; 60 is the value from the original RRF paper. */
const RRF_K = 60;

/**
 * Reciprocal-rank fusion of the cosine and trigram rankings. A row's fused
 * score is the sum of `1 / (RRF_K + rank + 1)` over each 0-based ranking it
 * appears in, so a page both arms rank highly floats to the top, while a
 * strong hit in either arm alone still surfaces.
 *
 * `similarity` on the returned rows is the cosine score (0 for lexical-only
 * hits), preserving the meaning of the field for existing callers; the separate
 * `lexicalSimilarity` lets a caller keep a low-similarity vector hit that the
 * lexical arm vouched for — nonzero means the row cleared
 * {@link LEXICAL_SIMILARITY_FLOOR} for one of the needles, never merely
 * "shared some trigrams".
 */
export function fuseHybridEmbeddingRanks(
  vectorRows: RetrievalCandidate[],
  lexicalRows: RetrievalCandidate[],
  topK: number
): HybridEmbedding[] {
  const fused = new Map<string, HybridEmbedding>();
  vectorRows.forEach((row, rank) => {
    fused.set(row.id, {
      ...row,
      fusedScore: 1 / (RRF_K + rank + 1),
      cosineSimilarity: row.similarity,
      lexicalSimilarity: 0
    });
  });
  lexicalRows.forEach((row, rank) => {
    const contribution = 1 / (RRF_K + rank + 1);
    const existing = fused.get(row.id);
    if (existing) {
      existing.fusedScore += contribution;
      existing.lexicalSimilarity = row.similarity;
    } else {
      fused.set(row.id, {
        ...row,
        similarity: 0,
        fusedScore: contribution,
        cosineSimilarity: 0,
        lexicalSimilarity: row.similarity
      });
    }
  });

  return [...fused.values()].sort((left, right) => right.fusedScore - left.fusedScore).slice(0, topK);
}

/** Arm names for {@link degradeRetrievalArm}; also the keys of its failure census. */
const VECTOR_EMBEDDING_ARM = "Vector embedding retrieval";
const LEXICAL_EMBEDDING_ARM = "Lexical embedding retrieval";

/**
 * Fuses vector (cosine) and lexical (trigram) retrieval with reciprocal rank
 * fusion. Each arm is pooled deeper than `topK` so {@link fuseHybridEmbeddingRanks}
 * can reorder before the cut. Pass an empty `vector` to skip the cosine SQL and
 * run lexical-only; pass no usable `queryTerms` to run vector-only.
 *
 * **The arms fail independently.** One arm failing degrades the result to the
 * other arm's rows — see {@link degradeRetrievalArm} for the missing-`pg_trgm`
 * incident where a lexical fault took the cosine arm down with it — and fusion
 * over one empty ranking distorts nothing: a row's RRF score is a sum over the
 * rankings it appears in, so the survivor keeps its own order and its whole
 * `topK`, exactly as a single-arm call would have returned it.
 *
 * When no *engaged* arm answered there is nothing to degrade to, and the
 * failure propagates rather than being returned as an empty, successful-looking
 * result: an arm the caller never asked for is not a survivor, so a trigram
 * fault is total in lexical-only mode and a cosine fault is total in
 * vector-only mode. Both engaged and both failed raises an `AggregateError`, so
 * a chronic fault under a transient one is still in the log.
 *
 * `rethrowIf` is the one thing a degrade must not apply to — see the option.
 * It reaches both arms' {@link degradeRetrievalArm} calls *and* the
 * both-arms-failed path, because those are two different ways to lose the same
 * error and only the first of them is the helper's to police.
 */
export async function retrieveHybridEmbeddings(
  options: RetrieveHybridEmbeddingsOptions
): Promise<HybridEmbedding[]> {
  const topK = retrievalTopK(options.topK);
  // Pull a deeper pool from each arm than we return, so fusion has room to
  // reorder before the topK cut.
  const pool = Math.min(50, Math.max(topK * 3, 20));

  // Cleaned once, here, and the *same array* is what the lexical arm searches
  // with. The fold, the dedupe and the term-limit cut used to run twice per
  // retrieval — once for this count and once inside the arm — which is cheap
  // duplicated work and one expensive fact: two independent derivations of "is
  // the lexical arm engaged". That answer decides whether a lexical failure
  // degrades or throws below, so the two must be the same answer by
  // construction rather than because one function is deterministic.
  const lexicalTerms = cleanLexicalTerms(options.queryTerms);
  const runsVector = options.vector.length > 0;
  const runsLexical = lexicalTerms.length > 0;
  if (!runsVector && !runsLexical) {
    return [];
  }

  // The scope narrowing, derived **once** and spread into both arms, so the two
  // are the same filter by construction rather than by two transcriptions
  // staying equal. This is the hazard `embeddingScopeConditions` was extracted
  // to close one level down, arriving one level up: every field of an
  // `EmbeddingScopeFilter` is optional, so a fourth one enumerated into one arm
  // and not the other compiles, runs, and makes the fusion a comparison between
  // two different candidate sets — RRF sums ranks, and nothing about a rank
  // reveals that the two rankings were drawn from different books.
  //
  // The two spellings below are not an inconsistency to tidy: `scopePrefix` and
  // `excludeScopes` test truthiness because an empty prefix and an empty
  // exclusion list narrow nothing, while `beforePageIndex` tests `undefined`
  // because 0 is falsy and *means* something — "no page before this one",
  // which is how a retrieval for the book's first page bounds itself.
  const armFilter: EmbeddingScopeFilter = {
    ...(options.scopePrefix ? { scopePrefix: options.scopePrefix } : {}),
    ...(options.excludeScopes ? { excludeScopes: options.excludeScopes } : {}),
    ...(options.beforePageIndex === undefined ? {} : { beforePageIndex: options.beforePageIndex })
  };

  // Settled, not `Promise.all`: one arm's rejection must not settle the other's
  // rows, which is the whole point of running two.
  const [vectorArm, lexicalArm] = await Promise.allSettled([
    runsVector
      ? retrieveSimilarEmbeddings({
          projectId: options.projectId,
          vector: options.vector,
          topK: pool,
          ...armFilter
        })
      : Promise.resolve<RetrievalCandidate[]>([]),
    runsLexical
      ? retrieveCleanedLexicalEmbeddings({
          projectId: options.projectId,
          queryTerms: lexicalTerms,
          topK: pool,
          ...armFilter
        })
      : Promise.resolve<RetrievalCandidate[]>([])
  ]);

  const failures: unknown[] = [vectorArm, lexicalArm]
    .filter((arm): arm is PromiseRejectedResult => arm.status === "rejected")
    .map((arm) => arm.reason);
  // Engaged from the same two flags the arms were started from, so an arm
  // nobody asked for cannot be counted as one that answered.
  if (failures.length === (runsVector ? 1 : 0) + (runsLexical ? 1 : 0)) {
    if (failures.length === 1) {
      throw failures[0];
    }
    // Both engaged arms failed. A failure `rethrowIf` names is thrown as
    // itself rather than wrapped: the worker's `isStopRequestedError` does not
    // look inside an `AggregateError`, so a stop bundled into one would settle
    // a cancelled page job as a warning and an empty memory. The wrap is for
    // two ordinary faults, which is what it was written for.
    for (const failure of failures) {
      if (options.rethrowIf?.(failure)) {
        throw failure;
      }
    }
    throw new AggregateError(failures, `Hybrid embedding retrieval failed for project ${options.projectId}`);
  }

  const vectorRows =
    vectorArm.status === "fulfilled"
      ? vectorArm.value
      : degradeRetrievalArm<RetrievalCandidate[]>({
          arm: VECTOR_EMBEDDING_ARM,
          projectId: options.projectId,
          error: vectorArm.reason,
          fallback: [],
          rethrowIf: options.rethrowIf
        });
  const lexicalRows =
    lexicalArm.status === "fulfilled"
      ? lexicalArm.value
      : degradeRetrievalArm<RetrievalCandidate[]>({
          arm: LEXICAL_EMBEDDING_ARM,
          projectId: options.projectId,
          error: lexicalArm.reason,
          fallback: [],
          rethrowIf: options.rethrowIf
        });

  return fuseHybridEmbeddingRanks(vectorRows, lexicalRows, topK);
}
