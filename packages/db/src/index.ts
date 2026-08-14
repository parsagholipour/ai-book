import { templateDefinitions } from "@book-maker/core";
import { prisma } from "./client.ts";

export { prisma, PrismaClient, Prisma } from "./client.ts";
export * from "./planRevisionRetry.ts";
export * from "./creditPricing.ts";
export * from "./researchLinks.ts";
export * from "./storyState.ts";
export * from "./generated/prisma/enums.ts";
export type * from "./generated/prisma/models.ts";

export async function ensureSeedTemplates() {
  for (const template of templateDefinitions) {
    await prisma.template.upsert({
      where: { slug: template.slug },
      create: {
        slug: template.slug,
        name: template.name,
        category: template.category,
        description: template.description,
        defaultConfig: template.defaultConfig,
        styleRules: template.styleRules
      },
      update: {
        name: template.name,
        category: template.category,
        description: template.description,
        defaultConfig: template.defaultConfig,
        styleRules: template.styleRules
      }
    });
  }
}

export type SimilarEmbedding = {
  id: string;
  scope: string;
  sourceId: string | null;
  text: string;
  similarity: number;
};

export type RetrieveSimilarEmbeddingsOptions = {
  projectId: string;
  vector: number[];
  topK?: number | undefined;
  /** Restrict to embeddings whose scope starts with this prefix (e.g. "page:" or "research:"). */
  scopePrefix?: string | undefined;
  /** Exact scopes to exclude (e.g. pages already present in the recency window). */
  excludeScopes?: string[] | undefined;
};

/**
 * Cosine-similarity search over the pgvector-backed Embedding table.
 * Returns rows ordered from most to least similar.
 */
export async function retrieveSimilarEmbeddings(
  options: RetrieveSimilarEmbeddingsOptions
): Promise<SimilarEmbedding[]> {
  if (options.vector.length === 0) {
    return [];
  }
  const topK = Math.max(1, Math.min(50, Math.floor(options.topK ?? 8)));
  const vectorLiteral = `[${options.vector.map((value) => Number(value).toFixed(7)).join(",")}]`;

  const conditions = [`"projectId" = $1`, `"vector" IS NOT NULL`];
  const params: unknown[] = [options.projectId, vectorLiteral];
  let nextParam = 3;
  if (options.scopePrefix) {
    conditions.push(`"scope" LIKE $${nextParam}`);
    params.push(`${options.scopePrefix}%`);
    nextParam += 1;
  }
  if (options.excludeScopes && options.excludeScopes.length > 0) {
    conditions.push(`NOT ("scope" = ANY($${nextParam}::text[]))`);
    params.push(options.excludeScopes);
    nextParam += 1;
  }

  const rows = await prisma.$queryRawUnsafe<
    Array<{ id: string; scope: string; sourceId: string | null; text: string; similarity: number | string }>
  >(
    `SELECT "id", "scope", "sourceId", "text", 1 - ("vector" <=> $2::vector) AS "similarity"
     FROM "Embedding"
     WHERE ${conditions.join(" AND ")}
     ORDER BY "vector" <=> $2::vector ASC
     LIMIT ${topK}`,
    ...params
  );

  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    sourceId: row.sourceId,
    text: row.text,
    similarity: Number(row.similarity)
  }));
}
