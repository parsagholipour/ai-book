import { z } from "zod";

/**
 * Material-first (opinion-fable-5, 2026-09-03): a book is planned as episodes
 * before it is planned as an argument. An episode is a person, a place, a date
 * and a document from the record, with the queries that find primary text for
 * it; a dossier is the verbatim text those queries found, sliced by the code
 * from a fetched document so that "verbatim" is a property of the slice and
 * never of a model's transcription.
 */

export const EPISODE_KINDS = ["scene", "document", "figure", "dispute", "portrait"] as const;
export type EpisodeKind = (typeof EPISODE_KINDS)[number];

const trimmed = z.preprocess((value) => (typeof value === "string" ? value.trim() : value), z.string());

export const chapterEpisodeSchema = z.object({
  title: trimmed.pipe(z.string().min(1)),
  kind: z.preprocess(
    (value) => (typeof value === "string" && (EPISODE_KINDS as readonly string[]).includes(value.trim().toLowerCase()) ? value.trim().toLowerCase() : "scene"),
    z.enum(EPISODE_KINDS)
  ),
  person: trimmed.default(""),
  place: trimmed.default(""),
  date: trimmed.default(""),
  /** The document or artefact that records it: a letter, a roll, a statute, a chronicle, a register. */
  document: trimmed.default(""),
  why: trimmed.default(""),
  /** Two or three searches that would find the document's own text in a public repository. */
  searchQueries: z.array(trimmed).default([])
});
export type ChapterEpisode = z.infer<typeof chapterEpisodeSchema>;

export const bookEpisodesSchema = z.object({
  chapters: z
    .array(
      z.object({
        index: z.number().int().positive(),
        episodes: z.array(chapterEpisodeSchema).default([])
      })
    )
    .min(1)
});
export type BookEpisodes = z.infer<typeof bookEpisodesSchema>;

export const dossierExcerptSchema = z.object({
  id: z.string().min(1),
  chapterIndex: z.number().int().positive(),
  episodeTitle: z.string().default(""),
  documentTitle: z.string().min(1),
  documentUrl: z.string().default(""),
  host: z.string().default(""),
  author: z.string().default(""),
  year: z.string().default(""),
  speaker: z.string().default(""),
  /** Verbatim: sliced by the code from the fetched document. */
  text: z.string().min(1),
  words: z.number().int().nonnegative().default(0)
});
export type DossierExcerpt = z.infer<typeof dossierExcerptSchema>;

export const bookDossierSchema = z.object({
  excerpts: z.array(dossierExcerptSchema).default([]),
  /** Documents searched and fetched, for the Sources list and the trace. */
  documents: z
    .array(z.object({ title: z.string(), url: z.string().default(""), host: z.string().default(""), chapterIndex: z.number().int().positive(), words: z.number().int().nonnegative().default(0) }))
    .default([])
});
export type BookDossier = z.infer<typeof bookDossierSchema>;
