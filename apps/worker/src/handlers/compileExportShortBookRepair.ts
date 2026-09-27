import {
  applyStoryDelta, hasFigureFence, isCancellationError, pageQualityReportSchema, parseStoryDelta, repairPictureBookManuscript,
  seedStoryStateFromPromises,
  pictureBookReviewFingerprint, bindTextModelCall,
  pictureBookRequirementTargets, pictureBookSceneRepairTargets,
  type PictureBookRepairIssue, type PictureBookPageReview, type TextModelAdapter
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { loadPagesForExport } from "../generation/bookHelpers.js";
import { usesShortPictureBookReview } from "../generation/shortPictureBook.js";
import { loadPictureBookReviewSnapshot, shortPictureBookChecks } from "../generation/shortPictureBookReviewCache.js";
import { reviewPageWithQualityGates } from "../generation/pageQualityGateReview.js";
import { assertJobNotStopped, advanceJobStep } from "../runtime/jobLifecycle.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { ExportRepairFenceUnreadableError, ExportRepairSupersededError, fenceUnreadableAfter } from "./compileExportFence.js";
import { FinalizationLeaseLostError } from "./compileFinalization.js";
import type { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { RepairRejectedError } from "./compileRepairOutcome.js";
import { checkedShortBookRepairCandidate } from "./compileShortBookRepairCandidate.js";
import { reviewShortBookRepairCandidate, shortBookRepairRejection, shortBookRepairFeedback } from "./compileShortBookRepairReview.js";

type Options = Parameters<typeof repairPagesFromFinalQa>[0];

export function usesCoordinatedShortBookRepair(options: Options): boolean {
  return Boolean(options.onRepairGroupStarted && options.onRepairGroupPublished && options.assertOwnership) &&
    options.strategy.executionMode !== "sequential-pages" && usesShortPictureBookReview(options) &&
    options.quality.enabled("pageModelReview") && options.pages.every((page) =>
      (page.status === "COMPLETED" || page.status === "FAILED_QA") && page.images.length === 0 && !hasFigureFence(page.markdown) &&
      !options.strategy.shouldIllustratePage(options.input, options.plan, page.index));
}

/** Consume the durable group budget before dispatch; publish only a fully checked manuscript. */
export async function repairShortBookFromFinalQa(options: Options, targets: ExportPageForRepair[]): Promise<ExportPageForRepair[]> {
  const active = async () => {
    await assertJobNotStopped(options.generationJobId);
    try { await options.assertOwnership?.(); }
    catch (error) {
      if (error instanceof ExportRepairFenceUnreadableError)
        throw fenceUnreadableAfter(error, { pagesRepaired: 0, pagesTargeted: targets.length }, false);
      throw error;
    }
  };
  const unavailable = async (error: unknown) => {
    for (const page of targets) await options.onRepairPageUnavailable?.(page.id, page.index, error);
    return options.pages;
  };
  await active();
  // Claim ALL targets at once. A retry after a crash cannot turn the remaining
  // targets into a fresh group with another provider budget.
  if (!await options.onRepairGroupStarted!(targets.map((page) => ({ id: page.id, index: page.index }))))
    return unavailable(new Error("Coordinated repair was already attempted; retaining the saved manuscript."));
  await advanceJobStep(options.generationJobId, "qa", 35, `Repairing ${targets.length} pages together against the complete manuscript`);
  const issues: PictureBookRepairIssue[] = [];
  if (!options.finalQa.approved) issues.push({ pageIndexes: targets.map((page) => page.index),
    messages: [...new Set([...options.finalQa.issues, ...options.finalQa.requiredFixes])] });
  for (const page of targets) {
    const report = pageQualityReportSchema.safeParse(page.qualityReport);
    if (page.status === "FAILED_QA" && report.success && !report.data.approved)
      issues.push({ pageIndexes: [page.index], messages: [...new Set([...report.data.issues, ...report.data.requiredRevisions])] });
  }
  for (const issue of options.additionalRepairIssues ?? [])
    issues.push({ pageIndexes: [...issue.affectedPageIndexes], messages: [issue.message, issue.guidance] });
  if (!issues.some((issue) => issue.messages.length))
    return unavailable(new Error("No actionable repair instructions were recorded."));
  const originals = options.pages.map(({ index, title, markdown, summary }) => ({ index, title, markdown, summary }));
  let candidate: Awaited<ReturnType<typeof repairPictureBookManuscript>>;
  let reviews: PictureBookPageReview[] = [];
  let reviewModel: TextModelAdapter | undefined;
  const checks = shortPictureBookChecks(options.quality);
  try {
    const previousReviews = await loadPictureBookReviewSnapshot({ ...options, pages: originals, checks });
    const requirementTargets = pictureBookRequirementTargets(options.input.prompt, originals, previousReviews ?? [])
      .filter(target => targets.some(page => page.index === target.pageIndex));
    const sceneRepairTargets = pictureBookSceneRepairTargets(originals, previousReviews ?? [])
      .filter(target => targets.some(page => page.index === target.pageIndex));
    // Same frozen input/plan/checks throughout this operation. A rejected
    // candidate's verified chronological prefix can still supply state deltas.
    const baseline = previousReviews ? { pages: originals, reviews: previousReviews } : undefined;
    let previous = baseline;
    candidate = await checkedShortBookRepairCandidate({ input: options.input, plan: options.plan, pages: originals,
      ...(previousReviews ? { originalReviews: previousReviews } : {}),
      issues, requirementTargets, sceneRepairTargets, textModel: options.providers.text, projectId: options.projectId, assertActive: active,
      check: async (proposed) => {
        if (!usesShortPictureBookReview({ ...options, pages: proposed.pages }))
          throw new Error("Coordinated repair exceeded the short manuscript budget.");
        const failures = [];
        for (const page of proposed.pages) {
          const local = await reviewPageWithQualityGates({ strategy: options.strategy, quality: options.quality,
            allowModelReview: false, allowSmartUnslop: false,
            reviewOptions: { input: options.input, plan: options.plan, pageIndex: page.index,
              draft: { ...page, continuityNotes: [] }, previousPages: proposed.pages.filter(item => item.index < page.index),
              nextPages: proposed.pages.filter(item => item.index > page.index), continuityNotes: [], textModel: options.providers.text } });
          if (!local.approved) failures.push({ pageIndex: page.index, issues: local.issues });
        }
        return failures;
      },
      verify: async (proposed, budget) => {
        reviewModel ??= (await bindTextModelCall(options.providers.text, "review-page")).adapter;
        reviews = await reviewShortBookRepairCandidate(options, proposed, previous, reviewModel, budget, active, baseline);
        previous = { pages: proposed.pages, reviews };
        const rejection = shortBookRepairRejection(proposed.context, reviews);
        return rejection ? { rejection, failures: shortBookRepairFeedback(reviews, rejection) } : undefined;
      } });
    if (!candidate.context.changes.length) return unavailable(new RepairRejectedError("no_candidate", targets.map((page) => page.index), "No safe coordinated repair was proposed."));
  } catch (error) {
    if (isCancellationError(error) || isStopRequestedError(error) || error instanceof FinalizationLeaseLostError ||
      error instanceof ExportRepairSupersededError || error instanceof ExportRepairFenceUnreadableError) throw error;
    console.warn("Coordinated short-book repair unavailable; keeping the saved manuscript", { projectId: options.projectId, error });
    return unavailable(error);
  }
  const changed = new Set(candidate.context.changes.map(change => change.pageIndex));
  await active();
  let state = seedStoryStateFromPromises(options.plan.promises ?? []);
  for (const page of options.pages) {
    const review = reviews.find((item) => item.pageIndex === page.index)!;
    const delta = review.storyExtract?.storyDelta ?? (changed.has(page.index) ? null : parseStoryDelta(page.storyDelta));
    if (delta) state = applyStoryDelta(state, delta, page.index);
  }
  try {
    await prisma.$transaction(async (tx) => {
      await options.assertOwnership!(tx);
      // Lock the ENTIRE reviewed snapshot before any publication. Even an
      // untouched later dependency changing invalidates this review.
      for (const page of options.pages) {
        const updatedAt = (page as ExportPageForRepair & { updatedAt?: Date }).updatedAt ?? new Date(0);
        const owned = await tx.page.updateMany({ where: { id: page.id, title: page.title, markdown: page.markdown,
          summary: page.summary, imagePrompt: page.imagePrompt, status: page.status, revision: page.revision, updatedAt }, data: { updatedAt } });
        if (owned.count !== 1) throw new ExportRepairSupersededError();
      }
      for (const page of options.pages) {
        const next = candidate.pages.find((item) => item.index === page.index)!;
        const review = reviews.find((item) => item.pageIndex === page.index)!;
        await tx.page.update({ where: { id: page.id }, data: { title: next.title, markdown: next.markdown, summary: next.summary,
          status: review.report.approved ? "COMPLETED" : "FAILED_QA", revision: { increment: changed.has(page.index) ? 1 : 0 },
          qualityReport: review.report as Prisma.InputJsonValue,
          ...(review.storyExtract ? { storyDelta: review.storyExtract.storyDelta as Prisma.InputJsonValue }
            : changed.has(page.index) ? { storyDelta: Prisma.DbNull } : {}) } });
      }
      // Old page-scoped facts are not evidence for the repaired prose. This
      // lane has no sequential semantic recall; the complete new delta fold is
      // published atomically with all of the page rows.
      await tx.continuityNote.deleteMany({ where: { projectId: options.projectId,
        pageId: { in: options.pages.filter((page) => changed.has(page.index)).map((page) => page.id) } } });
      await tx.project.update({ where: { id: options.projectId }, data: { storyState: state as Prisma.InputJsonValue } });
      if (options.generationJobId) {
        const job = await tx.generationJob.findUnique({ where: { id: options.generationJobId }, select: { payload: true } });
        const payload = job?.payload && typeof job.payload === "object" && !Array.isArray(job.payload) ? job.payload : {};
        await tx.generationJob.update({ where: { id: options.generationJobId }, data: { payload: {
          ...payload, pictureBookFinalReview: { fingerprint: pictureBookReviewFingerprint({ ...options, pages: candidate.pages, checks }), reviews }
        } as Prisma.InputJsonValue } });
      }
      await options.onRepairGroupPublished!(tx, options.pages.map((page) => ({ ...page,
        ...candidate.pages.find((item) => item.index === page.index)!,
        status: reviews.find((item) => item.pageIndex === page.index)!.report.approved ? "COMPLETED" : "FAILED_QA",
        qualityReport: reviews.find((item) => item.pageIndex === page.index)!.report,
        revision: page.revision + (changed.has(page.index) ? 1 : 0) })));
    });
  } catch (error) {
    if (error instanceof ExportRepairFenceUnreadableError)
      throw fenceUnreadableAfter(error, { pagesRepaired: 0, pagesTargeted: targets.length }, false);
    throw error;
  }
  return loadPagesForExport(options.projectId);
}
