import { formatQualityFailure } from "./bookHelpers.js";
import { enqueueWorkerJob } from "../runtime/dispatch.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { type IndexedPageDraft } from "../runtime/jobTypes.js";
import { uniqueStrings } from "../runtime/serialization.js";
import { loadContinuityNotes } from "./generationContext.js";
import { storeEmbedding, updateEntityStateFromPage } from "./semanticMemory.js";
import {
  MAX_PAGE_QA_CANDIDATES,
  MAX_PAGE_QA_REWRITE_ATTEMPTS,
  MAX_PAGE_REVISE_RESTARTS,
  PAGE_QA_RECOVERY_CANDIDATE
} from "./tuning.js";
import {
  type BookGenerationStrategy,
  type BookPlan,
  type ChapterBrief,
  type ChapterPlan,
  type CreateProjectInput,
  type PageDraft,
  type PageProductionBeat,
  type PageQualityReport,
  type PriorPageContext,
  type ProviderSet,
  type RevisePageOptions,
  type TextModelAdapter
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";

/**
 * Page quality review loop: score a draft, revise it, and save the best candidate.
 */

export type DraftCandidate = { draft: PageDraft; revision: number; report: PageQualityReport };

/**
 * A rewrite is not guaranteed to improve: the sixth attempt can score below the
 * second. Every review loop keeps its keeper through this one comparison so a
 * failed page is saved at its strongest draft, not its latest.
 */
export function bestDraftCandidate(best: DraftCandidate, candidate: DraftCandidate): DraftCandidate {
  return candidate.report.score > best.report.score ? candidate : best;
}

export async function reviewAndSaveGeneratedPage(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  draft: IndexedPageDraft;
  chapterId: string | null;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  previousPages: PriorPageContext[];
  generationJobId?: string | undefined;
}): Promise<PriorPageContext> {
  let pageBrief = options.chapterBrief?.pages.find((brief) => brief.pageIndex === options.draft.index);
  const continuityNotes = await loadContinuityNotes(options.projectId);
  let revision = 1;
  let draft: PageDraft = options.draft;
  let qualityReport = await options.strategy.reviewPageDraft({
    input: options.input,
    plan: options.plan,
    chapter: options.chapter,
    chapterBrief: options.chapterBrief,
    pageBrief,
    chapterPageStart: options.chapterPageStart,
    chapterPageEnd: options.chapterPageEnd,
    pageIndex: options.draft.index,
    draft,
    previousPages: options.previousPages,
    continuityNotes,
    textModel: options.providers.text
  });
  let best = { draft, revision, report: qualityReport };

  while (!qualityReport.approved && revision < MAX_PAGE_QA_CANDIDATES) {
    const nextRevision = revision + 1;
    await updateJobProgress(options.generationJobId, {
      message: pageRevisionMessage(options.draft.index, nextRevision, MAX_PAGE_QA_REWRITE_ATTEMPTS)
    });
    if (shouldRepairPageBriefForRecovery(nextRevision, qualityReport, pageBrief)) {
      pageBrief = await repairPageBriefForRecovery({
        strategy: options.strategy,
        input: options.input,
        plan: options.plan,
        chapter: options.chapter,
        chapterBrief: options.chapterBrief,
        chapterPageStart: options.chapterPageStart,
        chapterPageEnd: options.chapterPageEnd,
        chapterId: options.chapterId,
        pageBrief,
        pageIndex: options.draft.index,
        draft,
        qualityReport,
        previousPages: options.previousPages,
        continuityNotes,
        textModel: options.providers.text,
        generationJobId: options.generationJobId,
        context: `Page ${options.draft.index}`
      });
    }
    draft = await revisePageDraftWithRestart({
      strategy: options.strategy,
      generationJobId: options.generationJobId,
      context: `Page ${options.draft.index}`,
      reviseOptions: {
        input: options.input,
        plan: options.plan,
        chapter: options.chapter,
        chapterBrief: options.chapterBrief,
        pageBrief,
        chapterPageStart: options.chapterPageStart,
        chapterPageEnd: options.chapterPageEnd,
        pageIndex: options.draft.index,
        draft,
        report: pageRewriteReport(qualityReport, nextRevision),
        previousPages: options.previousPages,
        continuityNotes,
        textModel: options.providers.text
      }
    });
    revision = nextRevision;
    qualityReport = await options.strategy.reviewPageDraft({
      input: options.input,
      plan: options.plan,
      chapter: options.chapter,
      chapterBrief: options.chapterBrief,
      pageBrief,
      chapterPageStart: options.chapterPageStart,
      chapterPageEnd: options.chapterPageEnd,
      pageIndex: options.draft.index,
      draft,
      previousPages: options.previousPages,
      continuityNotes,
      textModel: options.providers.text
    });
    best = bestDraftCandidate(best, { draft, revision, report: qualityReport });
  }

  if (!qualityReport.approved) {
    // Page-level failure isolation: keep the best draft with its honest
    // report, flag the page, and let the rest of the book continue. The
    // compile-time final review repairs FAILED_QA pages before export.
    draft = best.draft;
    revision = best.revision;
    qualityReport = best.report;
    await updateJobProgress(options.generationJobId, {
      message: `Page ${options.draft.index} kept its best draft but failed quality review; the final review will repair it. ${formatQualityFailure(options.draft.index, qualityReport)}`
    });
  }

  const pageStatus = qualityReport.approved ? "COMPLETED" : "FAILED_QA";
  const page = await prisma.page.upsert({
    where: { projectId_index: { projectId: options.projectId, index: options.draft.index } },
    create: {
      projectId: options.projectId,
      chapterId: options.chapterId,
      index: options.draft.index,
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary,
      imagePrompt: draft.imagePrompt ?? null,
      status: pageStatus,
      revision,
      qualityReport: qualityReport as Prisma.InputJsonValue
    },
    update: {
      chapterId: options.chapterId,
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary,
      imagePrompt: draft.imagePrompt ?? null,
      status: pageStatus,
      revision,
      qualityReport: qualityReport as Prisma.InputJsonValue
    }
  });

  if (!qualityReport.approved) {
    // Skip continuity notes, embeddings, and illustration for a flagged page;
    // the final review rewrites it and the repaired version feeds those steps.
    return {
      index: options.draft.index,
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary
    };
  }

  if (draft.continuityNotes.length > 0) {
    await prisma.continuityNote.createMany({
      data: draft.continuityNotes.map((body) => ({
        projectId: options.projectId,
        scope: `page:${options.draft.index}`,
        body,
        tags: ["page", String(options.draft.index), options.strategy.id]
      }))
    });
    await updateEntityStateFromPage(options.projectId, options.draft.index, draft.continuityNotes);
  }

  await storeEmbedding(options.projectId, `page:${options.draft.index}`, page.id, draft.summary, options.providers.embedding);

  if (draft.imagePrompt && options.strategy.shouldIllustratePage(options.input, options.plan, options.draft.index)) {
    await enqueueWorkerJob({
      projectId: options.projectId,
      type: "GENERATE_IMAGE",
      name: "generate-image",
      payload: { pageId: page.id, planId: options.planId, prompt: draft.imagePrompt },
      dedupeKey: `generate-image:${page.id}:${options.planId}:${page.revision}`
    });
  }

  return {
    index: options.draft.index,
    title: draft.title,
    markdown: draft.markdown,
    summary: draft.summary
  };
}

