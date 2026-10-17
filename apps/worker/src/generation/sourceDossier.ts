import { createHash } from "node:crypto";
import { buildChapterDossier, type BookDossier, type ChapterEpisode } from "@book-maker/core";
import { fetchSourceDocument } from "./sourceDocumentFetch.js";
import type { RunLogger } from "../providers/runLogging.js";
import { createDossierRunTrace } from "./dossierRunTrace.js";

/** Preserve exact passages across retrieval rounds without colliding with old positional IDs. */
export function mergeSourceDossiers(...dossiers: readonly BookDossier[]): BookDossier {
  const excerpts = new Map<string, BookDossier["excerpts"][number]>();
  const documents = new Map<string, BookDossier["documents"][number]>();
  for (const dossier of dossiers) {
    for (const excerpt of dossier.excerpts) {
      const key = `${excerpt.chapterIndex}\n${excerpt.documentUrl}\n${excerpt.text}`;
      if (!excerpts.has(key)) excerpts.set(key, excerpt);
    }
    for (const document of dossier.documents) documents.set(`${document.chapterIndex}\n${document.url}`, document);
  }
  return { excerpts: [...excerpts.values()], documents: [...documents.values()] };
}

/** One bounded fallback query round. Every search/drop decision reaches the immutable run trace. */
export async function retrieveChapterSources(options: Omit<Parameters<typeof buildChapterDossier>[0], "fetch" | "log"> & {
  projectId: string;
  runLog?: Pick<RunLogger, "append"> | undefined;
  fetch?: Parameters<typeof buildChapterDossier>[0]["fetch"] | undefined;
  /** Claim recovery owns coverage-driven rounds; ordinary dossiers retain their fallback round. */
  maxRounds?: 1 | 2 | undefined;
  /**
   * The web discovery told which lead each query was searched for, in place of `searchSources`, so the
   * search's answer can be kept as that lead's research note (`createLeadResearch`, core `leadResearch.ts`).
   */
  leadSearch?: ((query: string, lead: string | undefined) => Promise<Array<{ title: string; url: string }>>) | undefined;
}): Promise<BookDossier> {
  const trace = createDossierRunTrace(options.runLog, {
    projectId: options.projectId, chapterIndex: options.chapter.index, retrievalStage: "chapter_sources"
  });
  const found: BookDossier[] = [];
  try {
    for (let round = 0; round < (options.maxRounds ?? 2); round += 1) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) break;
      const episodes: ChapterEpisode[] = options.episodes.map((episode) => ({ ...episode,
        searchQueries: [episode.searchQueries[round] || `${episode.title} ${options.chapter.title} original source documentation`]
      }));
      const { leadSearch } = options;
      // A round searches each lead by its own query (`buildChapterDossier`), so the query names the lead.
      const searchSources = leadSearch
        ? (query: string) => leadSearch(query, episodes.find((episode) => episode.searchQueries[0] === query)?.title)
        : options.searchSources;
      const result = await buildChapterDossier({ ...options, episodes, searchSources, queryOffset: 0,
        fetch: options.fetch ?? fetchSourceDocument,
        log: (event, detail) => trace.log(event, { ...detail, round: round + 1 }) });
      found.push({ ...result, excerpts: result.excerpts.map((excerpt) => ({ ...excerpt,
        id: `ch${excerpt.chapterIndex}-s${createHash("sha256").update(`${excerpt.documentUrl}\n${excerpt.text}`).digest("hex").slice(0, 16)}`
      })) });
      if (result.excerpts.length) break;
    }
    const result = mergeSourceDossiers(...found);
    trace.log("dossier.coverage", { rounds: found.length,
      documents: result.documents.length, excerpts: result.excerpts.length,
      status: result.excerpts.length ? "passages_retrieved" : "no_supporting_passages" });
    return result;
  } finally {
    await trace.flush();
  }
}
