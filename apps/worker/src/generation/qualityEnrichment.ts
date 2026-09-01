import {
  applyStoryDelta,
  auditPageStyle,
  extractStoryState,
  hasResearchIntent,
  localStyleInstructions,
  unpaidPromiseIssues,
  verifyPageClaims,
  withClaimVerification,
  withStoryContradictions,
  withStyleAudit,
  type BookPlan,
  type CreateProjectInput,
  type PageDraft,
  type PageQualityReport,
  type PriorPageContext,
  type QualityFeatureId,
  type StoryExtractResult,
  type StoryState,
  type TextModelAdapter
} from "@book-maker/core";
import { loadProjectStoryState, persistPageStoryDelta, rebuildStoryStateFromPages } from "./storyStateStore.js";
import { loadQualityContext } from "./qualitySettings.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import type { Prisma } from "@book-maker/db";

export type EnrichedPageReview = {
  report: PageQualityReport;
  extract: StoryExtractResult | null;
  storyState: StoryState;
};

export type QualityGateContext = {
  enabled: (feature: QualityFeatureId) => boolean;
};

export async function enrichPageQualityReport(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  pageIndex: number;
  draft: PageDraft;
  report: PageQualityReport;
  previousPages: PriorPageContext[];
  researchNotes: string[];
  textModel: TextModelAdapter;
  projectId: string;
  /**
   * The caller's pinned style lock — pages 1–2, loaded when its own window no
   * longer reaches them — or empty when the gate is off. **Required**, and that
   * is the fix rather than the shape: this used to pin from `previousPages`
   * when absent, so a caller that handed in a recency window (`continueBook`
   * passes the last eighteen pages) had a continuation at page 41 audited and
   * revised against pages 23 and 24 instead of the book's opening voice, and
   * nothing said so. A caller with nothing to pin passes `[]` and means it.
   */
  styleExcerpts: string[];
  quality?: QualityGateContext | undefined;
  storyState?: StoryState | undefined;
}): Promise<EnrichedPageReview> {
  const quality = options.quality ?? (await loadQualityContext(options.input));
  const storyState =
    options.storyState ?? (await loadProjectStoryState(options.projectId, options.plan.promises ?? []));
  const styleExcerpts = options.styleExcerpts;
  let report = options.report;
  let extract: StoryExtractResult | null = null;

  if (quality.enabled("storyExtractAudit")) {
    try {
      extract = await extractStoryState({
        textModel: options.textModel,
        pageIndex: options.pageIndex,
        title: options.draft.title,
        markdown: options.draft.markdown,
        summary: options.draft.summary,
        currentState: storyState
      });
      report = withStoryContradictions(report, extract.contradictions);
    } catch (error) {
      if (isStopRequestedError(error)) {
        throw error;
      }
      console.warn(`Story extract skipped for project ${options.projectId} page ${options.pageIndex}`, error);
    }
    const isLastPage = options.pageIndex === options.input.targetPages;
    const baseState = isLastPage
      ? await rebuildStoryStateFromPages(options.projectId, options.plan.promises ?? [])
      : storyState;
    const stateForUnpaid = extract
      ? applyStoryDelta(baseState, extract.storyDelta, options.pageIndex)
      : baseState;
    report = withStoryContradictions(
      report,
      [],
      unpaidPromiseIssues(stateForUnpaid, options.pageIndex, options.input.targetPages)
    );
  }

  const claimVerificationApplies = quality.enabled("claimVerifier") && hasResearchIntent(options.input);
  // This seam receives the already URL-filtered notes from generationContext;
  // blank strings still do not constitute evidence.
  const hasSourceBackedResearchNotes = options.researchNotes.some((note) => note.trim().length > 0);
  if (claimVerificationApplies && !hasSourceBackedResearchNotes) {
    report = {
      ...report,
      groundedOk: true,
      groundingStatus: "unverified_no_sources"
    };
  } else if (claimVerificationApplies) {
    try {
      const verification = await verifyPageClaims({
        textModel: options.textModel,
        pageIndex: options.pageIndex,
        markdown: options.draft.markdown,
        researchNotes: options.researchNotes
      });
      report = withClaimVerification(report, verification);
    } catch (error) {
      if (isStopRequestedError(error)) {
        throw error;
      }
      report = {
        ...report,
        groundedOk: true,
        groundingStatus: "unavailable"
      };
      console.warn(`Claim verifier skipped for project ${options.projectId} page ${options.pageIndex}`, error);
    }
  } else {
    report = {
      ...report,
      groundedOk: true,
      groundingStatus: "not_applicable"
    };
  }

  if (quality.enabled("styleAuditor") && styleExcerpts.length > 0) {
    try {
      const audit = await auditPageStyle({
        textModel: options.textModel,
        markdown: options.draft.markdown,
        voiceGuide: options.plan.voiceGuide,
        antiAiRules: localStyleInstructions(options.plan),
        styleExcerpts
      });
      report = withStyleAudit(report, audit);
    } catch (error) {
      if (isStopRequestedError(error)) {
        throw error;
      }
      console.warn(`Style auditor skipped for project ${options.projectId} page ${options.pageIndex}`, error);
    }
  }

  return { report, extract, storyState };
}

