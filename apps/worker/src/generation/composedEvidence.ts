import {
  buildCaseEvidence, buildChapterDossier, caseEvidenceIssues, episodesForChapter, mapWithConcurrency, planEpisodes,
  type AuthorStance, type BookDossier, type BookEpisodes, type BookPlan, type CaseEvidencePacket,
  type ChapterEpisode, type ChapterPlan, type CreateProjectInput, type TextModelAdapter, type PrimarySourceSearch
} from "@book-maker/core";
import { primarySourceFetch } from "./composedChaptersMaterial.js";

/** At most one new retrieval and one replacement-case search per missing chapter. */
export async function prepareVerifiedCases(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  stance: AuthorStance;
  episodes: BookEpisodes | undefined;
  dossier: BookDossier | undefined;
  textModel: TextModelAdapter;
  searchSources?: PrimarySourceSearch | undefined;
  /** Fixed chapters need their own cases; a developing book can merge coverage and reuse evidence in synthesis. */
  coverage?: "chapter" | "book";
}): Promise<{ episodes: BookEpisodes; dossier: BookDossier }> {
  const dossier: BookDossier = { excerpts: [...options.dossier?.excerpts ?? []], documents: [...options.dossier?.documents ?? []] };
  const deadline = Date.now() + 10 * 60 * 1000;
  const chapters = await mapWithConcurrency(options.plan.chapters, 2, async (chapter) => {
    const excluded: NonNullable<BookDossier["excludedCases"]> = [];
    const packets: CaseEvidencePacket[] = [];
    const attempt = async (episode: ChapterEpisode, slot: number, excerpts: BookDossier["excerpts"]) => {
      const id = `case-${chapter.index}-${slot}`;
      const result = await buildCaseEvidence({ id, chapterIndex: chapter.index, episode, excerpts, textModel: options.textModel });
      if (result.packet && caseEvidenceIssues(result.packet).length === 0) packets.push(result.packet);
      else excluded.push({ chapterIndex: chapter.index, title: episode.title, reason: result.failure ?? "invalid evidence packet" });
    };
    const episodes = episodesForChapter(options.episodes, chapter.index).slice(0, 3);
    for (const [index, episode] of episodes.entries()) {
      await attempt(episode, index + 1, dossier.excerpts.filter((excerpt) => excerpt.chapterIndex === chapter.index));
    }
    if (packets.length === 0 && Date.now() < deadline) {
      const retrieved = await buildChapterDossier({
        input: options.input, chapter, episodes, textModel: options.textModel, fetch: primarySourceFetch,
        evidence: true, queryOffset: 1, deadline, searchSources: options.searchSources
      });
      for (const [index, episode] of episodes.entries()) await attempt(episode, index + 1, retrieved.excerpts);
    }
    if (packets.length === 0 && Date.now() < deadline) {
      const alternative = await planEpisodes({
        input: options.input, plan: { ...options.plan, chapters: [chapter] }, stance: options.stance,
        textModel: options.textModel, evidenceRequired: true,
        feedback: excluded.map((entry) => `${entry.title}: ${entry.reason}`)
      });
      const replacements = episodesForChapter(alternative.episodes, chapter.index).slice(0, 2);
      if (replacements.length) {
        const retrieved = await retrieve(chapter, replacements);
        for (const [index, episode] of replacements.entries()) await attempt(episode, index + 4, retrieved.excerpts);
      }
    }
    return { index: chapter.index, packets, excluded };
  });
  const missing = chapters.filter((chapter) => chapter.packets.length === 0);
  if (missing.length && options.coverage !== "book") {
    throw new Error(`Source evidence is insufficient for chapters ${missing.map((chapter) => chapter.index).join(", ")} after bounded research and case replacement. ${missing.flatMap((chapter) => chapter.excluded.slice(-1).map((entry) => `${entry.title}: ${entry.reason}`)).join("; ")}`);
  }
  const evidencePackets = chapters.flatMap((chapter) => chapter.packets);
  return {
    episodes: { chapters: chapters.map((chapter) => ({ index: chapter.index, episodes: chapter.packets.map((packet) => packet.episode) })) },
    dossier: {
      evidencePackets, excludedCases: chapters.flatMap((chapter) => chapter.excluded),
      researchGaps: missing.map((chapter) => ({ chapterIndex: chapter.index, reason: `No verified case after bounded research. ${chapter.excluded.map((entry) => `${entry.title}: ${entry.reason}`).join("; ")}`.trim() })),
      excerpts: evidencePackets.flatMap((packet) => packet.excerpts),
      documents: evidencePackets.flatMap((packet) => packet.excerpts.map((excerpt) => ({
        title: excerpt.documentTitle, url: excerpt.documentUrl, host: excerpt.host, chapterIndex: packet.sourceChapterIndex, words: excerpt.words
      })))
    }
  };

  function retrieve(chapter: ChapterPlan, episodes: ChapterEpisode[]) {
    return buildChapterDossier({ input: options.input, chapter, episodes, textModel: options.textModel, fetch: primarySourceFetch, evidence: true, deadline, searchSources: options.searchSources });
  }
}
