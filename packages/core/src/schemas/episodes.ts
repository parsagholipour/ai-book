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

/** A reviewer that cannot supply a field answers null; that is an empty field, not a schema failure worth a paid retry. */
const trimmed = z.preprocess((value) => (value == null ? "" : typeof value === "string" ? value.trim() : value), z.string());

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

/**
 * A chapter's explanatory assignment: the question it investigates with its
 * assigned material, what it works out in full, the distinction the reader can
 * make afterward, and what earlier chapters settled. Planning questions, not
 * verified factual claims.
 */
export const chapterFocusSchema = z.object({
  question: z.string().min(1),
  investigation: z.array(z.string().min(1)).min(2).max(5),
  /** Empty is "no assigned payoff": the plan contract blanks a contribution that was a distinction between two readings. */
  contribution: z.string().default(""),
  alreadyEstablished: z.array(z.string()).max(6).default([])
});
export type ChapterFocus = z.infer<typeof chapterFocusSchema>;

export const bookEpisodesSchema = z.object({
  chapters: z
    .array(
      z.object({
        index: z.number().int().positive(),
        episodes: z.array(chapterEpisodeSchema).default([]),
        /** Absent on episodes planned before focus existed and on narrative books. */
        focus: chapterFocusSchema.optional()
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

export const evidenceClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1),
  kind: z.enum(["fact", "event", "interpretation"]),
  excerptIds: z.array(z.string().min(1)).min(1)
});

/** Claims reviewed against retrieved passages; this does not assert that a source is infallible. */
export const caseEvidencePacketSchema = z.object({
  id: z.string().min(1),
  sourceChapterIndex: z.number().int().positive(),
  episode: chapterEpisodeSchema,
  claims: z.array(evidenceClaimSchema).min(2).max(16),
  /** Version 1 stored a model-ordered chain of claim IDs; version 2 always stores [] and states order inside claims. */
  sequence: z.array(z.string()),
  disagreements: z.array(z.string()),
  unknowns: z.array(z.string()),
  excerpts: z.array(dossierExcerptSchema).min(1),
  /** 1: a model-ordered `sequence` was accepted. 2: chronology lives inside individually supported claims. */
  reviewVersion: z.union([z.literal(1), z.literal(2)])
});
export type CaseEvidencePacket = z.infer<typeof caseEvidencePacketSchema>;

export const bookDossierSchema = z.object({
  excerpts: z.array(dossierExcerptSchema).default([]),
  evidencePackets: z.array(caseEvidencePacketSchema).optional(),
  excludedCases: z.array(z.object({ chapterIndex: z.number().int().positive(), title: z.string(), reason: z.string() })).optional(),
  /** Missing material is input to replanning; the old outline does not dictate case ownership. */
  researchGaps: z.array(z.object({ chapterIndex: z.number().int().positive(), reason: z.string().min(1) })).optional(),
  /** Documents searched and fetched, for the Sources list and the trace. */
  documents: z
    .array(z.object({ title: z.string(), url: z.string().default(""), host: z.string().default(""), chapterIndex: z.number().int().positive(), words: z.number().int().nonnegative().default(0) }))
    .default([])
});
export type BookDossier = z.infer<typeof bookDossierSchema>;
