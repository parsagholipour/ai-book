import {
  continuationChapterPlans,
  continuationOutlineAiSchema,
  continuationPageIndexes,
  distributeContinuationPages,
  fallbackContinuationOutline,
  type ContinuationOutline,
  CONTINUATION_EXCERPT_GUARD
} from "./continueBookSupport.js";
import {
  getProjectOrThrow,
  invalidateProjectExports,
  nextPlanVersion,
  planInputSnapshot,
  strategyForInput,
  styleExcerptsForPage,
  toPriorPageContext
} from "../generation/bookHelpers.js";
import { loadContinuityNotes, loadResearchNotesForGeneration } from "../generation/generationContext.js";
import { reviewAndSaveGeneratedPage } from "../generation/pageReview.js";
import { importStyleProfileFromMediaSettings } from "./importBookSupport.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { loadQualityContext } from "../generation/qualitySettings.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { errorMessage } from "../runtime/serialization.js";
import { bookPlanSchema, createProviders, generateJsonWithRetry, type BookPlan, type TextModelAdapter } from "@book-maker/core";
import { pageScope, prisma } from "@book-maker/db";
import { Job } from "bullmq";

/**
 * `continue-book` job: outline and write additional chapters onto a finished book.
 */

export async function continueBook(job: Job) {
  const { projectId, operationId, request, planId } = job.data as {
    projectId: string;
    operationId: string;
    request: string;
    planId?: string;
  };
  const generationJobId = job.data.generationJobId as string | undefined;
  const chapterCount = Math.min(8, Math.max(1, Math.floor(Number(job.data.chapterCount) || 1)));
  const requestedPageCount = Math.max(chapterCount, Math.floor(Number(job.data.newPageCount) || chapterCount * 5));

  const operation = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
  if (!operation) {
    throw new Error("Book edit operation not found");
  }
  if (operation.status === "APPLIED") {
    // A previous delivery finished the whole append — the operation is only
    // marked APPLIED once every page is saved — and crashed before its durable
    // COMPLETED write. The book already contains this continuation; running
    // again would append it a second time. Replay only the idempotent success
    // tail so the exports are rebuilt from the delivered chapters.
    const appliedProject = await getProjectOrThrow(projectId);
    if (!appliedProject.currentPlanId) {
      throw new Error("Current plan not found");
    }
    await prisma.project.update({
      where: { id: projectId },
      data: { status: "COMPLETE", contentRevision: { increment: 1 } }
    });
    await invalidateProjectExports(projectId);
    await maybeEnqueueCompile(projectId, appliedProject.currentPlanId);
    return;
  }
  await prisma.bookEditOperation.update({ where: { id: operationId }, data: { status: "ACTIVE" } });
  await prisma.project.update({ where: { id: projectId }, data: { status: "EDITING" } });
  await advanceJobStep(generationJobId, "outline", 15, "Outlining new chapters");

  let project = await getProjectOrThrow(projectId);
  const basePlanVersion = planId
    ? await prisma.planVersion.findUnique({ where: { id: planId } })
    : project.currentPlanId
      ? await prisma.planVersion.findUnique({ where: { id: project.currentPlanId } })
      : null;
  if (!basePlanVersion) {
    throw new Error("Current plan not found");
  }
  const input = inputForPlanVersion(project, basePlanVersion.inputSnapshot);
  const plan = bookPlanSchema.parse(basePlanVersion.planningPackage);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  const quality = await loadQualityContext(input);

  // --- Redelivery fence ------------------------------------------------------
  // The pre-continuation boundary is the plan named by the payload's `planId`,
  // recorded at enqueue time (the API stamps the then-current plan). It is the
  // safest durable fence available: generation, import and a *completed*
  // continuation all write chapters and plan together in one transaction, so
  // every chapter the book legitimately owns appears in that plan. Chapter
  // rows past its last index can only be a previous delivery of this job that
  // crashed mid-append — recomputing `lastPageIndex` over them (and reading
  // their drafted pages as trailing context) would append a SECOND
  // continuation on top. Clean them up so this delivery rebuilds the
  // continuation exactly once, from the original book state.
  const baseChapterBoundary = plan.chapters.at(-1)?.index ?? 0;
  const strandedChapters = await prisma.chapter.findMany({
    where: { projectId, index: { gt: baseChapterBoundary } },
    select: { id: true }
  });
  if (strandedChapters.length > 0) {
    const strandedChapterIds = strandedChapters.map((chapter) => chapter.id);
    const strandedPages = await prisma.page.findMany({
      where: { projectId, chapterId: { in: strandedChapterIds } },
      select: { index: true }
    });
    const strandedPlanId =
      project.currentPlanId && project.currentPlanId !== basePlanVersion.id ? project.currentPlanId : null;
    if (strandedPlanId) {
      // Only a plan the crashed attempt wrote may be deleted; its messages
      // carry the marker `continueBook` itself writes. Anything else past the
      // base plan is a state this job does not understand — fail instead of
      // guessing, and let the normal failure path settle the charge.
      const strandedPlan = await prisma.planVersion.findUnique({
        where: { id: strandedPlanId },
        select: { messages: true }
      });
      const marker = `Continue the book: ${request}`.slice(0, 2000);
      const strandedMessages = strandedPlan && Array.isArray(strandedPlan.messages) ? strandedPlan.messages : [];
      const looksLikeOwnAppend = strandedMessages.some(
        (message) =>
          typeof message === "object" && message !== null && (message as { content?: unknown }).content === marker
      );
      if (!looksLikeOwnAppend) {
        throw new Error("Found chapters past the current plan that this continuation does not own");
      }
    }
    await prisma.$transaction(async (tx) => {
      await tx.page.deleteMany({ where: { projectId, chapterId: { in: strandedChapterIds } } });
      await tx.chapter.deleteMany({ where: { projectId, index: { gt: baseChapterBoundary } } });
      await tx.embedding.deleteMany({
        where: { projectId, scope: { in: strandedPages.map((page) => pageScope(page.index)) } }
      });
      await tx.project.update({
        where: { id: projectId },
        // `input.targetPages` is the base plan snapshot's page count — the
        // value the project held before the crashed append inflated it.
        data: { currentPlanId: basePlanVersion.id, targetPages: input.targetPages }
      });
      await tx.planVersion.update({ where: { id: basePlanVersion.id }, data: { status: "APPROVED" } });
      if (strandedPlanId) {
        await tx.planVersion.deleteMany({ where: { id: strandedPlanId, projectId } });
      }
    });
    // Re-read: the row's targetPages (used by the compensation below) and
    // currentPlanId just changed.
    project = await getProjectOrThrow(projectId);
  }

  const trailingPagesDesc = await prisma.page.findMany({
    where: { projectId, status: "COMPLETED" },
    orderBy: { index: "desc" },
    take: 12
  });
  if (trailingPagesDesc.length === 0) {
    throw new Error("This book has no finished pages to continue from");
  }
  const lastPageIndex =
    (await prisma.page.findFirst({ where: { projectId }, orderBy: { index: "desc" }, select: { index: true } }))
      ?.index ?? 0;
  const lastChapterIndex =
    (await prisma.chapter.findFirst({ where: { projectId }, orderBy: { index: "desc" }, select: { index: true } }))
      ?.index ?? plan.chapters.length;
  const startChapterIndex = Math.max(lastChapterIndex, plan.chapters.at(-1)?.index ?? 0) + 1;
  const trailingPages = [...trailingPagesDesc].reverse();
  const styleProfile = importStyleProfileFromMediaSettings(project.mediaSettings);

  const outline = await continuationOutlineWithModel({
    plan,
    request,
    chapterCount,
    styleProfile,
    trailingPages,
    language: project.language,
    textModel: providers.text
  });
  const pageDistribution = distributeContinuationPages(requestedPageCount, outline.chapters.length);
  const newChapterPlans = continuationChapterPlans(plan, outline, pageDistribution, startChapterIndex);
  const newPageIndexes = continuationPageIndexes(lastPageIndex, pageDistribution);
  const extendedPlan = bookPlanSchema.parse({ ...plan, chapters: [...plan.chapters, ...newChapterPlans] });
  const totalPages = lastPageIndex + newPageIndexes.length;

  const version = await nextPlanVersion(projectId);
  const newPlanVersion = await prisma.$transaction(async (tx) => {
    await tx.planVersion.update({ where: { id: basePlanVersion.id }, data: { status: "SUPERSEDED" } });
    const created = await tx.planVersion.create({
      data: {
        projectId,
        version,
        status: "APPROVED",
        approvedAt: new Date(),
        planningPackage: extendedPlan,
        inputSnapshot: planInputSnapshot({ ...input, targetPages: totalPages }),
        messages: [
          { role: "user", content: `Continue the book: ${request}`.slice(0, 2000), at: new Date().toISOString() }
        ]
      }
    });
    await tx.project.update({
      where: { id: projectId },
      data: { currentPlanId: created.id, targetPages: totalPages }
    });
    let pageCursor = lastPageIndex;
    for (const chapterPlan of newChapterPlans) {
      const chapter = await tx.chapter.create({
        data: {
          projectId,
          index: chapterPlan.index,
          title: chapterPlan.title,
          summary: chapterPlan.summary,
          targetPages: chapterPlan.targetPages,
          status: "PENDING"
        }
      });
      await tx.page.createMany({
        data: Array.from({ length: chapterPlan.targetPages }, (_, offset) => ({
          projectId,
          chapterId: chapter.id,
          index: pageCursor + offset + 1,
          title: `Page ${pageCursor + offset + 1}`,
          markdown: "",
          summary: "",
          status: "PENDING"
        }))
      });
      pageCursor += chapterPlan.targetPages;
    }
    return created;
  });

  try {
    await advanceJobStep(generationJobId, "draft", 30, "Writing new pages", {
      done: 0,
      total: newPageIndexes.length
    });
    // Whole book: a continuation is written past the last page, so nothing the
    // project holds is ahead of it.
    const continuityNotes = await loadContinuityNotes(projectId, { beforePageIndex: null });
    const earlierSummaries = await prisma.page.findMany({
      where: { projectId, index: { lte: lastPageIndex }, status: "COMPLETED" },
      orderBy: { index: "asc" },
      select: { summary: true }
    });
    const previousSummaries = earlierSummaries.map((page) => page.summary).filter(Boolean).slice(-40);
    const previousPages = trailingPages.map(toPriorPageContext);

    let drafted = 0;
    for (const chapterPlan of newChapterPlans) {
      const chapter = await prisma.chapter.findUnique({
        where: { projectId_index: { projectId, index: chapterPlan.index } }
      });
      const researchNotes = await loadResearchNotesForGeneration(projectId, strategy, chapterPlan);
      for (let offset = 0; offset < chapterPlan.targetPages; offset += 1) {
        const pageIndex = newPageIndexes[drafted]!;
        await advanceJobStep(
          generationJobId,
          "draft",
          30 + Math.round((drafted / Math.max(newPageIndexes.length, 1)) * 45),
          `Writing page ${pageIndex}`,
          { done: drafted, total: newPageIndexes.length, pageIndex }
        );
        const priorPageContext = previousPages.slice(-6);
        const styleExcerpts = await styleExcerptsForPage({
          projectId,
          pageIndex,
          recencyPages: priorPageContext,
          input,
          quality
        });
        const draft = await strategy.generatePageDraft({
          input,
          plan: extendedPlan,
          chapter: chapterPlan,
          pageIndex,
          previousSummaries: [...previousSummaries, ...previousPages.map((page) => page.summary)].slice(-40),
          previousPages: priorPageContext,
          continuityNotes,
          researchNotes,
          textModel: providers.text,
          ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
        });
        // The same review → revise loop, honest FAILED_QA status, continuity
        // notes and entity state every generated page gets — a continuation
        // used to skip all of it and save drafts sight unseen. Illustration
        // stays off: the continuation charge never priced images.
        const saved = await reviewAndSaveGeneratedPage({
          projectId,
          planId: newPlanVersion.id,
          input,
          plan: extendedPlan,
          providers,
          strategy,
          draft: { ...draft, index: pageIndex },
          chapterId: chapter?.id ?? null,
          chapter: chapterPlan,
          previousPages: previousPages.slice(-18),
          generationJobId,
          illustrate: false
        });
        previousPages.push(saved);
        drafted += 1;
      }
      if (chapter) {
        await prisma.chapter.update({ where: { id: chapter.id }, data: { status: "COMPLETED" } });
      }
    }

    await advanceJobStep(generationJobId, "save", 82, "Saving chapters");
    await prisma.bookEditOperation.update({
      where: { id: operationId },
      data: { status: "APPLIED", affectedPageIndexes: newPageIndexes, appliedAt: new Date() }
    });
    await prisma.project.update({
      where: { id: projectId },
      data: { status: "COMPLETE", contentRevision: { increment: 1 } }
    });
    await advanceJobStep(generationJobId, "export", 90, "Refreshing exports");
    await invalidateProjectExports(projectId);
    await maybeEnqueueCompile(projectId, newPlanVersion.id);
  } catch (error) {
    // Roll the append back so a retry starts from the original book state.
    await prisma
      .$transaction(async (tx) => {
        await tx.page.deleteMany({ where: { projectId, index: { gt: lastPageIndex } } });
        await tx.chapter.deleteMany({ where: { projectId, index: { gte: startChapterIndex } } });
        await tx.embedding.deleteMany({
          where: { projectId, scope: { in: newPageIndexes.map((index) => pageScope(index)) } }
        });
        await tx.project.update({
          where: { id: projectId },
          data: { currentPlanId: basePlanVersion.id, targetPages: project.targetPages }
        });
        await tx.planVersion.update({ where: { id: basePlanVersion.id }, data: { status: "APPROVED" } });
        await tx.planVersion.delete({ where: { id: newPlanVersion.id } });
      })
      .catch((cleanupError) => {
        console.error(`Continuation cleanup failed for project ${projectId}`, cleanupError);
      });
    // The failure may land after the operation was marked APPLIED (the export
    // refresh above), and the compensation just deleted the pages that verdict
    // names. `failEditOperation` on the failure path only claims QUEUED/ACTIVE
    // rows, so without this the operation stayed APPLIED forever, reporting a
    // continuation the book does not contain. Guarded on APPLIED so the normal
    // QUEUED/ACTIVE settlement — whose claim is what gates the legacy refund —
    // is left untouched, and refunds stay with the attempt settlement.
    await prisma.bookEditOperation
      .updateMany({
        where: { id: operationId, status: "APPLIED" },
        data: { status: "FAILED", error: errorMessage(error), affectedPageIndexes: [] }
      })
      .catch((flipError) => {
        console.error(`Failed to mark rolled-back continuation ${operationId} FAILED`, flipError);
      });
    throw error;
  }
}

