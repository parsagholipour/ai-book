import { modelTierForInput } from "@book-maker/core/modelTiers";
import type { CreateProjectInput, ModelTier } from "@book-maker/core";

/**
 * Quality-assurance retry budgets for page generation.
 *
 * These bound how hard the worker tries to rescue a page that fails review
 * before it gives up and keeps the best draft, so raising them raises both
 * quality and provider spend. The budgets scale with the book's model tier:
 * a tier that pays for stronger models also pays for more rescue attempts,
 * and a cheap tier stops early instead of burning six rewrites against a
 * reviewer that keeps saying no.
 *
 * **One table, two budgets, because the two loops that revise a page do not
 * count from the same place.** The drafting loop in generate-page counts
 * *candidates* from the original draft, so its budget's first unit is a draft
 * nobody has rewritten yet. The whole-book final-QA repair in compile-export
 * has already spent a rewrite before its loop starts — `repairPagesFromFinalQa`
 * revises once against the QA report and only then enters the loop — so its
 * budget counts *attempts* from the first rewrite, one base later. The same
 * integer therefore buys the repair loop one move less than it buys the
 * drafting loop, which is why `finalQaRevisionsFor` carries a floor of its own
 * and `pageQaRecoveryRevision` takes the recovery index as a parameter.
 */
const PAGE_QA_REWRITE_ATTEMPTS_BY_TIER: Record<ModelTier, number> = {
  fast: 2,
  balanced: 3,
  premium: 5,
  ultra: 10
};

/** Rewrite attempts allowed for a single page that keeps failing QA. */
export function pageQaRewriteAttemptsFor(input: CreateProjectInput): number {
  return PAGE_QA_REWRITE_ATTEMPTS_BY_TIER[modelTierForInput(input)];
}

/** Total drafts considered for a page: the original plus every rewrite. */
export function pageQaCandidatesFor(input: CreateProjectInput): number {
  return pageQaRewriteAttemptsFor(input) + 1;
}

/**
 * Candidate index at which recovery (brief repair + full-replacement rewrite)
 * kicks in, before {@link pageQaRecoveryRevision} fits it to the loop's budget.
 */
export const PAGE_QA_RECOVERY_CANDIDATE = 4;

/**
 * The earliest candidate recovery may ever land on. Recovery throws the draft
 * away — a brief-repair model call and an instruction to write a complete
 * replacement — so a loop must have spent at least one ordinary revision
 * first, or the cheapest tier becomes the one that escalates soonest and pays
 * the extra planner call on every flagged page. Revision 1 is the seed draft
 * and revision 2 is its first rewrite, so the floor is the second rewrite.
 */
const PAGE_QA_MIN_RECOVERY_REVISION = 3;

/**
 * Revisions allowed per page during the whole-book final QA pass.
 *
 * The rewrite budget, floored at the earliest index recovery may land on. A
 * repair loop whose budget ends *below* that index can never reach recovery at
 * all — and this pass exists for the pages that need it: it runs on a page the
 * page-level loop already spent its whole budget failing to rescue, and the
 * commonest such page is one whose brief collides with a beat an earlier page
 * already covers, which is the one complaint a light edit cannot answer. On
 * fast that floor is what the tier's own number could not buy (see the base
 * note above: two attempts is one ordinary rewrite and nothing else), so the
 * cheapest tier gets one ordinary rewrite and then the move that changes the
 * outcome, rather than two rewrites the reviewer rejects identically. Every
 * other tier already clears the floor and is left exactly where it was.
 *
 * Deriving it from `PAGE_QA_MIN_RECOVERY_REVISION` rather than writing 3 is
 * what keeps that true: move the floor and this budget follows it, instead of
 * silently going back to a repair pass that cannot repair.
 */
export function finalQaRevisionsFor(input: CreateProjectInput): number {
  return Math.max(PAGE_QA_MIN_RECOVERY_REVISION, pageQaRewriteAttemptsFor(input));
}

/** Times a page revision loop may restart from a fresh draft. */
export const MAX_PAGE_REVISE_RESTARTS = 2;

/**
 * Where recovery actually starts for one loop, given its budget.
 *
 * Both ends matter. A tier whose budget ends before `PAGE_QA_RECOVERY_CANDIDATE`
 * would otherwise spend its whole loop on light edits of a draft the reviewer
 * already rejected and never reach the one move that changes the outcome, so
 * the index is pulled down to the last candidate. But it is never pulled below
 * the floor above: a budget too small to hold an ordinary revision *and* a
 * recovery buys no recovery at all, which is the cheap tier stopping early
 * rather than escalating on its first and only rewrite.
 *
 * That second end is a **guard, not a description**: every budget reaching this
 * function today is at least `PAGE_QA_MIN_RECOVERY_REVISION`, because
 * `pageQaCandidatesFor` is floored by the tier table plus one and
 * `finalQaRevisionsFor` is floored by that same constant. So no caller lands on
 * it, and that is the point — it is what a future budget, or a tier table
 * edited down, is refused by rather than silently escalating on its first
 * rewrite. `pageReviewRecovery.test.ts` exercises it directly for that reason.
 *
 * Callers count from different bases — the page loops count candidates from
 * the original draft, final QA counts attempts from the first rewrite, one
 * later — which is why `requested` is a parameter. The progress message reads
 * the same answer, so an operator is told "quality recovery" exactly when the
 * loop is in it.
 */
export function pageQaRecoveryRevision(maxCandidates: number, requested = PAGE_QA_RECOVERY_CANDIDATE): number {
  return Math.max(PAGE_QA_MIN_RECOVERY_REVISION, Math.min(requested, maxCandidates));
}
