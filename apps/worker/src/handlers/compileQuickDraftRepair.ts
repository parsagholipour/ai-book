import { isStopOrAbortError, pageQualityReportSchema, QuickDraftRepairRejectedError,
  repairQuickDraftPages, reviewQuickDraftPageLocally, uniqueStrings } from "@book-maker/core";
import { deletePageEmbeddings, Prisma, prisma } from "@book-maker/db";
import { loadPagesForExport } from "../generation/bookHelpers.js";
import { quickDraftTargetMessages } from "../generation/quickDraftReviewPolicy.js";
import { retireGeneratedPageIllustrations } from "../generation/pageIllustrationOwnership.js";
import { assertJobNotStopped, advanceJobStep } from "../runtime/jobLifecycle.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import type { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { ExportRepairFenceUnreadableError, ExportRepairSupersededError, fenceUnreadableAfter } from "./compileExportFence.js";
import { RepairRejectedError } from "./compileRepairOutcome.js";

type Options = Parameters<typeof repairPagesFromFinalQa>[0];

/** A single, verified candidate; related pages and their durable budget publish atomically. */
export async function repairQuickDraftFromFinalQa(options: Options, targets: ExportPageForRepair[]): Promise<ExportPageForRepair[] | undefined> {
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
    return undefined;
  };
  await active();
  if (targets.some(page => options.shouldRepairPage?.(page.id) === false)) return undefined;
  if (options.onRepairGroupStarted) {
    if (!await options.onRepairGroupStarted(targets.map(({ id, index }) => ({ id, index })))) return undefined;
  } else {
    for (const page of targets) if (await options.onRepairPageStarted?.(page.id, page.index) === false) return undefined;
  }
  // A picture is redrawn only when finalization is deferred; a figure is the repair's to patch (core `quickDraftRepairScope.ts`).
  if (!options.deferIllustrations && targets.some(page => options.strategy.shouldIllustratePage(options.input, options.plan, page.index)))
    return unavailable(new Error("Focused repair requires deferred illustration finalization for illustrated pages."));
  const targetIndexes = new Set(targets.map(page => page.index));
  // The screen's grounded findings carry their own problem, fix and evidence; only a review stored before
  // they were kept falls back to its "Page N:" messages. Either way, only the targets' own complaints.
  const findings = (options.finalQa.focusedReview?.findings ?? []).filter(finding => finding.targets.some(index => targetIndexes.has(index)));
  const instructions = options.finalQa.focusedReview?.findings ? [] : quickDraftTargetMessages(options.finalQa, targetIndexes);
  for (const page of targets) {
    const stored = pageQualityReportSchema.safeParse(page.qualityReport);
    if (stored.success && !stored.data.approved) instructions.push(...stored.data.issues, ...stored.data.requiredRevisions);
  }
  for (const issue of options.additionalRepairIssues ?? [])
    if (issue.affectedPageIndexes.some(index => targets.some(page => page.index === index))) instructions.push(issue.message, issue.guidance);
  if (!instructions.length && !findings.length) return unavailable(new Error("No concrete repair instructions were recorded."));
  await advanceJobStep(options.generationJobId, "qa", 35, `Checking a focused repair for pages ${targets.map(page => page.index).join(", ")}`);
  let candidate: Awaited<ReturnType<typeof repairQuickDraftPages>>;
  try {
    candidate = await repairQuickDraftPages({ input: options.input, plan: options.plan,
      pages: options.pages.map(({ index, title, markdown, summary }) => ({ index, title, markdown, summary })),
      targetPageIndexes: targets.map(page => page.index), instruction: uniqueStrings(instructions).join("\n"), findings,
      textModel: options.providers.text, assertActive: active });
  } catch (error) {
    if (isStopOrAbortError(error) || error instanceof ExportRepairSupersededError || error instanceof ExportRepairFenceUnreadableError) throw error;
    return unavailable(error instanceof QuickDraftRepairRejectedError
      ? new RepairRejectedError(error.failureClass, targets.map(page => page.index), error.message) : error);
  }
  const changed = targets.filter(page => candidate.find(next => next.index === page.index)!.markdown !== page.markdown);
  const reports = new Map(changed.map(page => {
    const draft = candidate.find(next => next.index === page.index)!;
    return [page.index, reviewQuickDraftPageLocally({ input: options.input, plan: options.plan, pageIndex: page.index,
      draft: { ...draft, continuityNotes: [] }, previousPages: candidate.filter(p => p.index < page.index),
      nextPages: candidate.filter(p => p.index > page.index), continuityNotes: [], textModel: options.providers.text })];
  }));
  await active();
  try {
    await prisma.$transaction(async tx => {
      await options.assertOwnership?.(tx);
      // Lock every page read by acceptance, including untouched dependencies, before any write.
      for (const page of options.pages) {
        const updatedAt = (page as ExportPageForRepair & { updatedAt?: Date }).updatedAt ?? new Date(0);
        const owned = await tx.page.updateMany({ where: { id: page.id, title: page.title, markdown: page.markdown,
          summary: page.summary, status: page.status, imagePrompt: page.imagePrompt, revision: page.revision, updatedAt }, data: { updatedAt } });
        if (owned.count !== 1) throw new ExportRepairSupersededError();
      }
      for (const page of changed) {
        const next = candidate.find(p => p.index === page.index)!;
        const report = reports.get(page.index)!;
        await tx.page.update({ where: { id: page.id }, data: { markdown: next.markdown, summary: next.summary,
          revision: { increment: 1 }, status: report.approved ? "COMPLETED" : "FAILED_QA",
          qualityReport: report as Prisma.InputJsonValue, storyDelta: Prisma.DbNull } });
        await retireGeneratedPageIllustrations(tx, { pageIndex: page.index,
          priorKeeper: { ...page, pageId: page.id, projectId: options.projectId } });
      }
      await tx.continuityNote.deleteMany({ where: { projectId: options.projectId, pageId: { in: changed.map(page => page.id) } } });
      await deletePageEmbeddings(tx, options.projectId, changed.map(page => page.id));
      await options.onRepairGroupPublished?.(tx, options.pages.map(page => {
        const next = candidate.find(p => p.index === page.index)!;
        const report = reports.get(page.index);
        return report ? { ...page, ...next, qualityReport: report, revision: page.revision + 1,
          status: report.approved ? "COMPLETED" : "FAILED_QA" } : page;
      }));
    });
  } catch (error) {
    if (error instanceof ExportRepairFenceUnreadableError)
      throw fenceUnreadableAfter(error, { pagesRepaired: 0, pagesTargeted: targets.length }, false);
    throw error;
  }
  if (!options.onRepairGroupPublished) for (const page of targets) await options.onRepairPageCompleted?.(page.id);
  return loadPagesForExport(options.projectId);
}
