import type { ManuscriptIntegrityPage } from "./manuscriptQualityIssue.js";
import { WORD_TOKEN_PATTERN, type PageTokens } from "./manuscriptPageCache.js";

export type ParagraphRole = "opening" | "middle" | "closing";

export type SetOverlap = {
  intersection: number;
  union: number;
  jaccard: number;
  containment: number;
};

export type CachedManuscriptPage = {
  page: ManuscriptIntegrityPage;
  markdown: string;
  plain: string;
  tokens: PageTokens;
  paragraphs: string[];
  namedEntitySet: Set<string>;
  evidenceTerms: Set<string>;
  causalTerms: Set<string>;
  conclusionTerms: Set<string>;
  uncommonTerms: Set<string>;
  definitionHeads: Set<string>;
  recapCue: boolean;
};

const ENTITY_STOP = new Set([
  "the", "this", "that", "these", "those", "then", "than", "when", "what", "which", "while",
  "after", "before", "because", "however", "therefore", "thus", "hence", "rather", "instead",
  "chapter", "page", "section", "figure", "table", "note", "notes"
]);

const FUNCTION_WORDS = new Set([
  "the", "and", "that", "this", "with", "from", "into", "then", "than", "while", "where", "which", "who",
  "their", "there", "these", "those", "through", "toward", "towards", "under", "over", "before", "after",
  "between", "also", "therefore", "thus", "however", "rather", "only", "same", "case", "page", "chapter",
  "possible", "available", "show", "shows", "showed", "about", "because", "during", "when", "what",
  "were", "was", "are", "is", "been", "being", "have", "has", "had", "could", "would", "might", "may",
  "can", "must", "should", "not", "but", "for", "of", "to", "in", "on", "at", "by", "as", "an", "a",
  "or", "its", "they", "them", "his", "her", "she", "him", "our", "we", "you", "your", "it", "if",
  "so", "no", "yes", "one", "two", "each", "both", "all", "any", "some", "more", "most", "such",
  "other", "another", "own", "into", "out", "up", "down", "off", "still", "even", "just", "very"
]);

const CAUSAL_CUES = new Set([
  "because", "therefore", "thus", "hence", "caused", "causing", "resulted", "resulting", "produced",
  "enabled", "forced", "drove", "triggered", "consequently", "implies", "implied", "led", "owing",
  "due", "constrained", "redirected", "narrowed", "expanded"
]);

const CONCLUSION_CUES = new Set([
  "therefore", "thus", "hence", "shows", "shown", "proves", "proof", "means", "suggests", "suggested",
  "rather", "instead", "conclusion", "concludes", "evidence", "implies", "follows", "accordingly"
]);

const RECAP_CUE_PATTERN =
  /\b(?:as we (?:saw|have seen|noted|mentioned)|as (?:noted|mentioned) earlier|recall that|remember that|to recap|in other words|as already (?:shown|established))\b/iu;

