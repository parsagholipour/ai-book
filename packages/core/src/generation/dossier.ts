import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import type { ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import type { ChapterEpisode, DossierExcerpt } from "../schemas/episodes.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { fetchPrimaryText, searchPrimarySources, textLooksLikeLanguage, type PrimarySourceCandidate, type PrimarySourceFetch } from "./primarySources.js";
import { foldQuoteText } from "./quoteProvenance.js";

/**
 * Material-first, step two: the dossier. For each episode the chapter's
 * search queries are run against the public repositories, the documents
 * fetched, the passages most likely to concern the episode found by term
 * hits (`candidateWindows`), and one mechanical call asked which passage in
 * each window to keep — answered as anchors (the first and last few words),
 * never as text. The code slices the document between the anchors
 * (`sliceByAnchors`), so an excerpt is verbatim by construction; a model that
 * misquotes its anchors gets no excerpt rather than a wrong one.
 */
export const EXTRACT_EXCERPTS_PURPOSE = "extract-excerpts";

export const DOSSIER_WINDOW_WORDS = 900;
export const DOSSIER_MAX_WINDOWS_PER_CHAPTER = 8;
export const DOSSIER_MAX_DOCUMENTS_PER_CHAPTER = 5;
export const DOSSIER_MAX_EXCERPTS_PER_CHAPTER = 6;
export const EXCERPT_MIN_WORDS = 30;
export const EXCERPT_MAX_WORDS = 400;

export type DossierDocument = {
  id: string;
  title: string;
  url: string;
  host: string;
  author: string;
  year: string;
  text: string;
  episodeTitle: string;
};

export type DossierWindow = { id: string; documentId: string; episodeTitle: string; text: string; /** Distinct episode terms the window hits. */ score: number };

type Token = { start: number; end: number; folded: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const folded = foldQuoteText(match[0]);
    tokens.push({ start: match.index!, end: match.index! + match[0].length, folded });
  }
  return tokens;
}

function episodeTerms(episode: ChapterEpisode): string[] {
  const words = foldQuoteText([episode.person, episode.place, episode.document, episode.title].join(" ")).split(" ");
  return [...new Set(words.filter((word) => word.length >= 4))];
}

/** Words that name a kind of document or place rather than this one: "Secret History of the Court of Justinian" shares two of them with the Mongols'. */
const GENERIC_TERMS = new Set([
  "history", "histories", "secret", "chronicle", "chronicles", "account", "accounts", "letters", "letter", "book", "books", "records", "record",
  "report", "reports", "documents", "document", "papers", "memoir", "memoirs", "journal", "journals", "diary", "text", "texts", "story",
  "annals", "register", "registers", "minutes", "protocol", "speech", "speeches", "treaty", "statute", "statutes", "charter", "king", "queen",
  "emperor", "prince", "lord", "river", "city", "town", "battle", "siege", "council", "court", "house", "state", "empire", "world", "great",
  "general", "complete", "collection", "works", "volume", "early", "later", "ancient", "modern", "north", "south", "east", "west", "conference",
  "commission", "government", "official", "translation", "edition", "selected", "essays", "essay", "narrative", "description"
]);

/** The episode's own names — person, place, document — with the generic words out. */
export function episodeNameTerms(episode: ChapterEpisode): string[] {
  const words = foldQuoteText([episode.person, episode.place, episode.document].join(" ")).split(" ");
  return [...new Set(words.filter((word) => word.length >= 4 && !GENERIC_TERMS.has(word)))];
}

/**
 * Whether a fetched document is about the episode: its title carries one of
 * the episode's names, or one of its best windows does. An episode with no
 * names of its own (a document titled only in generic words) falls back to
 * two distinct term hits in a window.
 */
export function documentIsRelevant(document: Pick<DossierDocument, "title">, episode: ChapterEpisode, windows: readonly DossierWindow[]): boolean {
  const names = episodeNameTerms(episode);
  if (names.length === 0) {
    return windows.some((window) => window.score >= 2);
  }
  const title = ` ${foldQuoteText(document.title)} `;
  if (names.some((name) => title.includes(` ${name} `))) return true;
  return windows.some((window) => {
    const folded = ` ${foldQuoteText(window.text)} `;
    return names.some((name) => folded.includes(` ${name} `));
  });
}