export type RevisedDraftStyleAuditor = (
  pageIndex: number,
  draft: PageDraft,
  report: PageQualityReport
) => Promise<PageQualityReport>;

/**
 * Ceiling on re-audit provider calls per page. `maxCandidates` bounds the
 * revise/review pairs but nothing counted the audits layered on top: every
 * revision the reviewer approved bought one more `auditPageStyle` call, so a
 * page oscillating between the two gates spent up to six uncounted calls on
 * top of the one `enrichPageQualityReport` already made. After this many
 * second opinions the reviewer's approval stands unaudited.
 */
const MAX_REVISED_DRAFT_STYLE_AUDITS = 2;

/**
 * The style audit for drafts the quality loop rewrites. `enrichPageQualityReport`
 * runs once, on the initial draft, so the dedicated auditor used to see exactly
 * one of up to seven candidates: a rewrite that fixed the flagged beat but
 * reintroduced excerpt-divergent register shipped through a strictly weaker
 * gate than the draft it replaced — and the auditor exists precisely because
 * the general reviewer approves pages it would reject. `runPageQualityLoop`
 * calls this on a revision the reviewer has approved; a flip back to
 * not-approved keeps the loop revising inside its existing candidate budget,
 * and the audits themselves are capped at `MAX_REVISED_DRAFT_STYLE_AUDITS`
 * per page — the closure is built once per page, so its counter is the page's.
 *
 * Returns undefined when the gate is off or there is nothing to compare
 * against, so `runPageQualityLoop` — its one caller, which builds it out of the
 * same excerpts it revises and reviews with — can simply skip the audit.
 * Failure degrades to the unaudited report, the same bargain
 * `enrichPageQualityReport` makes; only a user stop travels out.
 */
export function revisedDraftStyleAuditor(options: {
  projectId: string;
  plan: BookPlan;
  textModel: TextModelAdapter;
  styleExcerpts: string[];
  quality: QualityGateContext;
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
        markdown: draft.markdown,
        voiceGuide: options.plan.voiceGuide,
        antiAiRules: localStyleInstructions(options.plan),
        styleExcerpts: options.styleExcerpts,
        ...(options.userRequest ? { userRequest: options.userRequest } : {})
      });
      return withStyleAudit(report, audit);
    } catch (error) {
      if (isStopRequestedError(error)) {
        throw error;
      }
      console.warn(`Style auditor skipped for project ${options.projectId} page ${pageIndex}`, error);
      return report;
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

export type KeeperStoryDeltaOptions = {
  projectId: string;
  pageIndex: number;
  draft: PageDraft;
  textModel: TextModelAdapter;
  plan: BookPlan;
  input: CreateProjectInput;
  previousExtract: StoryExtractResult | null;
  keeperWasRevised: boolean;
  currentState: StoryState;
  quality?: QualityGateContext | undefined;
};

/**
 * The model half of `persistKeeperStoryDelta`, on its own so a caller that has
 * to publish under an ownership fence can spend the call *before* the fence and
 * leave nothing but writes behind it.
 *
 * A revised keeper is re-extracted because the review's own extract described a
 * draft that is no longer the one being saved; an unrevised keeper reuses it.
 * Either way this writes nothing, so a caller that stands down after it has
 * published no story state at all.
 */
export async function keeperStoryExtractForSave(
  options: KeeperStoryDeltaOptions
): Promise<StoryExtractResult | null> {
  const quality = options.quality ?? (await loadQualityContext(options.input));
  if (!quality.enabled("storyExtractAudit")) {
    return null;
  }
  let extract = options.previousExtract;
  if (options.keeperWasRevised || !extract) {
    try {
      extract = await extractStoryState({
        textModel: options.textModel,
        pageIndex: options.pageIndex,
        title: options.draft.title,
        markdown: options.draft.markdown,
        summary: options.draft.summary,
        currentState: options.currentState
      });
    } catch (error) {
      if (isStopRequestedError(error)) {
        throw error;
      }
      console.warn(`Keeper story extract skipped for project ${options.projectId} page ${options.pageIndex}`, error);
      return null;
    }
  }
  return extract;
}

/** The write half: one delta, no provider call, nothing long to straddle. */
export async function persistStoryExtract(options: {
  projectId: string;
  pageIndex: number;
  plan: BookPlan;
  extract: StoryExtractResult;
  client?: Pick<Prisma.TransactionClient, "page" | "project"> | undefined;
}): Promise<StoryState | null> {
  const write = {
    projectId: options.projectId,
    pageIndex: options.pageIndex,
    delta: options.extract.storyDelta,
    seedPromises: options.plan.promises ?? []
  };
  return options.client ? persistPageStoryDelta(write, options.client) : persistPageStoryDelta(write);
}

export async function persistKeeperStoryDelta(options: KeeperStoryDeltaOptions): Promise<StoryState | null> {
  const extract = await keeperStoryExtractForSave(options);
  if (!extract) {
    return null;
  }
  return persistStoryExtract({
    projectId: options.projectId,
    pageIndex: options.pageIndex,
    plan: options.plan,
    extract
  });
}
