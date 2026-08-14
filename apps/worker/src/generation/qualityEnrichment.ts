import {
  applyStoryDelta,
  auditPageStyle,
  extractStoryState,
  formatStoryStateLines,
  hasResearchIntent,
  pinStyleExcerpts,
  sampleExcerptsFromInput,
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
  type StoryExtractResult,
  type StoryState,
  type TextModelAdapter
} from "@book-maker/core";
import { loadProjectStoryState, persistPageStoryDelta } from "./storyStateStore.js";
import { loadQualityContext } from "./qualitySettings.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";

export type EnrichedPageReview = {
  report: PageQualityReport;
  extract: StoryExtractResult | null;
  storyState: StoryState;
  styleExcerpts: string[];
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
  /** Precomputed style lock (pages 1–2). When absent, pinned from previousPages. */
  styleExcerpts?: string[] | undefined;
}): Promise<EnrichedPageReview> {
  const quality = await loadQualityContext(options.input);
  const storyState = await loadProjectStoryState(options.projectId, options.plan.promises ?? []);
  const styleExcerpts =
    options.styleExcerpts ??
    (quality.enabled("styleExcerpts")
      ? pinStyleExcerpts(options.previousPages, sampleExcerptsFromInput(options.input))
      : []);
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
    const stateForUnpaid = extract
      ? applyStoryDelta(storyState, extract.storyDelta, options.pageIndex)
      : storyState;
    report = withStoryContradictions(
      report,
      [],
      unpaidPromiseIssues(stateForUnpaid, options.pageIndex, options.input.targetPages)
    );
  }

  if (quality.enabled("claimVerifier") && hasResearchIntent(options.input)) {
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
      console.warn(`Claim verifier skipped for project ${options.projectId} page ${options.pageIndex}`, error);
    }
  }

  if (quality.enabled("styleAuditor") && styleExcerpts.length > 0) {
    try {
      const audit = await auditPageStyle({
        textModel: options.textModel,
        markdown: options.draft.markdown,
        voiceGuide: options.plan.voiceGuide,
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

  return { report, extract, storyState, styleExcerpts };
}

export function storyStateLinesForPack(state: StoryState): string[] {
  return formatStoryStateLines(state);
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

export async function persistKeeperStoryDelta(options: {
  projectId: string;
  pageIndex: number;
  draft: PageDraft;
  textModel: TextModelAdapter;
  plan: BookPlan;
  input: CreateProjectInput;
  previousExtract: StoryExtractResult | null;
  keeperWasRevised: boolean;
  currentState: StoryState;
}): Promise<void> {
  const quality = await loadQualityContext(options.input);
  if (!quality.enabled("storyExtractAudit")) {
    return;
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
      return;
    }
  }
  await persistPageStoryDelta({
    projectId: options.projectId,
    pageIndex: options.pageIndex,
    delta: extract.storyDelta,
    seedPromises: options.plan.promises ?? []
  });
}