/**
 * Up to `maxWindows` stretches of about `windowWords` words, ranked by how
 * many distinct episode terms they hit, non-overlapping; with no hit at all,
 * the document's opening.
 */
export function candidateWindows(
  document: DossierDocument,
  terms: readonly string[],
  options: { windowWords?: number | undefined; maxWindows?: number | undefined } = {}
): DossierWindow[] {
  const windowWords = options.windowWords ?? DOSSIER_WINDOW_WORDS;
  const maxWindows = options.maxWindows ?? 3;
  const tokens = tokenize(document.text);
  if (tokens.length === 0) return [];
  const termSet = new Set(terms);
  const step = Math.max(50, Math.floor(windowWords / 3));
  const scored: Array<{ at: number; score: number }> = [];
  for (let at = 0; at < tokens.length; at += step) {
    const hits = new Set<string>();
    for (let index = at; index < Math.min(tokens.length, at + windowWords); index += 1) {
      const folded = tokens[index]!.folded;
      if (termSet.has(folded)) hits.add(folded);
    }
    scored.push({ at, score: hits.size });
    if (at + windowWords >= tokens.length) break;
  }
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  const chosen: number[] = [];
  for (const entry of scored) {
    if (entry.score === 0 && chosen.length > 0) break;
    if (chosen.some((at) => Math.abs(at - entry.at) < windowWords)) continue;
    chosen.push(entry.at);
    if (chosen.length >= maxWindows) break;
  }
  const scoreAt = new Map(scored.map((entry) => [entry.at, entry.score]));
  return chosen
    .sort((a, b) => a - b)
    .map((at, offset) => {
      const first = tokens[at]!;
      const last = tokens[Math.min(tokens.length, at + windowWords) - 1]!;
      return {
        id: `${document.id}-w${offset + 1}`,
        documentId: document.id,
        episodeTitle: document.episodeTitle,
        text: document.text.slice(first.start, last.end),
        score: scoreAt.get(at) ?? 0
      };
    });
}

