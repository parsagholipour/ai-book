import { styleAuditedScoreBeats, type PageDraft, type PageQualityReport } from "@book-maker/core";

export type DraftCandidate = { draft: PageDraft; revision: number; report: PageQualityReport };

/**
 * A rewrite is not guaranteed to improve: the sixth attempt can score below the
 * second. Every review loop keeps its keeper through this one comparison so a
 * failed page is saved at its strongest draft, not its latest. Only some
 * candidates are ever style-audited — the initial draft and reviewer-approved
 * revisions — so the comparison is `styleAuditedScoreBeats`, which counts the
 * audit's penalty only against another audited candidate: subtracted from
 * `score` itself, the penalty handed the keeper's seat to a rejected rewrite
 * the auditor never saw.
 */
export function bestDraftCandidate(best: DraftCandidate, candidate: DraftCandidate): DraftCandidate {
  return styleAuditedScoreBeats(candidate.report, best.report) ? candidate : best;
}

export type PageQualityLoopOutcome = {
  approved: boolean;
  /** The draft to keep: the approved one, or the best-scoring failure. */
  draft: PageDraft;
  report: PageQualityReport;
  /** The kept draft's candidate number (the best candidate's when not approved). */
  revision: number;
  /** Total candidates/attempts consumed, whichever draft was kept. */
  attempts: number;
};

