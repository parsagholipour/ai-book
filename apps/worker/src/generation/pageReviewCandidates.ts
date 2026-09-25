import { styleAuditedScoreBeats, type PageDraft, type PageQualityReport, type ChapterBrief } from "@book-maker/core";
import type { RepairedPageBrief } from "./pageReviewRecovery.js";

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
  /**
   * This chapter's brief with the page's brief repair merged in, present only
   * when the page kept a draft that repair briefed — the same condition the
   * durable `Chapter.productionBrief` write is taken on, decided once below.
   *
   * A caller that briefs the chapter's *other* pages from one copy of the brief
   * (the book passes, whose `ChapterSetup.brief` is one object per chapter; the
   * compile's repair pass, which parses one per chapter) rebinds its copy to
   * this and so hands the chapter's later pages the assignment this page
   * actually delivered. A caller drafting one page per job has nobody to tell
   * and ignores it. Absent is the safe answer either way: the caller keeps the
   * brief it had, which is what the row keeps too.
   */
  repairedChapterBrief?: ChapterBrief | undefined;
  /**
   * The durable half of a kept brief repair, present only when the caller asked
   * to publish it with its own page write. The function accepts that caller's
   * transaction client, keeping the CAS implementation behind this narrow
   * seam rather than exposing chapter-row details here.
   */
  pendingBriefRepair?: NonNullable<RepairedPageBrief["persist"]> | undefined;
};

