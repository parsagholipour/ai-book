import { rankSourcePassages, type EmbeddingAdapter, type SourceRef, type SourceService } from "@book-maker/core";
import { prisma } from "./client.ts";

/** Scope is server-owned: never construct refs from model arguments or client JSON. */
export function createSourceService(userId: string, refs: SourceRef[], embedding?: EmbeddingAdapter): SourceService {
  const scope = refs.map(({ sourceId, version }) => ({ sourceId, version, extraction: { source: { userId } } }));
  const chunks = () => prisma.sourceChunk.findMany({ where: { OR: scope }, orderBy: [{ sourceId: "asc" }, { ordinal: "asc" }], include: { extraction: { select: { source: { select: { name: true } } } } } });
  return {
    async overview(sourceId) {
      if (!refs.length) return [];
      const rows = await prisma.sourceExtraction.findMany({
        where: { source: { userId }, OR: refs.filter((ref) => !sourceId || ref.sourceId === sourceId) },
        include: { source: true, chunks: { orderBy: { ordinal: "asc" }, select: { ordinal: true, locator: true, summary: true } } }
      });
      return rows.map((row) => ({ sourceId: row.sourceId, version: row.version, name: row.source.name, status: row.status, summary: row.summary,
        unreadable: Array.isArray(row.unreadable) ? row.unreadable.filter((value): value is string => typeof value === "string") : [],
        sections: row.chunks.map((chunk) => ({ ...chunk, summary: chunk.summary || "Summary pending; read this passage." })) }));
    },
    async search(query, sourceId) {
      if (!refs.length) return [];
      const [rows, vector] = await Promise.all([chunks(), embedding?.embed(query).catch(() => undefined)]);
      return rankSourcePassages(rows.filter((row) => !sourceId || row.sourceId === sourceId).map((row) => ({
        sourceId: row.sourceId, version: row.version, ordinal: row.ordinal, name: row.extraction.source.name, locator: row.locator, content: row.content,
        embedding: Array.isArray(row.embedding) && row.embedding.every((v) => typeof v === "number") ? row.embedding as number[] : undefined
      })), query, vector);
    },
    async read(sourceId, version, ordinal) {
      if (!refs.some((ref) => ref.sourceId === sourceId && ref.version === version)) return null;
      const row = await prisma.sourceChunk.findFirst({ where: { sourceId, version, ordinal, extraction: { source: { userId } } }, include: { extraction: { select: { source: { select: { name: true } } } } } });
      return row ? { sourceId, version, ordinal, name: row.extraction.source.name, locator: row.locator, content: row.content } : null;
    }
  };
}
