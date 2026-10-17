import { isAuthorManuscript, strategyComposesChapters, type BookGenerationStrategy, type CreateProjectInput, type FinalBookQa } from "@book-maker/core";
import type { QualityFeatureId } from "@book-maker/core/qualityGates";
import type { QualityGateContext } from "./qualityEnrichment.js";

export const QUICK_DRAFT_REPAIR_PAGE_LIMIT = 3;

export function usesQuickDraftReview(input: CreateProjectInput): boolean {
  // Server-only experiment switch; Balanced's default and model routing do not change.
  return (input.mediaSettings?.modelTier === "fast" || (input.mediaSettings?.modelTier === "balanced" &&
    process.env.BOOK_MAKER_BALANCED_LIGHT_REVIEW === "1")) && !isAuthorManuscript(input.mediaSettings);
}

/**
 * Whether the compile reads the finished book with the one defect screen and repairs what it proves with the scoped
 * patch (`reviewQuickDraftManuscript`, `repairQuickDraftPages`), behind `finalBookQa`. It is the only model review
 * a book gets after drafting, on every tier, and it runs only on the books it was measured to help (the owner's bar,
 * 2026-10-16: a real reader-visible defect correctly fixed in at least 10% of books, repairs winning or tying):
 * - every Quick Draft book: composed, 11 of 48 books fixed (23%); short and per-page, 2 of 17 drafts (12%), 4 of 4
 *   repairs preferred (H7, H7b);
 * - a book composed by chapters on every other tier: Balanced 12 of 33 (36%), 15 of 17 repairs won or tied; Premium
 *   and Ultra compose on the same writer (gpt-6-luna) and have too few stored books to measure, so they follow it.
 * A short or per-page book off Quick Draft is printed as drafted: on 13 Balanced short-book drafts the screen found
 * no grounded defect at all (H7b), and Premium and Ultra draft short books on the same model.
 * Only the compile changes: page gates are deferred for Quick Draft alone (`quickDraftPageQuality`).
 */
export function usesCompileDefectScreen(input: CreateProjectInput, strategy: Pick<BookGenerationStrategy, "executionMode">): boolean {
  return usesQuickDraftReview(input) || (strategyComposesChapters(strategy) && !isAuthorManuscript(input.mediaSettings));
}

const DEFERRED_PAGE_GATES = new Set<QualityFeatureId>([
  "pageModelReview", "pageQaRewrite", "smartUnslop",
  "styleAuditor", "changedCandidateGrounding"
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

/** The screen's messages about these pages only; a repair is never handed another page's complaint. */
export function quickDraftTargetMessages(qa: FinalBookQa, pages: ReadonlySet<number>): string[] {
  return [...qa.issues, ...qa.requiredFixes].filter((message) => pages.has(quickDraftMessagePage(message)));
}

/**
 * The verdict after a verified repair, without a second read of the book: every finding whose pages the
 * repair published is settled by the verification that published them, and every other finding stands.
 * A finding's pages are repaired whole or not at all (`quickDraftRepairTargets`), so dropping each message
 * and group naming a repaired page drops exactly the repaired findings.
 */
export function quickDraftQaAfterRepair(qa: FinalBookQa, repaired: ReadonlySet<number>): FinalBookQa {
  const keep = (message: string) => !repaired.has(quickDraftMessagePage(message));
  const issues = qa.issues.filter(keep);
  const requiredFixes = qa.requiredFixes.filter(keep);
  const focused = qa.focusedReview;
  const rejectedFindings = focused?.rejectedFindings ?? 0;
  const standing = issues.length > 0 || requiredFixes.length > 0;
  return { ...qa, issues, requiredFixes,
    approved: !standing && rejectedFindings === 0, score: rejectedFindings ? 0 : standing ? 60 : 100,
    ...(focused ? { focusedReview: { ...focused,
      repairGroups: focused.repairGroups.filter((group) => !group.some((index) => repaired.has(index))),
      ...(focused.findings ? { findings: focused.findings.filter((finding) => !finding.targets.some((index) => repaired.has(index))) } : {}) } } : {}) };
}
