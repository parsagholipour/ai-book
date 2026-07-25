/**
 * Quality-assurance retry budgets for page generation.
 *
 * These bound how hard the worker tries to rescue a page that fails review
 * before it gives up and fails the job, so raising them raises both quality
 * and provider spend.
 */

/** Rewrite attempts allowed for a single page that keeps failing QA. */
export const MAX_PAGE_QA_REWRITE_ATTEMPTS = 6;

/** Revisions allowed per page during the whole-book final QA pass. */
export const MAX_FINAL_QA_REVISIONS_PER_PAGE = 6;

/** Total drafts considered for a page: the original plus every rewrite. */
export const MAX_PAGE_QA_CANDIDATES = MAX_PAGE_QA_REWRITE_ATTEMPTS + 1;

/** Times a page revision loop may restart from a fresh draft. */
export const MAX_PAGE_REVISE_RESTARTS = 2;

/** Candidate index at which recovery (brief repair) kicks in. */
export const PAGE_QA_RECOVERY_CANDIDATE = 4;