function findSequence(tokens: readonly Token[], anchor: readonly string[], from: number): number {
  if (anchor.length === 0) return -1;
  for (let at = from; at + anchor.length <= tokens.length; at += 1) {
    let matched = true;
    for (let offset = 0; offset < anchor.length; offset += 1) {
      if (tokens[at + offset]!.folded !== anchor[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return at;
  }
  return -1;
}

/**
 * The window's own text between two anchors: the first words and the last
 * words of the passage as the model reported them, matched token by token
 * after folding. Undefined when either anchor is not in the window, when the
 * span is outside 30–320 words, or when the last anchor comes first.
 */
export function sliceByAnchors(windowText: string, firstWords: string, lastWords: string): string | undefined {
  const tokens = tokenize(windowText);
  const firstAll = foldQuoteText(firstWords).split(" ").filter(Boolean);
  const lastAll = foldQuoteText(lastWords).split(" ").filter(Boolean);
  // A model copies eight words less exactly than four: the longest anchor
  // that matches wins, down to four words.
  for (const length of [8, 6, 4]) {
    const first = firstAll.slice(0, length);
    const last = lastAll.slice(-length);
    if (first.length < 3 || last.length < 3) return undefined;
    const startAt = findSequence(tokens, first, 0);
    if (startAt < 0) continue;
    const endAt = findSequence(tokens, last, startAt);
    if (endAt < 0) continue;
    const endToken = tokens[endAt + last.length - 1]!;
    const words = endAt + last.length - startAt;
    if (words < EXCERPT_MIN_WORDS || words > EXCERPT_MAX_WORDS) return undefined;
    return windowText.slice(tokens[startAt]!.start, endToken.end).replace(/\s+/g, " ").trim();
  }
  return undefined;
}

const extractionSchema = z.object({
  excerpts: z
    .array(
      z.object({
        windowId: z.string(),
        firstWords: z.string(),
        lastWords: z.string(),
        speaker: z.string().default(""),
        episodeTitle: z.string().default(""),
        note: z.string().default("")
      })
    )
    .default([])
});

export async function extractExcerpts(options: {
  input: CreateProjectInput;
  chapter: ChapterPlan;
  episodes: readonly ChapterEpisode[];
  windows: readonly DossierWindow[];
  documents: readonly DossierDocument[];
  textModel: TextModelAdapter;
  log?: ((event: string, detail: Record<string, unknown>) => void) | undefined;
}): Promise<DossierExcerpt[]> {
  if (options.windows.length === 0) return [];
  const log = options.log ?? (() => undefined);
  const byId = new Map(options.windows.map((window) => [window.id, window]));
  const documents = new Map(options.documents.map((document) => [document.id, document]));
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: EXTRACT_EXCERPTS_PURPOSE,
    temperature: 0.1,
    maxTokens: 4000,
    schema: extractionSchema,
    messages: [
      {
        role: "system",
        content: [
          `You are choosing passages from primary sources for chapter ${options.chapter.index}, "${options.chapter.title}". Each window in windows is a stretch of a document's own text.`,
          "Choose up to six passages of 30 to 300 words that bear on one of the chapter's episodes and would be worth quoting: a voice, an order, an oath, a figure, a description of something seen. A passage is one continuous stretch of a window. Skip a window that has nothing quotable.",
          "Report each passage as its first six to eight words and its last six to eight words, copied exactly from the window — never paraphrased, never the whole passage. speaker: who wrote or said it, if the window says. episodeTitle: which episode it serves.",
          "Return one JSON object shaped exactly like outputContract.",
          ...targetLanguageGenerationGuidance(options.input.language)
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            language: targetLanguagePayload(options.input.language),
            episodes: options.episodes.map((episode) => ({ title: episode.title, person: episode.person, place: episode.place, date: episode.date, document: episode.document })),
            windows: options.windows.map((window) => ({
              id: window.id,
              document: documents.get(window.documentId)?.title ?? "",
              text: window.text
            })),
            outputContract: { excerpts: [{ windowId: "", firstWords: "", lastWords: "", speaker: "", episodeTitle: "", note: "" }] }
          },
          null,
          2
        )
      }
    ]
  });
  const excerpts: DossierExcerpt[] = [];
  const seen = new Set<string>();
  log("dossier.extracted", { chapterIndex: options.chapter.index, returned: result.data.excerpts.length, windows: options.windows.length });
  for (const entry of result.data.excerpts) {
    const window = byId.get(entry.windowId.trim());
    if (!window) {
      log("dossier.excerpt_rejected", { chapterIndex: options.chapter.index, reason: "unknown window", windowId: entry.windowId });
      continue;
    }
    const text = sliceByAnchors(window.text, entry.firstWords, entry.lastWords);
    if (!text) {
      log("dossier.excerpt_rejected", { chapterIndex: options.chapter.index, reason: "anchors not found", windowId: entry.windowId, firstWords: entry.firstWords.slice(0, 60), lastWords: entry.lastWords.slice(0, 60) });
      continue;
    }
    const key = foldQuoteText(text).slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    const document = documents.get(window.documentId);
    if (!document) continue;
    excerpts.push({
      id: `ch${options.chapter.index}-x${excerpts.length + 1}`,
      chapterIndex: options.chapter.index,
      episodeTitle: entry.episodeTitle.trim() || window.episodeTitle,
      documentTitle: document.title,
      documentUrl: document.url,
      host: document.host,
      author: document.author,
      year: document.year,
      speaker: entry.speaker.trim(),
      text,
      words: text.split(/\s+/).filter(Boolean).length
    });
    if (excerpts.length >= DOSSIER_MAX_EXCERPTS_PER_CHAPTER) break;
  }
  return excerpts;
}

export type ChapterDossier = {
  excerpts: DossierExcerpt[];
  documents: Array<{ title: string; url: string; host: string; chapterIndex: number; words: number }>;
};

/**
 * The whole step for one chapter: search, fetch, window, extract. Every
 * failure short of a stop degrades to fewer documents — a chapter with no
 * dossier is composed as before, never a failed book.
 */
