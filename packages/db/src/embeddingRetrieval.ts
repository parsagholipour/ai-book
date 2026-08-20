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
 * The cosine (pgvector) arm of semantic retrieval. `lexicalRetrieval.ts` holds
 * the trigram arm, `hybridRetrieval.ts` fuses the two, and `retrievalQuery.ts`
 * holds what both arms are built from: the scope filter, the row cap, the
 * top-K, and the {@link RetrievalCandidate} row shape they must agree on.
 */

export type RetrieveSimilarEmbeddingsOptions = EmbeddingScopeFilter & {
  projectId: string;
  vector: number[];
  topK?: number | undefined;
};

/**
 * Cosine-similarity search over the pgvector-backed Embedding table.
 * Returns rows ordered from most to least similar.
 */
export async function retrieveSimilarEmbeddings(
  options: RetrieveSimilarEmbeddingsOptions
): Promise<RetrievalCandidate[]> {
  if (options.vector.length === 0) {
    return [];
  }
  const topK = retrievalTopK(options.topK);
  const vectorLiteral = `[${options.vector.map((value) => Number(value).toFixed(7)).join(",")}]`;

  // `$1` and `$2` are this arm's own; the scope filter numbers itself from `$3`.
  const scope = embeddingScopeConditions({
    filter: options,
    scopeColumn: `"scope"`,
    precedingParams: [options.projectId, vectorLiteral]
  });
  const conditions = [`"projectId" = $1`, `"vector" IS NOT NULL`, ...scope.conditions];

  const rows = await prisma.$queryRawUnsafe<RetrievalCandidateSqlRow[]>(
    `SELECT "id", "scope", "sourceId", "text", 1 - ("vector" <=> $2::vector) AS "similarity"
     FROM "Embedding"
     WHERE ${conditions.join(" AND ")}
     ORDER BY "vector" <=> $2::vector ASC
     LIMIT ${topK}`,
    ...scope.params
  );

  return mapRetrievalCandidates(rows);
}
