import type { ChapterPlan, PageProductionBeat } from "../schemas/book.js";
import {
  sanitizePageBriefForCitationContract,
  type CitationContractNote
} from "./pagesShared.js";

export const OPENING_PAGE_SCOPE_RULES = [
  "One page, one irreversible change.",
  "An opening page of a chapter owns the opening event and its immediate context only; later pages in pages[] own later beats.",
  "Do not list four or more distinct theaters, campaigns, or chapter keyBeats on one page's beat."
] as const;

export function finalizeProductionPageBeat(
  page: PageProductionBeat,
  researchNotes: readonly CitationContractNote[] | undefined,
  scope: {
    chapter?: ChapterPlan | undefined;
    chapterPageStart?: number | undefined;
    chapterPageEnd?: number | undefined;
  }
): PageProductionBeat {
  return sanitizePageBriefForCitationContract(normalizeOverpackedOpeningPageBeat(page, scope), researchNotes);
}

function normalizeOverpackedOpeningPageBeat(
  page: PageProductionBeat,
  scope: {
    chapter?: ChapterPlan | undefined;
    chapterPageStart?: number | undefined;
    chapterPageEnd?: number | undefined;
  }
): PageProductionBeat {
  const start = scope.chapterPageStart;
  const end = scope.chapterPageEnd;
  const chapter = scope.chapter;
  const isOpening =
    start !== undefined && end !== undefined && end > start && page.pageIndex === start && Boolean(chapter);
  if (!isOpening) {
    return page;
  }
  const keyBeats = distinctNonEmptyKeyBeats(chapter!.keyBeats);
  const mentioned = keyBeats.filter((beat) => includesPhrase(page.beat, beat));
  const opening = keyBeats[0];
  if (mentioned.length < 4 || !opening) {
    return page;
  }
  return {
    ...page,
    beat: `Open the chapter on ${opening}. Keep this page on that event and its immediate context only.`
  };
}

function includesPhrase(haystack: string, phrase: string): boolean {
  return haystack.toLowerCase().includes(phrase.toLowerCase());
}

function distinctNonEmptyKeyBeats(keyBeats: readonly string[]): string[] {
  const seen = new Set<string>();
  const distinct: string[] = [];
  for (const keyBeat of keyBeats) {
    const trimmed = keyBeat.trim();
    const identity = trimmed.toLowerCase();
    if (trimmed && !seen.has(identity)) {
      seen.add(identity);
      distinct.push(trimmed);
    }
  }
  return distinct;
}
