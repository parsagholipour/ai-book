export type ResearchSourceForGeneration = {
  title: string;
  summary: string;
  url: string | null;
};

export function urlBackedResearchSources<T extends ResearchSourceForGeneration>(
  sources: readonly T[]
): T[] {
  return sources.filter((source) => Boolean(source.url?.trim()));
}

/** The reader-facing source boundary shared by page generation and export QA. */
export function urlBackedResearchNotes(
  sources: readonly ResearchSourceForGeneration[]
): string[] {
  return urlBackedResearchSources(sources).map((source) => `${source.title}: ${source.summary}`);
}

/**
 * Semantic rows carry formatted text but not source metadata. Admit one only
 * when it exactly matches a note already proven to have a non-blank URL.
 */
export function validateSemanticResearchNotes(
  retrieved: readonly string[],
  urlBackedNotes: readonly string[]
): string[] {
  const allowed = new Set(urlBackedNotes);
  return retrieved.filter((note) => allowed.has(note));
}
