import { randomUUID } from "node:crypto";
import type { BookPlan, EmbeddingAdapter } from "@book-maker/core";
import { prisma, retrieveSimilarEmbeddings } from "@book-maker/db";
import { config } from "../runtime/config.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";

/**
 * Continuity memory for long books.
 *
 * Pages beyond the recent window are recalled by embedding similarity rather
 * than by feeding the whole manuscript back to the model, and per-entity state
 * lines keep characters and locations consistent across chapters.
 */

export const SEMANTIC_MEMORY_TOP_K = 6;
export const SEMANTIC_MEMORY_MIN_SIMILARITY = 0.25;
export const RECENT_PAGE_WINDOW = 18;

/**
 * Vector search over stored page-summary embeddings for long-range continuity
 * that falls outside the recency window. Best effort: failures degrade to an
 * empty result instead of failing the page job.
 */
export async function retrieveSemanticPageMemory(options: {
  projectId: string;
  queryText: string;
  embedding: EmbeddingAdapter;
  excludePageIndexes: number[];
}): Promise<string[]> {
  const query = options.queryText.trim();
  if (!query) {
    return [];
  }
  try {
    const vector = await options.embedding.embed(query);
    const rows = await retrieveSimilarEmbeddings({
      projectId: options.projectId,
      vector,
      topK: SEMANTIC_MEMORY_TOP_K * 2,
      scopePrefix: "page:",
      excludeScopes: options.excludePageIndexes.map((index) => `page:${index}`)
    });
    const seenScopes = new Set<string>();
    const memory: string[] = [];
    for (const row of rows) {
      if (row.similarity < SEMANTIC_MEMORY_MIN_SIMILARITY || seenScopes.has(row.scope)) {
        continue;
      }
      seenScopes.add(row.scope);
      memory.push(`Page ${row.scope.replace("page:", "")}: ${row.text}`);
      if (memory.length >= SEMANTIC_MEMORY_TOP_K) {
        break;
      }
    }
    return memory;
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    console.warn(`Semantic memory retrieval failed for project ${options.projectId}`, error);
    return [];
  }
}

type EntityState = {
  notes: string[];
  updatedAtPage: number;
};

const ENTITY_STATE_NOTE_LIMIT = 4;
const ENTITY_STATE_LINE_LIMIT = 12;

export function entityStateRecord(value: unknown): EntityState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const notes = Array.isArray(record.notes) ? record.notes.filter((note): note is string => typeof note === "string") : [];
  const updatedAtPage = typeof record.updatedAtPage === "number" ? record.updatedAtPage : 0;
  return { notes, updatedAtPage };
}

export function noteMentionsEntity(note: string, name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 1 && note.toLowerCase().includes(trimmed.toLowerCase());
}

/**
 * Folds a saved page's continuity notes into per-character/location state so
 * later pages see each entity's latest condition even outside the recency
 * window. Deterministic (no extra model call).
 */
export async function updateEntityStateFromPage(projectId: string, pageIndex: number, continuityNotes: string[]) {
  if (continuityNotes.length === 0) {
    return;
  }
  try {
    const [characters, locations] = await Promise.all([
      prisma.character.findMany({ where: { projectId } }),
      prisma.location.findMany({ where: { projectId } })
    ]);

    for (const character of characters) {
      const matches = continuityNotes.filter((note) => noteMentionsEntity(note, character.name));
      if (matches.length === 0) {
        continue;
      }
      const previous = entityStateRecord(character.state);
      const notes = [...(previous?.notes ?? []), ...matches].slice(-ENTITY_STATE_NOTE_LIMIT);
      await prisma.character.update({
        where: { id: character.id },
        data: { state: { notes, updatedAtPage: pageIndex } }
      });
    }

    for (const location of locations) {
      const matches = continuityNotes.filter((note) => noteMentionsEntity(note, location.name));
      if (matches.length === 0) {
        continue;
      }
      const previous = entityStateRecord(location.state);
      const notes = [...(previous?.notes ?? []), ...matches].slice(-ENTITY_STATE_NOTE_LIMIT);
      await prisma.location.update({
        where: { id: location.id },
        data: { state: { notes, updatedAtPage: pageIndex } }
      });
    }
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    console.warn(`Entity state update failed for project ${projectId}`, error);
  }
}