export async function continuationOutlineWithModel(options: {
  plan: BookPlan;
  request: string;
  chapterCount: number;
  styleProfile: Record<string, unknown> | null;
  trailingPages: Array<{ index: number; title: string; markdown: string; summary: string }>;
  language: string;
  textModel: TextModelAdapter;
}): Promise<ContinuationOutline> {
  const excerpt = options.trailingPages
    .slice(-2)
    .map((page) => `Page ${page.index} — ${page.title}\n${page.markdown}`)
    .join("\n\n")
    .slice(-6000);
  const recentSummaries = options.trailingPages.map((page) => `${page.index}: ${page.summary}`).join("\n");
  try {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: "generate-chapter-brief",
      temperature: 0.4,
      maxTokens: 1600,
      schema: continuationOutlineAiSchema,
      messages: [
        {
          role: "system",
          content:
            `You outline the next chapters of an existing book so a writer can continue it in the author's voice. Propose exactly ${options.chapterCount} new chapter(s) that pick up where the book ends and satisfy the author's directive. Write titles and summaries in the book's language ("${options.language}"). ${CONTINUATION_EXCERPT_GUARD}`
        },
        {
          role: "user",
          content: JSON.stringify({
            premise: options.plan.premise,
            voiceGuide: options.plan.voiceGuide,
            existingChapters: options.plan.chapters.map((chapter) => ({
              index: chapter.index,
              title: chapter.title,
              summary: chapter.summary
            })),
            styleProfile: options.styleProfile,
            recentPageSummaries: recentSummaries,
            finalPagesExcerpt: excerpt,
            authorDirective: options.request
          })
        }
      ]
    });
    if (result.data.chapters.length > 0) {
      return { chapters: result.data.chapters.slice(0, options.chapterCount) };
    }
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    console.warn(`Continuation outline model call failed; using fallback`, error);
  }
  return fallbackContinuationOutline(options.request, options.chapterCount);
}
