import {
  applyStoryDelta, hasFigureFence, isCancellationError, pageQualityReportSchema, parseStoryDelta, repairPictureBookManuscript,
  reviewPictureBookManuscript, seedStoryStateFromPromises, validateStoryExtractEvidence, validateStyleAuditEvidence,
  withStoryContradictions, withStyleAudit, type PictureBookRepairIssue, type PictureBookPageReview
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { loadPagesForExport } from "../generation/bookHelpers.js";
import { usesShortPictureBookReview } from "../generation/shortPictureBook.js";
import { reviewPageWithQualityGates } from "../generation/pageQualityGateReview.js";
import { assertJobNotStopped, advanceJobStep } from "../runtime/jobLifecycle.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { ExportRepairFenceUnreadableError, ExportRepairSupersededError, fenceUnreadableAfter } from "./compileExportFence.js";
import { FinalizationLeaseLostError } from "./compileFinalization.js";
import type { repairPagesFromFinalQa } from "./compileExportRepair.js";

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
  let reviews: PictureBookPageReview[];
  try {
    candidate = await repairPictureBookManuscript({ input: options.input, plan: options.plan, pages: originals,
      issues, textModel: options.providers.text, projectId: options.projectId });
    if (!candidate.context.changes.length) return unavailable(new Error("No safe coordinated repair was proposed."));
    if (!usesShortPictureBookReview({ ...options, pages: candidate.pages }))
      return unavailable(new Error("Coordinated repair exceeded the short manuscript budget."));
    await active();
    const changed = new Set(candidate.context.changes.map((change) => change.pageIndex));
    // Cheap required/local checks reject a doomed candidate before buying a
    // second full-manuscript model call. Unslop runs once on changed prose.
    for (const page of candidate.pages) {
      const local = await reviewPageWithQualityGates({ strategy: options.strategy, quality: options.quality,
        decisions: options.providers.decisions, allowModelReview: false, allowSmartUnslop: changed.has(page.index),
        reviewOptions: { input: options.input, plan: options.plan, pageIndex: page.index,
          draft: { ...page, continuityNotes: [] }, previousPages: candidate.pages.filter((item) => item.index < page.index),
          nextPages: candidate.pages.filter((item) => item.index > page.index), continuityNotes: [], textModel: options.providers.text } });
      if (!local.approved) return unavailable(new Error(`Coordinated repair failed local checks on page ${page.index}; original prose retained.`));
    }
    await active();
    reviews = await reviewPictureBookManuscript({ input: options.input, plan: options.plan, pages: candidate.pages,
      chapterBriefs: [], repairContext: candidate.context, textModel: options.providers.text, projectId: options.projectId,
      checks: { pageModelReview: true, storyExtractAudit: options.quality.enabled("storyExtractAudit"),
        styleAuditor: options.quality.enabled("styleAuditor") && options.quality.enabled("styleExcerpts") } });
    // Reuse grouped model assessments for the normal required/local/unslop
    // gates. Never fall back to one paid review or repair loop per page.
    for (const review of reviews) {
      const page = candidate.pages.find((item) => item.index === review.pageIndex)!;
      const previousPages = candidate.pages.filter((item) => item.index < page.index);
      const nextPages = candidate.pages.filter((item) => item.index > page.index);
      let report = await reviewPageWithQualityGates({ strategy: options.strategy, quality: options.quality,
        precomputedReport: review.report, allowSmartUnslop: false,
        reviewOptions: { input: options.input, plan: options.plan, pageIndex: page.index,
          draft: { ...page, continuityNotes: [] }, previousPages, nextPages, continuityNotes: [], textModel: options.providers.text } });
      if (review.storyExtract) {
        review.storyExtract = validateStoryExtractEvidence(review.storyExtract, page, candidate.pages);
        report = withStoryContradictions(report, review.storyExtract.contradictions);
      }
      if (review.styleAudit) report = withStyleAudit(report, validateStyleAuditEvidence(review.styleAudit, page.markdown));
      review.report = report;
    }
  } catch (error) {
    if (isCancellationError(error) || isStopRequestedError(error) || error instanceof FinalizationLeaseLostError ||
      error instanceof ExportRepairSupersededError || error instanceof ExportRepairFenceUnreadableError) throw error;
    console.warn("Coordinated short-book repair unavailable; keeping the saved manuscript", { projectId: options.projectId, error });
    return unavailable(error);
  }
  if (reviews.some((review) => !review.report.approved))
    return unavailable(new Error("Coordinated repair failed whole-manuscript verification; original prose retained."));
  await active();
  const changed = new Set(candidate.context.changes.map((change) => change.pageIndex));
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
        await tx.page.update({ where: { id: page.id }, data: { markdown: next.markdown, summary: next.summary,
          status: "COMPLETED", revision: { increment: changed.has(page.index) ? 1 : 0 },
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
      await options.onRepairGroupPublished!(tx, options.pages.map((page) => ({ ...page,
        ...candidate.pages.find((item) => item.index === page.index)!, status: "COMPLETED",
        revision: page.revision + (changed.has(page.index) ? 1 : 0) })));
    });
  } catch (error) {
    if (error instanceof ExportRepairFenceUnreadableError)
      throw fenceUnreadableAfter(error, { pagesRepaired: 0, pagesTargeted: targets.length }, false);
    throw error;
  }
  return loadPagesForExport(options.projectId);
}
