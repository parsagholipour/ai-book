import { type EmbeddingAdapter } from "@book-maker/core";
import {
  degradeRetrievalArm,
  embeddingIsDegraded,
  prisma,
  researchScope,
  retrieveSimilarEmbeddings,
  RESEARCH_SCOPE_PREFIX
} from "@book-maker/db";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { storeEmbedding } from "./embeddingWrites.js";

/**
 * The `research:<sourceId>` scope, both ends of it: the pass that gives every
 * research source a usable embedding row, and the vector search that hands those
 * summaries back to a page being drafted.
 *
 * They are one module because the scope string is the contract between them and
 * nothing else in the codebase knows it. The `page:` scope's recall is
 * `semanticRecall.ts`.
 */

/** Embeds research sources that do not have a *usable* embedding row yet. */
export async function embedResearchSourcesForProject(projectId: string, embedding: EmbeddingAdapter) {
  const sources = await prisma.researchSource.findMany({ where: { projectId } });
  if (sources.length === 0) {
    return;
  }
  const existing = await prisma.embedding.findMany({
    where: { projectId, scope: { startsWith: RESEARCH_SCOPE_PREFIX } },
    select: { sourceId: true, metadata: true }
  });
  const embedded = new Set<string>();
  for (const row of existing) {
    // A degraded row — text but no vector, so the cosine arm can never return
    // it — is deliberately *not* counted as embedded: keeping its sourceId out
    // of this set is what sends the source back through the loop rather than
    // treating the failed call as done forever. `embeddingIsDegraded` is
    // `@book-maker/db`'s, and it is imported rather than restated because the
    // same rule is a SQL predicate over `Embedding.metadata` one line above it
    // there (`embeddingRepairTargets.ts`), where the page hole set asks it: the
    // boolean `false`, never the string `"false"`.
    if (!embeddingIsDegraded(row.metadata) && row.sourceId) {
      embedded.add(row.sourceId);
    }
  }
  for (const source of sources) {
    if (embedded.has(source.id)) {
      continue;
    }
    // Both callers re-run this pass — a redelivered plan-book, a resumed
    // generate-book — so the skip above is what stops a source being paid for
    // twice. A degraded row is not a skip, and its retry needs no delete of its
    // own: `writePreparedEmbedding` upserts `ON CONFLICT ("projectId", "scope")`
    // — the pair `000056_embedding_project_scope_unique` made unique — and its
    // default `"overwrite"` policy refreshes sourceId, text, vector and
    // metadata together, so the placeholder is replaced by the same statement
    // that stores the vector.
    const scope = researchScope(source.id);
    await storeEmbedding({ projectId, scope, sourceId: source.id, text: `${source.title}: ${source.summary}` }, embedding);
  }
}

/**
 * Arm name for {@link degradeRetrievalArm}, and so the key of its failure
 * census. This is the `research:` half of the same page job the `page:` arms in
 * `semanticRecall.ts` serve, and it meets the same deployment faults on every
 * page of every book, so it reports on the same ladder.
 */
const RESEARCH_MEMORY_ARM = "Semantic research retrieval";

/**
 * Vector search over embedded research sources. Returns formatted notes or an
 * empty array when retrieval is unavailable — the shared degrade policy, so a
 * provider or `pgvector` fault costs one line per order of magnitude rather
 * than one per page job. A stop is the one error it may not swallow.
 */
export async function retrieveSemanticResearchNotes(options: {
  projectId: string;
  queryText: string;
  embedding: EmbeddingAdapter;
  topK: number;
  /** Precomputed query vector, so one embedding call serves both retrievals. */
  vector?: number[] | undefined;
}): Promise<string[]> {
  const query = options.queryText.trim();
  if (!query) {
    return [];
  }
  try {
    const vector = options.vector ?? (await options.embedding.embed(query));
    const rows = await retrieveSimilarEmbeddings({
      projectId: options.projectId,
      vector,
      topK: options.topK,
      scopePrefix: RESEARCH_SCOPE_PREFIX
    });
    const seenScopes = new Set<string>();
    const notes: string[] = [];
    for (const row of rows) {
      if (seenScopes.has(row.scope)) {
        continue;
      }
      seenScopes.add(row.scope);
      notes.push(row.text);
    }
    return notes;
  } catch (error) {
    return degradeRetrievalArm<string[]>({
      arm: RESEARCH_MEMORY_ARM,
      projectId: options.projectId,
      error,
      fallback: [],
      // The rethrow this replaced. The embedding call is inside the `try`, and
      // `LoggingEmbeddingAdapter.embed` raises the stop from there, so a run
      // the reader stopped would otherwise come back as a page with no
      // research notes and keep drafting.
      rethrowIf: isStopRequestedError
    });
  }
}
