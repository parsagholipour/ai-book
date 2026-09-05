import { summaryFromMarkdown } from "../../pageSummary.js";
import { figureFreeProse, hasFigureFence } from "./figureBlocks.js";

function summaryCarriesFigureJson(summary: string, figureFreeMarkdown: string): boolean {
  if (hasFigureFence(summary)) {
    return true;
  }
  const jsonKey = /"(?:kind|categories|series|slices|nodes)"/;
  return jsonKey.test(summary) && !jsonKey.test(figureFreeMarkdown);
}

/** A page summary with no figure fence and no leftover figure JSON. */
export function pageDraftSummary(markdown: string | undefined, provided: string | undefined): string {
  const figureFree = figureFreeProse(markdown ?? "");
  if (provided !== undefined && !summaryCarriesFigureJson(provided, figureFree)) {
    return provided;
  }
  return summaryFromMarkdown(figureFree || undefined);
}

export function finalizePageDraft<D extends { markdown: string; summary: string }>(draft: D): D {
  return { ...draft, summary: pageDraftSummary(draft.markdown, draft.summary) };
}