export async function buildChapterDossier(options: {
  input: CreateProjectInput;
  chapter: ChapterPlan;
  episodes: readonly ChapterEpisode[];
  textModel: TextModelAdapter;
  fetch: PrimarySourceFetch;
  log?: ((event: string, detail: Record<string, unknown>) => void) | undefined;
  /** Epoch ms after which no further search or fetch starts: the dossier is a bounded step, never the book's clock. */
  deadline?: number | undefined;
}): Promise<ChapterDossier> {
  const documents: DossierDocument[] = [];
  const seenUrls = new Set<string>();
  const log = options.log ?? (() => undefined);
  const pastDeadline = () => options.deadline !== undefined && Date.now() > options.deadline;
  for (const episode of options.episodes.slice(0, 3)) {
    if (pastDeadline()) {
      log("dossier.deadline", { chapterIndex: options.chapter.index, stage: "search", documents: documents.length });
      break;
    }
    // One search per episode: Wikimedia answers about thirty requests a
    // minute, and a book's dossier has to fit in its budget.
    const queries = episode.searchQueries.filter(Boolean).slice(0, 1);
    if (queries.length === 0 && episode.document) queries.push(`${episode.document} ${episode.person}`.trim());
    const candidates: PrimarySourceCandidate[] = [];
    for (const query of queries) {
      try {
        candidates.push(...(await searchPrimarySources(query, { fetch: options.fetch, language: options.input.language, limit: 2 })));
      } catch (error) {
        log("dossier.search_failed", { query, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const candidate of candidates) {
      if (documents.length >= DOSSIER_MAX_DOCUMENTS_PER_CHAPTER) break;
      if (pastDeadline()) {
        log("dossier.deadline", { chapterIndex: options.chapter.index, stage: "fetch", documents: documents.length });
        break;
      }
      if (seenUrls.has(candidate.textUrl)) continue;
      seenUrls.add(candidate.textUrl);
      try {
        const text = await fetchPrimaryText(candidate, options.fetch);
        if (text.split(/\s+/).length < 80) continue;
        if (!textLooksLikeLanguage(text, options.input.language)) {
          log("dossier.document_dropped", { chapterIndex: options.chapter.index, title: candidate.title, reason: "not the book's language" });
          continue;
        }
        documents.push({
          id: `ch${options.chapter.index}-d${documents.length + 1}`,
          title: candidate.title,
          url: candidate.url,
          host: candidate.host,
          author: candidate.author,
          year: candidate.year,
          text,
          episodeTitle: episode.title
        });
      } catch (error) {
        log("dossier.fetch_failed", { url: candidate.textUrl, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  // A repository search answers a query about a 1968 excavation report with
  // whatever old book shares a word, and an extractor asked for "something
  // quotable" would find it. A document stays only when it is about the
  // episode: its title shares a term with the episode's document, person or
  // place, or its best window hits two distinct episode terms.
  const windows: DossierWindow[] = [];
  for (const document of documents) {
    const episode = options.episodes.find((entry) => entry.title === document.episodeTitle);
    const terms = episode ? episodeTerms(episode) : [];
    const candidates = candidateWindows(document, terms, { maxWindows: 2 });
    if (!episode || !documentIsRelevant(document, episode, candidates)) {
      log("dossier.document_dropped", { chapterIndex: options.chapter.index, title: document.title, episode: document.episodeTitle });
      continue;
    }
    windows.push(...candidates);
  }
  const kept = windows.slice(0, DOSSIER_MAX_WINDOWS_PER_CHAPTER);
  let excerpts: DossierExcerpt[] = [];
  if (kept.length > 0) {
    try {
      excerpts = await extractExcerpts({ input: options.input, chapter: options.chapter, episodes: options.episodes, windows: kept, documents, textModel: options.textModel, log });
    } catch (error) {
      if (error instanceof Error && /stop|abort/i.test(error.name + error.message)) throw error;
      log("dossier.extract_failed", { chapterIndex: options.chapter.index, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    excerpts,
    documents: documents.map((document) => ({
      title: document.title,
      url: document.url,
      host: document.host,
      chapterIndex: options.chapter.index,
      words: document.text.split(/\s+/).length
    }))
  };
}
