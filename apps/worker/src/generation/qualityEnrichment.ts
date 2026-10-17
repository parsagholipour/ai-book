import {
  auditPageStyle,
  figureFreeProse,
  isCancellationError,
  localStyleInstructions,
  withStyleAudit,
  type BookPlan,
  type DecisionModelRoute,
  type PageDraft,
  type PageQualityReport,
  type QualityFeatureId,
  type TextModelAdapter
} from "@book-maker/core";

export type QualityGateContext = {
  enabled: (feature: QualityFeatureId) => boolean;
  lightweight?: boolean;
};

function withUnavailableQualityCheck(report: PageQualityReport, check: "style"): PageQualityReport {
  const message = "Style audit was unavailable; this check did not produce a verdict.";
  const advisories = report.qualityAdvisories ?? [];
  return { ...report,
    notes: `${report.notes}\n${message}`,
    qualityAdvisories: advisories.some((item) => item.check === check && item.message === message)
      ? advisories : [...advisories, { check, status: "unverified", message }]
  };
}

export type RevisedDraftStyleAuditor = (
  pageIndex: number,
  draft: PageDraft,
  report: PageQualityReport
) => Promise<PageQualityReport>;

/**
 * Ceiling on logical re-audit attempts per page, including screens. `maxCandidates` bounds the
 * revise/review pairs but nothing counted the audits layered on top: every
 * revision the reviewer approved bought one more `auditPageStyle` call, so a
 * page oscillating between the two gates spent up to six uncounted calls. After
 * this many second opinions the reviewer's approval stands unaudited.
 */
const MAX_REVISED_DRAFT_STYLE_AUDITS = 2;

/**
 * The style audit for the drafts a reader's chat page rewrite goes through (the
 * only loop left since 2026-10-16: no generated page is reviewed or audited,
 * `withoutPageReview`). The auditor exists because the general reviewer
 * approves pages it would reject. `runPageQualityLoop`
 * calls this on a revision the reviewer has approved; a flip back to
 * not-approved keeps the loop revising inside its existing candidate budget,
 * and the audits themselves are capped at `MAX_REVISED_DRAFT_STYLE_AUDITS`
 * per page — the closure is built once per page, so its counter is the page's.
 *
 * Returns undefined when the gate is off or there is nothing to compare
 * against, so `runPageQualityLoop` — its one caller, which builds it out of the
 * same excerpts it revises and reviews with — can simply skip the audit.
 * Failure degrades to the unaudited report; cancellation (`isCancellationError`:
 * abort and user stop) travels out.
 */
export function revisedDraftStyleAuditor(options: {
  projectId: string;
  plan: BookPlan;
  textModel: TextModelAdapter;
  decisions?: DecisionModelRoute | undefined;
  styleExcerpts: string[];
  quality: QualityGateContext;
  targetPages?: number | undefined;
  /**
   * Set only on a page the reader asked to change, and it changes what the
   * audit is *for*: a requested tone or register shift is the edit landing, not
   * drift to reject. See `auditPageStyle`.
   */
  userRequest?: string | undefined;
}): RevisedDraftStyleAuditor | undefined {
  if (!options.quality.enabled("styleAuditor") || options.styleExcerpts.length === 0) {
    return undefined;
  }
  let auditsSpent = 0;
  return async (pageIndex, draft, report) => {
    if (auditsSpent >= MAX_REVISED_DRAFT_STYLE_AUDITS) {
      return report;
    }
    // Spent on the attempt, not the success: a throwing call may still have
    // cost provider spend, and retrying it against the same excerpts is the
    // unbounded shape this counter exists to close.
    auditsSpent += 1;
    try {
      const audit = await auditPageStyle({
        textModel: options.textModel,
        ...(options.decisions ? { decisions: options.decisions } : {}),
        pageIndex,
        finalPage: pageIndex === options.targetPages,
        markdown: figureFreeProse(draft.markdown),
        voiceGuide: options.plan.voiceGuide,
        antiAiRules: localStyleInstructions(options.plan),
        styleExcerpts: options.styleExcerpts,
        ...(options.userRequest ? { userRequest: options.userRequest } : {})
      });
      return withStyleAudit(report, audit);
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }
      console.warn(`Style auditor skipped for project ${options.projectId} page ${pageIndex}`, error);
      return withUnavailableQualityCheck(report, "style");
    }
  };
}

/** Concatenate character/location lines with story-extract lines; keep the first of identical trims. */
export function mergeEntityAndStoryStateLines(
  entityStateLines: readonly string[],
  storyLines: readonly string[]
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const line of [...entityStateLines, ...storyLines]) {
    const key = line.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(key);
  }
  return merged;
}
