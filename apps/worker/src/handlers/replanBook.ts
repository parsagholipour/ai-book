import {
  getProjectOrThrow,
  invalidateProjectExports,
  nextPlanVersion,
  parseChapterBrief,
  planInputSnapshot,
  planMediaSettingsSnapshot,
  strategyForInput,
  toPriorPageContext
} from "../generation/bookHelpers.js";
import { loadContinuityNotes } from "../generation/generationContext.js";
import { revisePageDraftWithRestart, runPageQualityLoop } from "../generation/pageReview.js";
import { inputForPlanVersion, inputWithMessageMediaPreferences, inputWithMobileSourceMaterial } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { enqueueWorkerJob } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { seedProjectStoryState } from "../generation/storyStateStore.js";
import { cleanTargetLanguage } from "../runtime/serialization.js";
import {
  applyExactReplacement,
  bookPlanSchema,
  createProviders,
  inputWithReplanSettings,
  mediaSettingsRowWriteback,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type ExactReplacement,
  type PageDraft,
  type PageQualityReport,
  type ProviderSet
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { Job } from "bullmq";

/**
 * `replan-book` job: replace a project's plan and regenerate affected pages.
 */

export async function replanBook(job: Job) {
  const { projectId, operationId, request, planId, sourceProjectId, sourcePlanId, targetLanguage, targetPages } =
    job.data as {
      projectId: string;
      operationId: string;
      request: string;
      planId?: string;
      sourceProjectId?: string;
      sourcePlanId?: string | null;
      targetLanguage?: string | null;
      targetPages?: number | null;
    };
  const generationJobId = job.data.generationJobId as string | undefined;
  await prisma.bookEditOperation.update({ where: { id: operationId }, data: { status: "ACTIVE" } });
  await prisma.project.update({ where: { id: projectId }, data: { status: "EDITING" } });
  await advanceJobStep(generationJobId, "revise", 30, "Rebuilding book plan");

  const targetProject = await getProjectOrThrow(projectId);
  const sourceProject = sourceProjectId && sourceProjectId !== projectId
    ? await getProjectOrThrow(sourceProjectId)
    : targetProject;
  const currentPlanId = sourcePlanId ?? planId ?? sourceProject.currentPlanId;
  if (!currentPlanId) {
    throw new Error("Cannot replan without a current plan");
  }
  const planVersion = await prisma.planVersion.findUnique({ where: { id: currentPlanId }, include: { project: true } });
  if (!planVersion) {
    throw new Error("Current plan not found");
  }
  const requestedLanguage = cleanTargetLanguage(targetLanguage);
  // The plan is revised from the *source* book's input snapshot, so a replan
  // that resizes the book has to say so here: left to the snapshot the planner
  // is told to hit the old length, and normalizePlanPageTargets then pads the
  // revised chapters back up to it even when the model wrote fewer.
  //
  // Only an explicit count overrides it: for an in-place replan the project row
  // holds the length the book actually came out at, which is not what this plan
  // was written against.
  const requestedPages =
    typeof targetPages === "number" && Number.isInteger(targetPages) && targetPages > 0 ? targetPages : null;
  const sourceInput = inputWithMessageMediaPreferences(inputForPlanVersion(sourceProject, planVersion.inputSnapshot), request);
  // Through the shared applier, so a resize also lands in
  // `mediaSettings.mobile.targetPages` — the number the app's settings sheet
  // reads — rather than only on the top-level field.
  const input = inputWithReplanSettings(
    {
      ...sourceInput,
      ...(requestedLanguage ? { language: requestedLanguage } : {})
    },
    requestedPages === null ? null : { targetPages: requestedPages }
  );
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  const currentPlan = bookPlanSchema.parse(planVersion.planningPackage);
  const revised = await strategy.revisePlan({
    currentPlan,
    userMessage: request,
    textModel: providers.text,
    input: inputWithMobileSourceMaterial(input),
    targetPages: input.targetPages,
    temperature: input.temperature,
    language: input.language,
    toneProfile: input.mediaSettings.toneProfile
  });
  const version = await nextPlanVersion(projectId);
  const priorMessages = Array.isArray(planVersion.messages) ? planVersion.messages : [];
  await advanceJobStep(generationJobId, "save", 65, "Saving approved plan");

  let newPlanId = "";
  await prisma.$transaction(async (tx) => {
    if (sourceProject.id === targetProject.id) {
      await tx.planVersion.updateMany({
        where: { projectId, id: { not: currentPlanId } },
        data: { status: "SUPERSEDED" }
      });
      await tx.planVersion.update({ where: { id: currentPlanId }, data: { status: "SUPERSEDED" } });
    } else {
      await tx.planVersion.updateMany({
        where: { projectId },
        data: { status: "SUPERSEDED" }
      });
    }
    const newPlan = await tx.planVersion.create({
      data: {
        projectId,
        version,
        status: "APPROVED",
        approvedAt: new Date(),
        planningPackage: revised,
        inputSnapshot: planInputSnapshot(input),
        messages: [...priorMessages, { role: "user", content: request, at: new Date().toISOString(), source: "book_replan" }]
      }
    });
    newPlanId = newPlan.id;
    // Merged over the live row, never a wholesale replacement: the row owns
    // presentation preferences (and, for a replan copy, its provenance
    // markers) that the plan snapshot has stripped or never had.
    const liveProject = await tx.project.findUnique({
      where: { id: projectId },
      select: { mediaSettings: true }
    });
    await tx.project.update({
      where: { id: projectId },
      data: {
        currentPlanId: newPlan.id,
        status: "GENERATING",
        title: revised.title,
        language: input.language,
        // Written alongside the snapshot the plan was made from, so the row a
        // later edit prices and replans off cannot drift from the book on disk.
        targetPages: input.targetPages,
        mediaSettings: mediaSettingsRowWriteback(
          liveProject?.mediaSettings,
          planMediaSettingsSnapshot(input) as Record<string, unknown>
        ) as Prisma.InputJsonValue
      }
    });
    await replaceProjectPlanReferenceRecords(tx, projectId, revised);
  });

  await seedProjectStoryState(projectId, revised.promises ?? []);
  await invalidateProjectExports(projectId);
  await advanceJobStep(generationJobId, "generate", 85, "Queueing regenerated book");
  const generateJob = await enqueueWorkerJob({
    projectId,
    type: "GENERATE_BOOK",
    dedupeKey: `generate-book:${projectId}:${newPlanId}`,
    payload: {
      planId: newPlanId,
      replanOperationId: operationId,
      billingLedgerEntryId: job.data.billingLedgerEntryId
    }
  });
  if (!generateJob) {
    throw new Error("Could not queue regenerated book");
  }
  await prisma.bookEditOperation.update({
    where: { id: operationId },
    data: {
      status: "APPLIED",
      generationJobId: generateJob.id,
      appliedAt: new Date()
    }
  });
}

export async function replaceProjectPlanReferenceRecords(
  tx: Prisma.TransactionClient,
  projectId: string,
  plan: BookPlan
): Promise<void> {
  await tx.character.deleteMany({ where: { projectId } });
  await tx.location.deleteMany({ where: { projectId } });
  await tx.researchSource.deleteMany({ where: { projectId } });

  if (plan.characters.length > 0) {
    await tx.character.createMany({
      data: plan.characters.map((character) => ({
        projectId,
        name: character.name,
        role: character.role,
        description: character.description,
        traits: character.traits,
        visualRules: character.visualRules
      }))
    });
  }

  if (plan.locations.length > 0) {
    await tx.location.createMany({
      data: plan.locations.map((location) => ({
        projectId,
        name: location.name,
        description: location.description,
        rules: location.rules
      }))
    });
  }

  if (plan.researchNotes.length > 0) {
    await tx.researchSource.createMany({
      data: plan.researchNotes.map((source) => ({
        projectId,
        query: source.query,
        title: source.title,
        url: source.url ?? null,
        summary: source.summary,
        publishedAt: source.publishedAt ? new Date(source.publishedAt) : null
      }))
    });
  }
}

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
  const priorPageContext = previousPages.reverse().map(toPriorPageContext);
  const continuityNotes = await loadContinuityNotes(options.projectId);
  const chapterPlan = options.plan.chapters.find((chapter) => chapter.index === options.page.chapter?.index);
  const chapterBrief = parseChapterBrief(options.page.chapter?.productionBrief);
  const pageBrief = chapterBrief?.pages.find((brief) => brief.pageIndex === options.page.index);
  const report: PageQualityReport = {
    approved: false,
    score: 50,
    issues: [`User requested this page edit: ${options.request}`],
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
      previousPages: priorPageContext,
      continuityNotes,
      textModel: options.providers.text
    }
  });
  await options.onPhase?.("review");
  const initialReport = await options.strategy.reviewPageDraft({
    input: options.input,
    plan: options.plan,
    chapter: chapterPlan,
    chapterBrief,
    pageBrief,
    pageIndex: options.page.index,
    draft,
    previousPages: priorPageContext,
    continuityNotes,
    textModel: options.providers.text
  });
  if (initialReport.approved) {
    return { ...draft, qualityReport: initialReport };
  }
  // A rejected rewrite used to be stored as-is with its report ignored. Give
  // it the same bounded revise → re-review loop a generated page gets, with a
  // smaller budget — the requested edit is already in the draft, so revisions
  // must repair quality without undoing it, which is what the injected
  // required revision pins down.
  const outcome = await runPageQualityLoop({
    strategy: options.strategy,
    input: options.input,
    plan: options.plan,
    chapter: chapterPlan,
    chapterBrief,
    pageBrief,
    pageIndex: options.page.index,
    draft,
    report: {
      ...initialReport,
      requiredRevisions: [
        `Keep the user's requested edit applied: ${options.request}`,
        ...initialReport.requiredRevisions
      ]
    },
    previousPages: priorPageContext,
    continuityNotes,
    textModel: options.providers.text,
    generationJobId: options.generationJobId,
    maxCandidates: USER_EDIT_MAX_CANDIDATES,
    repairBrief: false,
    reviseContext: `User edit page ${options.page.index}`,
    reviseProgress: 62,
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
