import {
  applyExactReplacement,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type ExactReplacement,
  type PageDraft,
  type PageQualityReport,
  type PriorPageContext,
  type ProviderSet
} from "@book-maker/core";
import { prisma } from "@book-maker/db";

import { parseChapterBrief, styleExcerptsForPage, toPriorPageContext } from "./bookHelpers.js";
import { loadContinuityNotes } from "./generationContext.js";
import {
  reviewPageWithQualityGates,
  revisePageDraftWithRestart,
  runPageQualityLoop
} from "./pageReview.js";
import { type QualityGateContext } from "./qualityEnrichment.js";

/**
 * Mechanical and model-backed in-place page rewrites for a reader-requested
 * text edit. Shared by `draftTextEditCandidates`; lived on the replan handler
 * only because that is where the first caller grew.
 */

export function locallyPatchedPage(
  page: { title: string; markdown: string; summary: string; imagePrompt: string | null; qualityReport: unknown },
  replacement: ExactReplacement
): PageDraft & { qualityReport: PageQualityReport } {
  const markdown = applyExactReplacement(page.markdown, replacement);
  return {
    title: applyExactReplacement(page.title, replacement),
    markdown,
    summary: applyExactReplacement(page.summary, replacement),
    imagePrompt: page.imagePrompt ?? undefined,
    continuityNotes: [],
    qualityReport: {
      approved: true,
      score: 90,
      issues: [],
      requiredRevisions: [],
      notes: "Applied exact user-requested text replacement.",
      groundedOk: true,
      unsupportedClaims: [],
      checks: {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: true
      }
    }
  };
}