/** Formats the current character/location state for the writer context pack. */
export async function loadEntityStateLines(projectId: string, plan: BookPlan): Promise<string[]> {
  if (plan.characters.length === 0 && plan.locations.length === 0) {
    return [];
  }
  try {
    const [characters, locations] = await Promise.all([
      prisma.character.findMany({ where: { projectId } }),
      prisma.location.findMany({ where: { projectId } })
    ]);
    const lines: string[] = [];
    for (const character of characters) {
      const state = entityStateRecord(character.state);
      if (!state || state.notes.length === 0) {
        continue;
      }
      lines.push(`${character.name} (${character.role}) — as of page ${state.updatedAtPage}: ${state.notes.join(" ")}`);
    }
    for (const location of locations) {
      const state = entityStateRecord(location.state);
      if (!state || state.notes.length === 0) {
        continue;
      }
      lines.push(`${location.name} (location) — as of page ${state.updatedAtPage}: ${state.notes.join(" ")}`);
    }
    return lines.slice(0, ENTITY_STATE_LINE_LIMIT);
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    console.warn(`Entity state load failed for project ${projectId}`, error);
    return [];
  }
}

/** Embeds research sources that do not have an embedding row yet. */
export async function embedResearchSourcesForProject(projectId: string, embedding: EmbeddingAdapter) {
  const sources = await prisma.researchSource.findMany({ where: { projectId } });
  if (sources.length === 0) {
    return;
  }
  const existing = await prisma.embedding.findMany({
    where: { projectId, scope: { startsWith: "research:" } },
    select: { sourceId: true }
  });
  const embedded = new Set(existing.map((row) => row.sourceId));
  for (const source of sources) {
    if (embedded.has(source.id)) {
      continue;
    }
    await storeEmbedding(projectId, `research:${source.id}`, source.id, `${source.title}: ${source.summary}`, embedding);
  }
}

/**
 * Vector search over embedded research sources. Returns formatted notes or an
 * empty array when retrieval is unavailable.
 */
export async function retrieveSemanticResearchNotes(options: {
  projectId: string;
  queryText: string;
  embedding: EmbeddingAdapter;
  topK: number;
}): Promise<string[]> {
  const query = options.queryText.trim();
  if (!query) {
    return [];
  }
  try {
    const vector = await options.embedding.embed(query);
    const rows = await retrieveSimilarEmbeddings({
      projectId: options.projectId,
      vector,
      topK: options.topK,
      scopePrefix: "research:"
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
    if (isStopRequestedError(error)) {
      throw error;
    }
    console.warn(`Semantic research retrieval failed for project ${options.projectId}`, error);
    return [];
  }
}

export async function storeEmbedding(
  projectId: string,
  scope: string,
  sourceId: string,
  text: string,
  embedding: { embed(text: string): Promise<number[]> }
) {
  try {
    const vector = await embedding.embed(text);
    const vectorLiteral = `[${vector.map((value) => Number(value).toFixed(7)).join(",")}]`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Embedding" ("id", "projectId", "scope", "sourceId", "text", "vector", "metadata")
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb)`,
      randomUUID(),
      projectId,
      scope,
      sourceId,
      text,
      vectorLiteral,
      JSON.stringify({ provider: config.MOCK_AI ? "fake" : "gemini" })
    );
  } catch (error) {
    await prisma.embedding.create({
      data: {
        projectId,
        scope,
        sourceId,
        text,
        metadata: {
          vectorStored: false,
          error: error instanceof Error ? error.message : "Unknown embedding error"
        }
      }
    });
  }
}
