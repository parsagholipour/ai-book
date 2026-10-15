import { randomUUID } from "node:crypto";
import type { BookPlan, EmbeddingAdapter } from "@book-maker/core";
import { embeddingIsDegraded, Prisma, prisma, researchScope, RESEARCH_SCOPE_PREFIX } from "@book-maker/db";
import { prepareEmbedding, writePreparedEmbedding, type PreparedEmbedding } from "../generation/embeddingWrites.js";
import { runBestEffortPageMemoryWrite } from "../generation/bestEffortSavepoint.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";

type ResearchSource = { query: string; title: string; url?: string | null | undefined; summary: string };
function identity(source: ResearchSource): string {
  return [source.query, source.title, source.url ?? ""].join("\0");
}

/** Provider calls precede publication, so Stop can abort without a committed plan. */
export async function preparePlanningResearch(
  projectId: string,
  notes: BookPlan["researchNotes"],
  embedding: EmbeddingAdapter
): Promise<Map<string, PreparedEmbedding>> {
  const prepared = new Map<string, PreparedEmbedding>();
  try {
    const stored = await prisma.researchSource.findMany({ where: { projectId } });
    const embeddings = await prisma.embedding.findMany({
      where: { projectId, scope: { startsWith: RESEARCH_SCOPE_PREFIX } },
      select: { sourceId: true, metadata: true }
    });
    const embedded = new Set(embeddings.filter((row) => !embeddingIsDegraded(row.metadata)).map((row) => row.sourceId));
    const sources = new Map<string, ResearchSource>(notes.map((source) => [identity(source), source]));
    // Existing identities keep the stored summary, matching source dedupe.
    for (const source of stored) sources.set(identity(source), source);
    for (const source of stored) if (embedded.has(source.id)) sources.delete(identity(source));
    for (const [key, source] of sources) {
      prepared.set(key, await prepareEmbedding(`${source.title}: ${source.summary}`, embedding));
    }
  } catch (error) {
    if (isStopRequestedError(error)) throw error;
    console.warn(`Research embedding preparation failed for project ${projectId}`, error);
  }
  return prepared;
}

/** Sources belong to the plan transaction; optional vectors use its savepoint. */
export async function savePlanningResearch(
  tx: Prisma.TransactionClient,
  projectId: string,
  notes: BookPlan["researchNotes"],
  prepared: ReadonlyMap<string, PreparedEmbedding>
): Promise<void> {
  if (notes.length === 0 && prepared.size === 0) return;
  const sources = await tx.researchSource.findMany({ where: { projectId } });
  const storedKeys = new Set(sources.map(identity));
  const missing = notes.filter((source) => !storedKeys.has(identity(source))).map((source) => ({
    id: randomUUID(), projectId, query: source.query, title: source.title, url: source.url ?? null,
    summary: source.summary, publishedAt: source.publishedAt ? new Date(source.publishedAt) : null
  }));
  if (missing.length > 0) await tx.researchSource.createMany({ data: missing });
  for (const source of [...sources, ...missing]) {
    const value = prepared.get(identity(source));
    if (!value) continue;
    await runBestEffortPageMemoryWrite(tx, () => writePreparedEmbedding({
      projectId, sourceId: source.id, scope: researchScope(source.id), text: `${source.title}: ${source.summary}`
    }, value, tx));
  }
}