export async function rewritePageForUserRequest(options: {
  projectId: string;
  page: {
    id: string;
    index: number;
    title: string;
    markdown: string;
    summary: string;
    imagePrompt: string | null;
    chapterId: string | null;
    chapter?: { index: number; productionBrief: unknown } | null;
  };
  input: CreateProjectInput;
  plan: BookPlan;
  strategy: BookGenerationStrategy;
  providers: ProviderSet;
  request: string;
  /** Durable approved instruction, explicit in every revision prompt. */
  editInstruction?: string | undefined;
  /** Prompt-only character canon, never part of the approved instruction. */
  characterContext?: string | undefined;
  /** Supplemental guidance scoped to this page; never authoritative over editInstruction. */
  pageEditGuidance?: string | undefined;
  /** In-memory earlier drafts from the same multi-page edit. */
  priorPageOverrides?: PriorPageContext[] | undefined;
  /** Concrete omissions returned by the operation-level adherence reviewer. */
  adherenceRepair?: string[] | undefined;
  /** Candidate budget owned by the operation-level loop. */
  maxCandidates?: number | undefined;
  /**
   * The edit's own quality context, loaded once by `applyBookEdit` and handed
   * to every page it touches. Loaded per page, a ten-page edit read the
   * operator's gates ten times, and a Quality-tab save landing mid-edit ran one
   * edit under two different configurations — the same split a compile fixed by
   * hoisting one context above its passes.
   */
  quality: QualityGateContext;
  generationJobId?: string | undefined;
  /**
   * Called as the page moves between writing and reading back, so the caller
   * can report which of the two the reader is waiting on. Rewriting a page is
   * two long model calls, and one label over both of them reads as a stall.
   */
  onPhase?: ((phase: "draft" | "review") => Promise<void>) | undefined;
}): Promise<PageDraft & { qualityReport: PageQualityReport }> {
  const previousPages = await prisma.page.findMany({
    where: { projectId: options.projectId, index: { lt: options.page.index }, status: "COMPLETED" },
    orderBy: { index: "desc" },
    take: 18
  });
  const priorPageContextByIndex = new Map(previousPages.reverse().map(toPriorPageContext).map((page) => [page.index, page]));
  for (const page of options.priorPageOverrides ?? []) {
    if (page.index < options.page.index) {
      priorPageContextByIndex.set(page.index, page);
    }
  }
  const priorPageContext = [...priorPageContextByIndex.values()]
    .sort((left, right) => left.index - right.index)
    .slice(-18);
  // Whole book: a chat rewrite lands in finished prose, so notes after this
  // page are continuity the draft must still honour.
  const continuityNotes = await loadContinuityNotes(options.projectId, { beforePageIndex: null });
  const chapterPlan = options.plan.chapters.find((chapter) => chapter.index === options.page.chapter?.index);
  const chapterBrief = parseChapterBrief(options.page.chapter?.productionBrief);
  const pageBrief = chapterBrief?.pages.find((brief) => brief.pageIndex === options.page.index);
  // The same style lock a generated page reviews against. A chat rewrite lands
  // mid-book among pages that were excerpt-anchored at generation, and this
  // path used to carry no excerpts and never run the style auditor — the one
  // guard that catches register drift the general reviewer approves, missing
  // from exactly the request ("make page 12 more dramatic") most likely to
  // produce it. That request now travels with the lock, because it is also the
  // one request against which a register shift is the *point*.
  const quality = options.quality;
  const styleExcerpts = await styleExcerptsForPage({
    projectId: options.projectId,
    pageIndex: options.page.index,
    recencyPages: priorPageContext,
    input: options.input,
    quality
  });
  const editInstruction = options.editInstruction?.trim() || options.request;
  const pageEditGuidance = options.pageEditGuidance?.trim();
  const report: PageQualityReport = {
    approved: false,
    score: 50,
    issues: [
      `User requested this page edit: ${editInstruction}`,
      ...(pageEditGuidance ? [`Page-local guidance: ${pageEditGuidance}`] : []),
      ...(options.adherenceRepair ?? []).map((missing) => `The previous candidate missed: ${missing}`)
    ],
    requiredRevisions: [
      "Revise the existing page to satisfy the user's requested edit.",
      "Keep the same page role and overall book structure unless the request explicitly requires otherwise.",
      "Return a complete replacement page draft, not a diff."
    ],
    notes: "User-requested book edit.",
    groundedOk: true,
    unsupportedClaims: [],
    checks: {
      placeholderFree: true,
      promptLeakFree: true,
      titleClean: true,
      repetitionOk: true,
      progressionOk: true,
      styleNatural: true
    }
  };
  const draft = await revisePageDraftWithRestart({
    strategy: options.strategy,
    generationJobId: options.generationJobId,
    progress: 62,
    context: `User edit page ${options.page.index}`,
    reviseOptions: {
      input: options.input,
      plan: options.plan,
      chapter: chapterPlan,
      chapterBrief,
      pageBrief,
      pageIndex: options.page.index,
      draft: {
        title: options.page.title,
        markdown: options.page.markdown,
        summary: options.page.summary,
        imagePrompt: options.page.imagePrompt ?? undefined,
        continuityNotes: []
      },
      report,
      editInstruction,
      ...(options.characterContext ? { characterContext: options.characterContext } : {}),
      ...(pageEditGuidance ? { pageEditGuidance } : {}),
      ...(options.adherenceRepair?.length ? { adherenceRepair: options.adherenceRepair } : {}),
      previousPages: priorPageContext,
      continuityNotes,
      textModel: options.providers.text,
      ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
    }
  });
  await options.onPhase?.("review");
  const initialReport = await reviewPageWithQualityGates({
    strategy: options.strategy,
    quality,
    reviewOptions: {
      input: options.input,
      plan: options.plan,
      chapter: chapterPlan,
      chapterBrief,
      pageBrief,
      pageIndex: options.page.index,
      draft,
      previousPages: priorPageContext,
      continuityNotes,
      textModel: options.providers.text,
      ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
    }
  });
  // A rejected rewrite used to be stored as-is with its report ignored. Give
  // it the same bounded revise → re-review loop a generated page gets, with a
  // smaller budget — the requested edit is already in the draft, so revisions
  // must repair quality without undoing it, which `userRequest` pins down. An
  // approved rewrite goes through the same call rather than returning early:
  // the loop is what audits an approved report, this one included, and it
  // returns it untouched when the audit is clean.
  const outcome = await runPageQualityLoop({
    projectId: options.projectId,
    strategy: options.strategy,
    input: options.input,
    plan: options.plan,
    chapter: chapterPlan,
    chapterBrief,
    pageBrief,
    pageIndex: options.page.index,
    draft,
    report: initialReport,
    previousPages: priorPageContext,
    continuityNotes,
    textModel: options.providers.text,
    generationJobId: options.generationJobId,
    maxCandidates: options.maxCandidates ?? USER_EDIT_MAX_CANDIDATES,
    repairBrief: false,
    reviseContext: `User edit page ${options.page.index}`,
    reviseProgress: 62,
    quality,
    userRequest: editInstruction,
    ...(options.characterContext ? { characterContext: options.characterContext } : {}),
    ...(pageEditGuidance ? { pageEditGuidance } : {}),
    ...(styleExcerpts.length > 0 ? { styleExcerpts } : {}),
    onRewrite: async () => {
      await options.onPhase?.("draft");
    }
  });
  return { ...outcome.draft, qualityReport: outcome.report };
}

/**
 * Smaller than a generated page's budget: the edit was priced as one rewrite,
 * so a stubborn page gets two extra attempts, not six.
 */
const USER_EDIT_MAX_CANDIDATES = 3;
