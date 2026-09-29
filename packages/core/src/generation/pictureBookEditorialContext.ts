import type { PriorPageContext } from "./pagesShared.js";
import type { PictureBookPageReview } from "./pictureBookReviewValidation.js";

export type PictureBookPreviousReview = {
  pages: readonly PriorPageContext[];
  reviews: readonly PictureBookPageReview[];
  /** The caller binds these reviews to their exact manuscript and review context. */
  fingerprint?: string;
};

/** Prior judgments explain a recheck; they never supply the current verdict.
 * Only pair a verdict with the exact prose it assessed. Omitted, stale and
 * unverified rows cannot become a previous clean approval. */
export function pictureBookEditorialHistory(pages: readonly PriorPageContext[], previous?: PictureBookPreviousReview) {
  if (!previous) return undefined;
  const originals = new Map(previous.pages.map(page => [page.index, page]));
  const changedPageIndexes = pages.filter(page => {
    const old = originals.get(page.index);
    return !old || old.markdown !== page.markdown || old.title !== page.title;
  }).map(page => page.index);
  const current = new Set(pages.map(page => page.index));
  const verified = previous.reviews.filter(review => current.has(review.pageIndex) &&
    previous.reviews.filter(other => other.pageIndex === review.pageIndex).length === 1 &&
    previous.pages.filter(page => page.index === review.pageIndex).length === 1 &&
    originals.get(review.pageIndex)?.markdown === review.draftMarkdown && review.completedChecks.pageModelReview &&
    !review.unverifiedFindings?.length);
  return {
    changedPageIndexes,
    unchangedCleanPageIndexes: verified.filter(review => review.report.approved && !review.findings?.some(finding => finding.domain === "prose") &&
      !changedPageIndexes.includes(review.pageIndex)).map(review => review.pageIndex),
    findings: verified.flatMap(review => (review.findings ?? []).filter(finding => finding.domain === "prose")
      .map(finding => ({ pageIndex: review.pageIndex, ...finding })))
  };
}

/** One shared standard for initial and candidate review, inside the existing call. */
export const PICTURE_BOOK_EDITORIAL_STANDARD = [
  "Apply the same evidence threshold on initial and repair reviews. A quotation locates a passage; it does not by itself prove the diagnosis. Before returning a finding, try the strongest ordinary reading of the complete surrounding scene. Report a material defect only when that reading still fails an explicit story fact, a user obligation, intelligibility or meaningful progression. Do not require additional prose just to rule out every imaginable ambiguity, and do not invent off-page rescues for explicit contradictions.",
  "Narration order is not always event order: a signaled cut between simultaneous actions may show the same interval from another viewpoint. Read temporal cues and the following scene together before alleging a repeated action or a backward handoff. A real contradiction must identify incompatible states or an explicit before/after claim. Likewise, two unnamed objects of the same kind are not necessarily one object; establish their identity or a finite inventory before claiming impossible movement. Preserve known counts, possession, locations and deadlines.",
  "For suspected stretched scenes, assess the connected sequence's attempt, turn and consequence, then name each page's actual contribution. Different verbs or task stages alone do not justify separate pages. Asking, agreeing, positioning, lifting, carrying and confirming a simple action should share space unless a difficulty, discovery, consequential choice, relationship change or worthwhile reader experience earns the separation. Quiet observation, purposeful repetition and a genuinely difficult retrieval can earn space. In guidance name the smallest connected interval and what to combine and develop, while preserving causal steps. Never fix pacing by deleting an essential handoff or inventing danger.",
  "When previousEditorialReview is supplied, it records verified judgments of the previous draft, not authority over this one. changedPageIndexes identifies differences from THAT draft; repairContext.changes compares with the frozen original. Recheck all current prose and dependencies. For a new defect on an unchanged previously clean page, explain in the finding why the earlier reading fails: cite a changed dependency or an overlooked explicit fact. An unchanged inherited defect is not an introduced regression. Retain a prior objection only if current prose still supports it; state the remaining concrete defect instead of escalating an old suggestion into a new obligation. Prior approval must never hide a real missed defect. Keep this comparison internal except for the concise reasons in findings and repairAssessment."
];
