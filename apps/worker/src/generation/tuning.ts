/**
 * Page-rewrite tuning for the one loop that still rewrites a page — a reader's
 * chat page rewrite, whose candidate budget the edit owns
 * (`USER_EDIT_MAX_CANDIDATES`, `textEditRewrite.ts`).
 *
 * The tier-scaled page-QA budgets that used to live here (2 / 3 / 5 / 10
 * rewrites, and the recovery candidate the brief repair fired on) had no
 * reader once no generated page entered the review loop (E5, 2026-10-16), and
 * were deleted with that loop's recovery branches.
 */

/** Provider adapters own retries; restarting a revision would reset their paid-call budget. */
export const MAX_PAGE_REVISE_RESTARTS = 0;
