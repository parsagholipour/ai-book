import { type ChapterSetup } from "../runtime/jobTypes.js";
import { retrieveSemanticResearchNotes } from "./semanticMemory.js";
import { type BookGenerationStrategy, type ChapterPlan, type EmbeddingAdapter } from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * Assembles the continuity and research context handed to the model for a page.
 */

export async function loadContinuityNotes(projectId: string): Promise<string[]> {
  const continuity = await prisma.continuityNote.findMany({
    where: {
      projectId,
      // Page-scoped rows that remain unowned cannot safely be matched back
      // from `page:<index>`: an older structural edit may already have
      // reused that index. Keep genuinely project-scoped legacy notes, but do
      // not let ambiguous deleted-page prose enter a generation prompt.
      NOT: { pageId: null, scope: { startsWith: "page:" } }
    },
    orderBy: { createdAt: "desc" },
    take: 28
  });
  return continuity.map((note) => note.body);
}

export async function loadResearchNotesForGeneration(
  projectId: string,
  strategy: BookGenerationStrategy,
  chapter?: ChapterPlan | undefined,
  semantic?: { embedding: EmbeddingAdapter; queryText: string; vector?: number[] | undefined } | undefined
): Promise<string[]> {
  const take = strategy.researchDepth ? strategy.researchDepth + 12 : 12;

  if (semantic) {
    const retrieved = await retrieveSemanticResearchNotes({
      projectId,
      queryText: semantic.queryText,
      embedding: semantic.embedding,
      topK: take,
      ...(semantic.vector ? { vector: semantic.vector } : {})
    });
    if (retrieved.length > 0) {
      return retrieved;
    }
  }

  const sources = await prisma.researchSource.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take
  });
  const notes = sources.map((source) => `${source.title}: ${source.summary}`);
  if (!strategy.researchDepth || !chapter) {
    return notes;
  }

  const chapterTerms = searchableTerms(`${chapter.title} ${chapter.summary} ${chapter.keyBeats.join(" ")}`);
  const matching = sources
    .filter((source) => hasSharedSearchTerm(chapterTerms, `${source.query} ${source.title} ${source.summary}`))
    .map((source) => `${source.title}: ${source.summary}`);
  const general = notes.filter((note) => !matching.includes(note)).slice(0, 4);
  return [...matching, ...general].slice(0, strategy.researchDepth + 4);
}

export function chapterSetupForPage(chapterSetups: ChapterSetup[], pageIndex: number): ChapterSetup | undefined {
  return chapterSetups.find((setup) => pageIndex >= setup.startPage && pageIndex <= setup.endPage);
}

export function searchableTerms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((term) => term.length > 4)
  );
}

export function hasSharedSearchTerm(terms: Set<string>, value: string): boolean {
  const target = searchableTerms(value);
  for (const term of terms) {
    if (target.has(term)) {
      return true;
    }
  }
  return false;
}