const DEFINITION_PATTERN =
  /\b([\p{L}][\p{L}\p{M}'’-]{2,})\s+(?:is|was|are|were)\s+(?:a|an|the)\b/giu;

const DATE_PATTERN = /\b(?:[1-9]\d{2,3}|\d{1,2}(?:st|nd|rd|th)\s+century)(?:\s*(?:bce|ce|bc|ad))?\b/giu;

const NAMED_ENTITY_PATTERN = /\p{Lu}[\p{L}\p{M}'’-]*(?:\s+\p{Lu}[\p{L}\p{M}'’-]*)*/gu;

export function chapterOf(page: ManuscriptIntegrityPage): number {
  return page.chapterIndex ?? Math.ceil(page.index / 5);
}

export function pagesShareChapter(left: ManuscriptIntegrityPage, right: ManuscriptIntegrityPage): boolean {
  if (left.chapterIndex !== undefined && right.chapterIndex !== undefined) {
    return left.chapterIndex === right.chapterIndex;
  }
  return Math.abs(left.index - right.index) < 5;
}

export function setOverlap(left: Set<string>, right: Set<string>): SetOverlap {
  if (left.size === 0 && right.size === 0) {
    return { intersection: 0, union: 0, jaccard: 0, containment: 0 };
  }
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  let intersection = 0;
  for (const term of smaller) {
    if (larger.has(term)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  const containment = smaller.size === 0 ? 0 : intersection / smaller.size;
  return {
    intersection,
    union,
    jaccard: union === 0 ? 0 : intersection / union,
    containment
  };
}

export function cacheManuscriptPages(
  pages: readonly { page: ManuscriptIntegrityPage; plain: string; tokens: PageTokens }[]
): CachedManuscriptPage[] {
  return pages.map(({ page, plain, tokens }) => {
    const namedEntitySet = namedEntities(plain);
    const uncommonTerms = uncommonContent(tokens.values);
    const evidenceTerms = new Set([...uncommonTerms].filter((term) => !namedEntitySet.has(term)));
    for (const entity of namedEntitySet) {
      if (entity.length >= 8 || /\d/.test(entity)) {
        evidenceTerms.add(entity);
      }
    }
    const lastSlice = tokens.values.slice(Math.max(0, tokens.values.length - 24));
    const conclusionTerms = new Set(
      [...lastSlice.filter((token) => uncommonTerms.has(token) || CONCLUSION_CUES.has(token)), ...cueHits(tokens.values, CONCLUSION_CUES)]
    );
    return {
      page,
      markdown: page.markdown,
      plain,
      tokens,
      paragraphs: paragraphsFromMarkdown(page.markdown),
      namedEntitySet,
      evidenceTerms,
      causalTerms: cueHits(tokens.values, CAUSAL_CUES),
      conclusionTerms,
      uncommonTerms,
      definitionHeads: definitionHeads(plain),
      recapCue: RECAP_CUE_PATTERN.test(plain)
    };
  });
}

function namedEntities(plain: string): Set<string> {
  const entities = new Set<string>();
  for (const match of plain.matchAll(NAMED_ENTITY_PATTERN)) {
    const raw = match[0]?.trim() ?? "";
    const folded = raw.toLowerCase();
    if (raw.length < 3 || ENTITY_STOP.has(folded)) {
      continue;
    }
    entities.add(folded);
  }
  for (const match of plain.matchAll(DATE_PATTERN)) {
    entities.add(match[0]!.toLowerCase().replace(/\s+/g, " "));
  }
  return entities;
}

function uncommonContent(tokens: readonly string[]): Set<string> {
  const terms = new Set<string>();
  for (const token of tokens) {
    if (token.length >= 5 && !FUNCTION_WORDS.has(token)) {
      terms.add(token);
    }
  }
  return terms;
}

function cueHits(tokens: readonly string[], cues: Set<string>): Set<string> {
  const hits = new Set<string>();
  for (const token of tokens) {
    if (cues.has(token)) {
      hits.add(token);
    }
  }
  return hits;
}

function definitionHeads(plain: string): Set<string> {
  const heads = new Set<string>();
  DEFINITION_PATTERN.lastIndex = 0;
  for (const match of plain.matchAll(DEFINITION_PATTERN)) {
    const head = match[1]?.toLowerCase();
    if (head && !FUNCTION_WORDS.has(head)) {
      heads.add(head);
    }
  }
  return heads;
}

export function paragraphsFromMarkdown(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function paragraphRole(paragraphCount: number, index: number): ParagraphRole {
  if (index <= 0) {
    return "opening";
  }
  if (index >= paragraphCount - 1) {
    return "closing";
  }
  return "middle";
}

export function dominantParagraphRole(markdown: string, test: (paragraph: string) => boolean): ParagraphRole | null {
  const paragraphs = paragraphsFromMarkdown(markdown);
  const roles = paragraphs.flatMap((paragraph, index) => (test(paragraph) ? [paragraphRole(paragraphs.length, index)] : []));
  if (roles.length === 0) {
    return null;
  }
  const counts = new Map<ParagraphRole, number>();
  for (const role of roles) {
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

export function chaptersSpannedBy(pages: readonly CachedManuscriptPage[], indexes: readonly number[]): number {
  const wanted = new Set(indexes);
  return new Set(pages.filter((page) => wanted.has(page.page.index)).map((page) => chapterOf(page.page))).size;
}

export function tokenSet(text: string): Set<string> {
  return new Set((text.toLowerCase().match(WORD_TOKEN_PATTERN) ?? []).filter((token) => token.length >= 3 && !FUNCTION_WORDS.has(token)));
}
