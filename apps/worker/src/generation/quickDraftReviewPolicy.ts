import { isAuthorManuscript, type CreateProjectInput, type FinalBookQa } from "@book-maker/core";
import type { QualityFeatureId } from "@book-maker/core/qualityGates";
import type { QualityGateContext } from "./qualityEnrichment.js";

export const QUICK_DRAFT_REPAIR_PAGE_LIMIT = 3;

export function usesQuickDraftReview(input: CreateProjectInput): boolean {
  // Server-only experiment switch; Balanced's default and model routing do not change.
  return (input.mediaSettings?.modelTier === "fast" || (input.mediaSettings?.modelTier === "balanced" &&
    process.env.BOOK_MAKER_BALANCED_LIGHT_REVIEW === "1")) && !isAuthorManuscript(input.mediaSettings);
}

const DEFERRED_PAGE_GATES = new Set<QualityFeatureId>([
  "pageModelReview", "pageQaRewrite", "smartUnslop", "storyExtractAudit",
  "styleAuditor", "claimVerifier", "changedCandidateGrounding", "claimRetrieve"
]);

/** Generation defers model QA and repairs to the complete manuscript. Edits retain their checks. */
export function quickDraftPageQuality<T extends QualityGateContext>(
  input: CreateProjectInput, quality: T, userRequest?: string
): Omit<T, "enabled"> & QualityGateContext {
  if (!usesQuickDraftReview(input) || userRequest) return quality;
  return { ...quality, lightweight: true,
    enabled: (feature: QualityFeatureId) => !DEFERRED_PAGE_GATES.has(feature) && quality.enabled(feature) };
}

/** Cap before excluding attempted pages, so redelivery cannot spend another repair budget. */
export function quickDraftRepairTargets<T extends { index: number }>(pages: readonly T[], indexes: ReadonlySet<number>, qa?: FinalBookQa): T[] {
  const groups = pages.filter(page => indexes.has(page.index)).map(page => new Set([page.index]));
  for (const linked of qa?.focusedReview?.repairGroups ?? []) {
    const overlapping = groups.filter(group => linked.some(index => group.has(index)));
    if (!overlapping.length) continue;
    const merged = new Set(overlapping.flatMap(group => [...group]));
    for (const group of overlapping) groups.splice(groups.indexOf(group), 1);
    // Missing or out-of-scope dependencies make the entire group ineligible, never a partial repair.
    if (linked.every(index => merged.has(index))) groups.push(merged);
  }
  const selected = new Set<number>();
  const unverified = new Set(qa?.focusedReview?.unverifiedRepairPageIndexes ?? []);
  for (const group of groups.sort((a, b) => Math.min(...a) - Math.min(...b))) {
    if ([...group].some(index => unverified.has(index))) continue;
    if (selected.size + group.size <= QUICK_DRAFT_REPAIR_PAGE_LIMIT) for (const index of group) selected.add(index);
  }
  return pages.filter(page => selected.has(page.index)).sort((a, b) => a.index - b.index);
}

/** The screen constructs this prefix from validated pageIndex; cited pages are evidence, not repair targets. */
function quickDraftMessagePage(message: string): number { return Number(/^Page (\d+):/u.exec(message)?.[1]); }

export function quickDraftQaTargets(qa: FinalBookQa): number[] {
  return [...new Set([...qa.issues, ...qa.requiredFixes].map(quickDraftMessagePage).filter(Number.isSafeInteger))];
}

export function quickDraftQaForPage(qa: FinalBookQa, pageIndex: number): FinalBookQa {
  return { ...qa, issues: qa.issues.filter((message) => quickDraftMessagePage(message) === pageIndex),
    requiredFixes: qa.requiredFixes.filter((message) => quickDraftMessagePage(message) === pageIndex) };
}
