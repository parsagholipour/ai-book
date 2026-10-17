import { isStopOrAbortError, reviewQuickDraftManuscript, type BookPlan, type CreateProjectInput, type FinalBookQa, type ManuscriptQualityIssue, type TextModelAdapter } from "@book-maker/core";
import { quickDraftQaAfterRepair } from "../generation/quickDraftReviewPolicy.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";

/**
 * The compile's one review: the defect screen over the whole manuscript (`reviewQuickDraftManuscript`). The
 * chapter-transition sweep, the whole-book QA and the reused picture-book review that other tiers ran here were
 * removed on 2026-10-16 (E4 and H7b, `../handlers/CLAUDE.md`).
 */
export async function reviewFinalizationManuscript(options: {
  input: CreateProjectInput; plan: BookPlan; pages: ExportPageForRepair[]; textModel: TextModelAdapter;
}): Promise<{ issues: ManuscriptQualityIssue[]; finalQa: FinalBookQa }> {
  try {
    const finalQa = await reviewQuickDraftManuscript(options);
    const rejected = finalQa.focusedReview?.rejectedFindings ?? 0;
    return { issues: rejected ? [{ ...unavailable("Focused"),
      message: `Focused review could not validate ${rejected} finding(s). Grounded findings were retained; the review is incomplete.` }] : [], finalQa };
  } catch (error) {
    if (isStopOrAbortError(error)) throw error;
    return { issues: [unavailable("Defect screen")], finalQa: {
      approved: false, score: 0, issues: [], requiredFixes: [], notes: "Defect screen unavailable."
    } };
  }
}

function unavailable(check: string): ManuscriptQualityIssue {
  return { code: "FINAL_REVIEW_UNAVAILABLE", source: "model", severity: "warning", affectedPageIndexes: [],
    message: `${check} review could not complete after its bounded provider attempts.`,
    guidance: "Review the saved manuscript or request another review." };
}

/**
 * The second verdict is derived, never read: the repair published only pages its verification resolved with
 * no regression, so those findings are settled and every other finding of the screen stands. The full re-screen
 * this replaced re-read the book (22k of a 30-page novel's tokens, ~20 s) and found a different sample of
 * defects each time, which it then filed unrepaired.
 */
export function quickDraftReviewAfterRepair(
  initial: { finalQa: FinalBookQa; issues: ManuscriptQualityIssue[] },
  state: { completedPageIds: string[]; unavailableRepairPageIds?: string[] | undefined },
  pages: readonly { id: string; index: number }[]
): { finalQa: FinalBookQa; issues: ManuscriptQualityIssue[] } {
  const unavailable = new Set(state.unavailableRepairPageIds ?? []);
  const repaired = new Set(pages.filter((page) => state.completedPageIds.includes(page.id) && !unavailable.has(page.id)).map((page) => page.index));
  return { finalQa: quickDraftQaAfterRepair(initial.finalQa, repaired), issues: initial.issues };
}
