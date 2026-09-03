import type { DossierExcerpt } from "../schemas/episodes.js";

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

/**
 * The chapter's epigraph as a Markdown block quote, from the excerpt that
 * reads best as one: the shortest that still has a speaker or an author,
 * else the shortest. Undefined when no excerpt gives twelve whole-sentence
 * words under the cap.
 */
export function chapterEpigraph(excerpts: readonly DossierExcerpt[]): string | undefined {
  const ranked = [...excerpts].sort((a, b) => {
    const aNamed = a.speaker || a.author ? 0 : 1;
    const bNamed = b.speaker || b.author ? 0 : 1;
    return aNamed - bNamed || a.words - b.words;
  });
  for (const excerpt of ranked) {
    const text = epigraphText(excerpt.text);
    if (!text) continue;
    const quoted = /^[“"]/.test(text) ? text : `“${text.replace(/[”"]+$/, "")}”`;
    return `> ${quoted}\n>\n> — ${epigraphAttribution(excerpt)}`;
  }
  return undefined;
}

/** The epigraph set ahead of the chapter's prose. */
export function withEpigraph(markdown: string, epigraph: string | undefined): string {
  return epigraph ? `${epigraph}\n\n${markdown}` : markdown;
}