export async function revisePageDraftWithRestart(options: {
  strategy: BookGenerationStrategy;
  reviseOptions: RevisePageOptions;
  context: string;
  generationJobId?: string | undefined;
  progress?: number | undefined;
  maxRestarts?: number | undefined;
}): Promise<PageDraft> {
  const maxRestarts = options.maxRestarts ?? MAX_PAGE_REVISE_RESTARTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRestarts + 1; attempt += 1) {
    try {
      return await options.strategy.revisePageDraft(options.reviseOptions);
    } catch (error) {
      lastError = error;
      if (attempt > maxRestarts) {
        throw error;
      }

      await updateJobProgress(options.generationJobId, {
        ...(options.progress !== undefined ? { progress: options.progress } : {}),
        message: `${options.context} revise failed; restarting with the generated page and revision (${attempt + 1}/${
          maxRestarts + 1
        }).`
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${options.context} revise failed.`);
}

export function pageRevisionMessage(pageIndex: number, revision: number, maxRewriteAttempts: number): string {
  const phase = revision >= PAGE_QA_RECOVERY_CANDIDATE ? "Quality recovery rewrite" : "Revising";
  const rewriteAttempt = Math.max(1, revision - 1);
  return `${phase} page ${pageIndex} (rewrite ${rewriteAttempt}/${maxRewriteAttempts})`;
}

export function pageRewriteReport(
  report: PageQualityReport,
  revision: number,
  recoveryRevision = PAGE_QA_RECOVERY_CANDIDATE
): PageQualityReport {
  if (revision < recoveryRevision) {
    return report;
  }

  const recoveryInstructions = [
    `Previous rewrite attempts still failed QA; produce a complete replacement page for attempt ${revision}.`,
    "Use the rejected page only as diagnostic context, not as prose to preserve.",
    "Do not relax quality: satisfy the page brief, advance beyond prior pages, avoid repetition, and keep the page reader-ready."
  ];

  return {
    ...report,
    issues: [...report.issues, "Earlier generated replacements for this page were still rejected by QA."],
    requiredRevisions: [...report.requiredRevisions, ...recoveryInstructions],
    notes: [report.notes, "Quality recovery mode: make a structural replacement rather than a light edit."]
      .filter(Boolean)
      .join(" ")
  };
}

export function shouldRepairPageBriefForRecovery(
  revision: number,
  report: PageQualityReport,
  pageBrief: PageProductionBeat | undefined
): pageBrief is PageProductionBeat {
  if (!pageBrief || revision < PAGE_QA_RECOVERY_CANDIDATE) {
    return false;
  }

  if (!report.checks.repetitionOk || !report.checks.progressionOk) {
    return true;
  }

  const feedback = [...report.issues, ...report.requiredRevisions, report.notes].join(" ").toLowerCase();
  return /brief|assignment|repeat|repetition|already covered|same (argument|beat|point|scene)|stalled|does not progress|new distinct|fresh angle/.test(
    feedback
  );
}

export async function repairPageBriefForRecovery(options: {
  strategy: BookGenerationStrategy;
  input: CreateProjectInput;
  plan: BookPlan;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  chapterId?: string | null | undefined;
  pageBrief: PageProductionBeat;
  pageIndex: number;
  draft: PageDraft;
  qualityReport: PageQualityReport;
  previousPages: PriorPageContext[];
  continuityNotes: string[];
  textModel: TextModelAdapter;
  generationJobId?: string | undefined;
  context: string;
}): Promise<PageProductionBeat> {
  await updateJobProgress(options.generationJobId, {
    message: `${options.context} brief conflict detected; repairing page brief before recovery rewrite.`
  });

  const repaired = await options.strategy.repairPageBrief({
    input: options.input,
    plan: options.plan,
    chapter: options.chapter,
    chapterBrief: options.chapterBrief,
    pageBrief: options.pageBrief,
    chapterPageStart: options.chapterPageStart,
    chapterPageEnd: options.chapterPageEnd,
    pageIndex: options.pageIndex,
    draft: options.draft,
    report: options.qualityReport,
    previousPages: options.previousPages,
    continuityNotes: options.continuityNotes,
    textModel: options.textModel
  });

  const updatedChapterBrief = replacePageBriefInChapterBrief(options.chapterBrief, repaired);
  if (options.chapterId && updatedChapterBrief) {
    await prisma.chapter.update({
      where: { id: options.chapterId },
      data: { productionBrief: updatedChapterBrief as Prisma.InputJsonValue }
    });
  }

  return repaired;
}

export function replacePageBriefInChapterBrief(
  chapterBrief: ChapterBrief | undefined,
  repaired: PageProductionBeat
): ChapterBrief | undefined {
  if (!chapterBrief) {
    return undefined;
  }

  const replaced = chapterBrief.pages.some((page) => page.pageIndex === repaired.pageIndex);
  const updated: ChapterBrief = {
    ...chapterBrief,
    pages: replaced
      ? chapterBrief.pages.map((page) => (page.pageIndex === repaired.pageIndex ? repaired : page))
      : [...chapterBrief.pages, repaired].sort((a, b) => a.pageIndex - b.pageIndex),
    continuityFocus: uniqueStrings([...chapterBrief.continuityFocus, ...repaired.requiredContinuity]).slice(0, 20)
  };
  Object.assign(chapterBrief, updated);
  return updated;
}
