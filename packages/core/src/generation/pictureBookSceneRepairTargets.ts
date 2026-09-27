import type { PictureBookPageReview } from "./pictureBookReviewValidation.js";

type Finding = NonNullable<PictureBookPageReview["findings"]>[number];
type Page = { index: number; markdown: string };
export type PictureBookSceneRepairTarget = { pageIndex: number; pageIndexes: number[] };

export function validSceneRepairPageIndexes(owner: number, indexes: readonly number[], known: ReadonlySet<number>): boolean {
  return indexes.length >= 2 && indexes.length <= 40 && indexes.includes(owner) &&
    indexes.every((index, i) => known.has(index) && (i === 0 || index === indexes[i - 1]! + 1));
}

/** Ownership, supporting citations and the editable interval have different jobs.
 * Require grounded endpoints so a citation elsewhere cannot widen that interval. */
export function pictureBookSceneRepairScopeErrors(owner: number, finding: Finding, pages: ReadonlyMap<number, Page>): string[] {
  const indexes = finding.repairPageIndexes;
  if (indexes === undefined) return [];
  const evidence = [{ pageIndex: owner, quote: finding.quote }, ...finding.relatedEvidence];
  if (finding.domain !== "prose" || finding.basis !== "cross_page" ||
    !["repetition", "progression", "continuity", "brief", "arc", "plot", "style"].includes(finding.category) ||
    !validSceneRepairPageIndexes(owner, indexes, new Set(pages.keys())) ||
    ![indexes[0], indexes.at(-1)].every(index => evidence.some(item => item.pageIndex === index)) ||
    evidence.some(item => !pages.get(item.pageIndex)?.markdown.includes(item.quote)))
    return ["repairPageIndexes must name a contiguous cross-page prose repair interval containing its owner, with exact prose evidence at both endpoints."];
  return [];
}

/** Only consume snapshots whose complete manuscript/context fingerprint matched.
 * Recheck persisted source spans too; unverified findings never grant scope. */
export function pictureBookSceneRepairTargets(pages: readonly Page[], reviews: readonly PictureBookPageReview[]): PictureBookSceneRepairTarget[] {
  const byPage = new Map(pages.map(page => [page.index, page]));
  const targets = new Map<string, PictureBookSceneRepairTarget>();
  for (const review of reviews) {
    if (!review.completedChecks.pageModelReview || byPage.get(review.pageIndex)?.markdown !== review.draftMarkdown) continue;
    for (const finding of review.findings ?? []) {
      let indexes = finding.repairPageIndexes;
      // Compatibility with saved reviews predating explicit intervals. Only a
      // direct connected-interval repair instruction qualifies, never a range
      // mentioned in the diagnosis, cited prose or rejected-candidate feedback.
      if (indexes === undefined && ["progression", "repetition"].includes(finding.category)) {
        const match = /^Combine the connected pages? (\d+)\s*[-–—]\s*(\d+) interval\b/iu.exec(finding.guidance);
        if (match) {
          const start = Number(match[1]), end = Number(match[2]);
          if (end > start && end - start < 40) indexes = Array.from({ length: end - start + 1 }, (_, i) => start + i);
        }
      }
      if (!indexes || pictureBookSceneRepairScopeErrors(review.pageIndex, { ...finding, repairPageIndexes: indexes }, byPage).length) continue;
      const target = { pageIndex: review.pageIndex, pageIndexes: [...indexes] };
      targets.set(JSON.stringify(target), target);
    }
  }
  return [...targets.values()];
}
