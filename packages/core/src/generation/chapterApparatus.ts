import { coupletAnchors } from "./coupletRewrite.js";
import type { ChapterEpisode, DossierExcerpt } from "../schemas/episodes.js";

/**
 * Apparatus a trade book carries that a generated one did not: an epigraph
 * at the head of a chapter, set from the chapter's own dossier so it is
 * verbatim by construction and attributed to the document it comes from. The
 * shape is the reader's first signal that the chapter is made of material;
 * it costs no model call.
 */
export const EPIGRAPH_MAX_WORDS = 60;
export const EPIGRAPH_MIN_WORDS = 12;

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?;][”"’')\]]?)\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** The excerpt's opening sentences up to the cap, whole sentences only; nothing is elided from inside. */
export function epigraphText(excerpt: string, maxWords: number = EPIGRAPH_MAX_WORDS): string | undefined {
  const sentences = sentencesOf(excerpt.replace(/\s+/g, " ").trim());
  const kept: string[] = [];
  let words = 0;
  for (const sentence of sentences) {
    const count = wordCount(sentence);
    if (words + count > maxWords) break;
    kept.push(sentence);
    words += count;
  }
  if (words < EPIGRAPH_MIN_WORDS) return undefined;
  return kept.join(" ");
}

export function epigraphAttribution(excerpt: Pick<DossierExcerpt, "speaker" | "author" | "documentTitle" | "year">): string {
  const who = excerpt.speaker.trim() || excerpt.author.trim();
  const title = excerpt.documentTitle.trim().replace(/\*/g, "");
  const year = excerpt.year.trim();
  return [who, title ? `*${title}*` : "", year ? `(${year})` : ""].filter(Boolean).join(", ").replace(/, \(/, " (");
}

/** The names, places and documents a chapter's episodes are made of: what an epigraph has to be about. */
export function episodeAnchors(episodes: readonly ChapterEpisode[]): string[] {
  const found = new Set<string>();
  for (const episode of episodes) {
    for (const field of [episode.title, episode.person, episode.place, episode.document]) {
      for (const anchor of coupletAnchors(field)) found.add(anchor);
    }
  }
  return [...found];
}

/**
 * The chapter's epigraph as a Markdown block quote, from the excerpt that
 * reads best as one: the shortest that still has a speaker or an author,
 * else the shortest. Undefined when no excerpt gives twelve whole-sentence
 * words under the cap.
 *
 * Two epigraphs of `legacy-cuts-7b` were wrong in ways the ranking cannot see:
 * one reprinted a sentence the chapter body already quoted verbatim, and one
 * was an OCR fragment about Portland clergymen in a chapter about neither. So
 * an excerpt already in `body` is skipped, and — when the caller can say what
 * the chapter is about — so is one sharing no anchor with its episodes. Both
 * only ever move the choice down the ranking; a chapter with no eligible
 * excerpt simply prints no epigraph, as it always could.
 */
export function chapterEpigraph(
  excerpts: readonly DossierExcerpt[],
  options: { body?: string | undefined; anchors?: readonly string[] | undefined } = {}
): string | undefined {
  const ranked = [...excerpts].sort((a, b) => {
    const aNamed = a.speaker || a.author ? 0 : 1;
    const bNamed = b.speaker || b.author ? 0 : 1;
    return aNamed - bNamed || a.words - b.words;
  });
  const body = options.body ? options.body.replace(/\s+/g, " ") : undefined;
  const wanted = options.anchors && options.anchors.length > 0 ? new Set(options.anchors) : undefined;
  for (const excerpt of ranked) {
    const text = epigraphText(excerpt.text);
    if (!text) continue;
    if (body && body.includes(text.replace(/\s+/g, " "))) continue;
    if (wanted && ![...coupletAnchors(text)].some((anchor) => wanted.has(anchor))) continue;
    const quoted = /^[“"]/.test(text) ? text : `“${text.replace(/[”"]+$/, "")}”`;
    return `> ${quoted}\n>\n> — ${epigraphAttribution(excerpt)}`;
  }
  return undefined;
}

/** The epigraph set ahead of the chapter's prose. */
export function withEpigraph(markdown: string, epigraph: string | undefined): string {
  return epigraph ? `${epigraph}\n\n${markdown}` : markdown;
}
