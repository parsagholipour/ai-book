import { quickDraftQaTargets, quickDraftRepairTargets, usesCompileDefectScreen, usesQuickDraftReview } from "../generation/quickDraftReviewPolicy.js";
import { qualityIssuesFromFinalQa } from "../generation/exportQualityProvenance.js";
import { pageQualityAdvisoryIssues } from "../generation/pageQualityAdvisories.js";
import { unresolvedPageQualityIssues } from "../generation/unresolvedPageQuality.js";
import { finalRepairQualityIssues } from "./compileRepairOutcome.js";
import { loadPagesForExport, strategyForInput } from "../generation/bookHelpers.js";
import { lastPageIndex } from "../generation/finalQaPageTargets.js";
import {
  discardPendingExports,
  exportPublicationSuperseded,
  pendingExportPaths,
  publishCompiledExports
} from "../generation/exportPublication.js";
import { resolveCompileReaderLayout } from "./compileExportLayout.js";
import { renderCompiledBook, type RenderedCompile } from "./compileExportRender.js";
import { buildManuscriptCoverageContext, manuscriptCoverageForCompile } from "../generation/manuscriptCoverageReview.js";
import { enqueueFinalizationIllustrations } from "../generation/finalizationIllustrations.js";
import { FinalizationLeaseLostError, hasCompileFinalization, openCompileFinalization } from "./compileFinalization.js";
import { quickDraftReviewAfterRepair, reviewFinalizationManuscript } from "./compileFinalizationReview.js";
import type { FinalQaOwnershipClient } from "./compileExportFence.js";
import { loadQualityContext, qualityContextFromSnapshot } from "../generation/qualitySettings.js";
import { rebuildProjectStoryState, rebuildStoryStateFromPages } from "../generation/storyStateStore.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { appliedEditPublicationOwnerId } from "../generation/editProjectStatus.js";
import { currentCoverAsset } from "../generation/currentCover.js";
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import {
  ExportRepairFenceUnreadableError,
  ExportRepairSupersededError,
  exportRepairOwnershipFence,
  manuscriptUnreadableAfterFence,
  recordTruncatedRepairPass
} from "./compileExportFence.js";
import {
  qualityReportFromFindings,
  pagesTheCompileNoLongerSpeaksFor,
  recordCompileQualityReport,
  standDownForNewerExport,
  standDownForOpenImageJobs,
  type StandDownFindings
} from "./compileExportStandDown.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { maybeEnqueueCompile, maybeEnqueueCoverRetypeset } from "../runtime/dispatch.js";
import { advanceJobStep, editOperationIdFromJob, updateJobProgress } from "../runtime/jobLifecycle.js";
import { isStopRequestedError, type ExportPageForRepair, type JobCompletion } from "../runtime/jobTypes.js";
import { effectiveSavedWholeBookExportContext } from "../generation/wholeBookTolerance.js";
import { runCompileManuscriptChecks } from "../generation/compileManuscriptChecks.js";
import { arithmeticErrorIssues, unsupportedCaseClaimIssues } from "../generation/composedEvidenceResiduals.js";
import { composedChapterLengthIssues } from "../generation/composedChapterLength.js";
import { maybeEnqueueCharacterCandidatePreparation } from "./characters.js";
import { companionFormatsToRender, renderCompanionExports } from "./compileExportCompanions.js";
import {
  bookPlanSchema,
  compilePublicationPolicyFromPayload,
  createProviders,
  chapterStructureForExport,
  isAuthorManuscript,
  strategyComposesChapters,
  resolvePublicImageUrl,
  normalizedCompilePublicationPolicy,
  type FinalBookQa,
  type ManuscriptQualityIssue
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import type { CompileExportJob } from "../runtime/jobPayloads.js";
import { withTemporaryDirectory } from "@book-maker/storage";
import { failedQaPageIndexesForCompile } from "./compileExportCitationRepair.js";
import { urlBackedResearchNotes } from "../generation/researchSources.js";
import { dedupeQualityIssues, isStoryBook, qualitySummaryMessage, settledModelIssues, withPrintedShortfall } from "./compileExportQualitySummary.js";
/**
 * `compile-export` job: final QA over the manuscript, then Markdown/PDF and companion (EPUB, Word) output.
 */
export async function compileExport(job: CompileExportJob): Promise<JobCompletion> {
  const { projectId, planId, generationJobId } = job.data;
  const policy = compilePublicationPolicyFromPayload(job.data);
  // The manuscript this compile was queued for. Every enqueue site records it
  // — the run's own fan-in, an edit's recompile and an export repair — and
  // nothing downstream may be published under a different one; see
  // `generation/exportPublication.ts`.
  const queuedContentRevision = job.data.contentRevision ?? null;
  const requeueCompile = async (): Promise<void> => {
    // The image that blocked this compile can finish after a newer edit has
    // changed the manuscript. Scope this policy to the revision that earned it;
    // dispatch recovers the newer revision's intent when the two no longer
    // match instead of carrying this compile's QA/ownership flags forward.
    await maybeEnqueueCompile(projectId, planId, policy, {
      contentRevision: queuedContentRevision,
      completedPredecessorId: generationJobId
    });
  };
  // Set for recompiles after user-driven edits (manual Edit Mode, undo):
  // the QA repair pass must not rewrite text the user chose deliberately.
  const skipFinalReview = policy.review.skipFinalReview;
  // A repair rebuilds a missing file on a book that is already finished; it owns
  // neither the project's status nor its credits. Detached ownership on the
  // compile policy is the one reliable signal for that — rather than
  // `skipFinalReview`, which an edit's own recompile sets too.
  //
  // It gates two separate things. The project write, because an edit sets EDITING
  // before it bumps the revision, so the revision check alone would let a stale
  // repair report the book finished while its pages were still being rewritten
  // (`jobOwnsProjectLifecycle` is the failure side of the same question). And
  // every model call below, because nobody was charged for a repair and a status
  // read queues a fresh one every five minutes for as long as a file is missing.
  const detachedRepair = policy.ownership.kind === "detached";
  const presentationOnly = policy.ownership.kind === "presentation";
  // A free edit's recompile (manual save, Undo, Redo, Studio publish or
  // takeover) compiles, reviews and publishes exactly as the outcome compile it
  // used to be; only its failure is not the book's, and that is settled in
  // `runtime/jobLifecycle.ts` from the payload, not here.
  const ownsOutcome = policy.ownership.kind === "outcome" || policy.ownership.kind === "freeEdit";
  const generationAttemptId = ownsOutcome ? job.data.attemptId ?? null : null;
  const payloadEditOperationId = ownsOutcome ? editOperationIdFromJob(job) : null;
  // Character discovery follows every charged compile of the manuscript — the
  // generation's own and an edit's recompile alike, since an edit is charged
  // work whose prose is new and a book whose detection was never run must still
  // be able to earn it. A repair and a presentation reprint were charged
  // nothing and change no prose, so they start no model fan-out. An edit's
  // recompile claims the legacy project/plan key rather than its own attempt:
  // the attempt paid for the edit, not for re-discovery, so a book that has
  // already run detection collapses onto the spent key instead of paying a
  // discovery call per edit.
  const shouldPrepareCharacterCandidates = ownsOutcome;
  const repairFormat = policy.ownership.kind === "detached" ? policy.ownership.repairFormat : null;
  if (detachedRepair && repairFormat === null) {
    throw new Error("Detached export repair is missing its requested format");
  }
  const ownsProjectStatus = !detachedRepair;
  const [planVersion, project, openImageJobs] = await Promise.all([
    prisma.planVersion.findUnique({ where: { id: planId } }),
    prisma.project.findUnique({
      where: { id: projectId },
      include: {
        pages: { orderBy: { index: "asc" }, include: { images: true, chapter: true } },
        images: true,
        research: true
      }
    }),
    // Normally `maybeEnqueueCompile` is this gate. A compile redelivery is the
    // exception: final-QA can atomically commit a terminal repaired keeper and
    // its durable replacement-image row, then the worker can die before it
    // dispatches or deliberately stands the compile down. Bull redelivers the
    // already-ACTIVE compile directly, bypassing fan-in readiness; without the
    // same check here it can render the terminal prose before the queued image
    // job publishes its matching asset.
    prisma.generationJob.count({
      where: { projectId, type: "GENERATE_IMAGE", status: { in: ["QUEUED", "ACTIVE"] } }
    })
  ]);
  if (!planVersion || !project) {
    throw new Error("Cannot compile export without plan and project");
  }
  // Fan-in can read the byline before a matter save commits. The durable
  // compile row's Project foreign-key lock orders its insertion after that
  // save, and this fresh snapshot sees the new words. Recheck the cover here
  // before rendering; this open compile now prevents another matter save.
  const coverRetypesetPending = openImageJobs === 0 && ownsOutcome && project.status === "GENERATING" &&
    (queuedContentRevision === null || queuedContentRevision === project.contentRevision) &&
    await maybeEnqueueCoverRetypeset(projectId, project, planId, planVersion.planningPackage);
  if (openImageJobs > 0 || coverRetypesetPending) {
    // Settle any prior verdict while replacement images or corrected cover words are pending.
    await standDownForOpenImageJobs({
      projectId,
      generationJobId
    });
    return { lifecycleSettlement: "defer-to-successor", afterJobCompleted: requeueCompile };
  }
  const expectedProjectStatus = normalizedCompilePublicationPolicy(policy, project.status).expectedProjectStatus;
  const editOperationId = payloadEditOperationId ?? (ownsOutcome && expectedProjectStatus === "EDITING" && queuedContentRevision !== null
    ? await appliedEditPublicationOwnerId(prisma, projectId, queuedContentRevision)
    : null);
  let plan = bookPlanSchema.parse(planVersion.planningPackage);
  let input = inputForPlanVersion(project, planVersion.inputSnapshot);
  // The author owns an imported or Studio book's text — and its typography, so the
  // PDF is never refit toward a target, and it answers only to the checks that
  // ask whether the book is whole (see `CompileMarkdownInput.authorManuscript`).
  const authorManuscript = isAuthorManuscript(input.mediaSettings);
  // Keep the requested physical target before whole-book tolerance substitutes
  // the saved manuscript-record count for its content checks.
  const pdfTargetPageCount = authorManuscript ? undefined : input.targetPages;
  let pages: ExportPageForRepair[] = project.pages;
  const initialStrategy = strategyForInput(input);
  const exportContext = effectiveSavedWholeBookExportContext(input, plan, initialStrategy, pages);
  input = exportContext.input;
  plan = exportContext.plan;
  let strategy = strategyForInput(input);
  let providers = createLoggedProviders(job, createProviders(config, input), input);
  // One compile, one quality context. The repair pass below and the integrity
  // pass after it both gate on these operator settings, and loading them twice
  // let an edit saved on the Quality tab in between run a single compile under
  // two different revisions — the repaired pages written against one gate set,
  // the report that ships them against another.
  let quality = await loadQualityContext(input);
  // The compile's one review: the defect screen and its scoped repair (`usesCompileDefectScreen`).
  const defectScreen = () => usesCompileDefectScreen(input, strategy);
  const citeableResearchNotes = urlBackedResearchNotes(project.research);
  let failedQaPageIndexes = failedQaPageIndexesForCompile(pages, citeableResearchNotes, { input, plan, strategy });
  // Lazily cache the pre-repair sweep used for repair targeting and stand-down.
  // The shipped report deliberately runs its own sweep over the durable pages.
  let initialIntegrityIssuesSnapshot: ManuscriptQualityIssue[] | undefined;
  const initialIntegrityIssues = (): ManuscriptQualityIssue[] =>
    (initialIntegrityIssuesSnapshot ??= runCompileManuscriptChecks({
      pages, expectedPageCount: input.targetPages, ...(input.language ? { language: input.language } : {}), authorManuscript,
      narrative: isStoryBook(input, plan)
    }));
  // Error-severity integrity findings are repair targets; warnings and the corroborated structural barrier are not.
  const integrityRepairIssues = () => initialIntegrityIssues().filter((issue) => issue.severity === "error" && issue.code !== "STRUCTURAL_SLOP_SATURATION");
  let modelQualityIssues: ManuscriptQualityIssue[] = [];
  let recoveredFinalQaIssues: ManuscriptQualityIssue[] | undefined;
  let repairVerificationIncomplete = false;
  // `detachedRepair` is belt and braces here — every repair is queued with
  // `skipFinalReview` — but it is the signal that actually means "uncharged", and
  // a repair's verdict is discarded anyway: `ownsProjectStatus` is false, so it
  // writes no status, and its row was created with `ownsQualityVerdict` false —
  // which is the column the API reads the book's verdict off — so the report
  // below stays on this job for an operator and never reaches the app.
  const finalizationIdentity = { projectId, planId, contentRevision: queuedContentRevision,
    operationIdentity: { attemptId: generationAttemptId, editOperationId, policy } };
  // The screen runs where `finalBookQa` is on for the book's tier and the book is of a kind it was
  // measured on; everything else is printed as written, with the deterministic checks. Never over an
  // author's book: which page is the author's is not a question a page can answer. A screen that
  // began before a settings toggle finishes (`hasCompileFinalization`).
  const runFinalReview =
    !authorManuscript &&
    !skipFinalReview &&
    !detachedRepair &&
    !presentationOnly &&
    defectScreen() &&
    (quality.enabled("finalBookQa") || await hasCompileFinalization(finalizationIdentity));
  const finalization = runFinalReview ? await openCompileFinalization({
    ...finalizationIdentity, generationJobId,
    input: { input, plan, settings: quality.settings, promptMode: quality.pageReviewPromptMode },
    pages, payload: job.data
  }) : null;
  let durablePublicationCommitted = false;
  // Model work the compile runs beside its other steps. Each is a settled
  // promise, so none can reject unobserved, and all are drained below before the
  // finalization lease is released.
  let briefWork: Promise<PromiseSettledResult<Awaited<ReturnType<typeof manuscriptCoverageForCompile>> | null>> | undefined;
  let verdictWork: Promise<PromiseSettledResult<CompileVerdict>> | undefined;
  try {
  // Another delivery may have finished while this one waited for its lease.
  if (finalization?.state.phase === "published") return { durableCompletionCommitted: true };
  if (finalization) {
    pages = await loadPagesForExport(projectId);
    const saved = finalization.state.configuration as { input: typeof input; plan: typeof plan; settings: unknown; promptMode: typeof quality.pageReviewPromptMode };
    input = saved.input; plan = saved.plan;
    quality = { ...qualityContextFromSnapshot(input, saved.settings), pageReviewPromptMode: saved.promptMode };
    strategy = strategyForInput(input);
    providers = createLoggedProviders(job, createProviders(config, input), input);
    failedQaPageIndexes = failedQaPageIndexesForCompile(pages, citeableResearchNotes, { input, plan, strategy });
    if (await exportPublicationSuperseded(projectId, queuedContentRevision)) return {};
  }
  if (runFinalReview) {
    await advanceJobStep(generationJobId, "qa", 25);
    const reviewManuscript = () => reviewFinalizationManuscript({ input, plan, pages, textModel: providers.text });
    let finalQa: FinalBookQa;
    const review = await finalization!.review("initial", pages, reviewManuscript);
    // The book is not read again after its repair (`quickDraftReviewAfterRepair`).
    const reviewAfterRepair = () => Promise.resolve(quickDraftReviewAfterRepair(review, finalization!.state, pages));
    modelQualityIssues = review.issues;
    finalQa = review.finalQa;
    if ((!finalQa.approved || failedQaPageIndexes.length > 0 || initialIntegrityIssues().some((issue) => issue.severity === "error")) &&
      quality.enabled("pageQaRewrite") && !finalization!.state.repairPassCompleted) {
      const targets = new Set([
        ...failedQaPageIndexes, ...quickDraftQaTargets(finalQa), ...integrityRepairIssues().flatMap((issue) => issue.affectedPageIndexes)
      ]);
      await finalization!.beginRepair(quickDraftRepairTargets(pages, targets, finalQa).map((page) => page.id));
      const revisionFence = exportRepairOwnershipFence(projectId, queuedContentRevision);
      const repairOwnershipFence = revisionFence ? async (client?: FinalQaOwnershipClient) => {
        await revisionFence(client);
        await finalization!.assertLease(client);
      } : undefined;
      let repairedPages: ExportPageForRepair[] | undefined;
      try {
        repairedPages = await repairPagesFromFinalQa({
          projectId,
          planId,
          input,
          plan,
          providers,
          strategy,
          pages,
          finalQa,
          additionalRepairIssues: integrityRepairIssues(),
          shouldRepairPage: (id) => !finalization!.state.startedPageIds.includes(id),
          onRepairGroupStarted: (targets) => finalization!.claimPages(targets),
          onRepairGroupPublished: (client, snapshot) => finalization!.finishRepairInTransaction(client, snapshot),
          onRepairPageUnavailable: (id, pageIndex, error) => finalization!.unavailablePage(id, pageIndex, error),
          // A repaired page's picture is redrawn by this compile's finalization (`enqueueFinalizationIllustrations`).
          deferIllustrations: queuedContentRevision !== null,
          // Errors only: warning-severity issues and the corroborated structural
          // barrier are review findings, not licences to rewrite every page they touch.
          extraPageIndexes: [...failedQaPageIndexes, ...integrityRepairIssues().flatMap((issue) => issue.affectedPageIndexes)],
          // What fences every durable write the pass makes — the pages it
          // rewrites as well as the chapter beats it repairs; see
          // `exportRepairOwnershipFence` and the parameter's own docstring. Its
          // two throws are the only things the catch below takes — the book
          // moved on, and the barrier could not find out — so a
          // `StopRequestedError` raised by any provider call inside the repair
          // travels straight out to `markStopped` as before.
          ...(repairOwnershipFence ? { assertOwnership: repairOwnershipFence } : {}),
          generationJobId
        });
        if (repairedPages) {
          pages = repairedPages;
          await finalization!.finishRepair(pages);
          // An edit can commit after the repair's claim; the verdict derived
          // below would then describe pages the book no longer holds. Its
          // superseded answer takes the same stand-down path as a repair that
          // lost ownership mid-page.
          if (repairOwnershipFence) {
            await repairOwnershipFence();
          }
          const reviewed = await finalization!.review("final", pages, reviewAfterRepair);
          finalQa = reviewed.finalQa;
          modelQualityIssues.push(...reviewed.issues);
        }
        await finalization!.finishRepair(pages);
      } catch (error) {
        if (error instanceof ExportRepairFenceUnreadableError) {
          // The barrier could not answer, so this compile decides nothing on
          // its behalf. It stops repairing — which is the whole of what the
          // fence buys, since every page the pass has yet to reach is a model
          // rewrite saved over prose the reader may have just paid to replace —
          // and then carries on to the two checks that are *authoritative*
          // rather than advisory: its own supersede read a few statements
          // below, which asks the same question again once the blip has had a
          // moment to clear, and the compare-and-set inside
          // `publishCompiledExports`, which is the only thing that ever
          // actually decided whether these files may replace the book's.
          // Guessing "superseded" here would publish nothing and write no
          // status, which for the two full-review compiles queued against a
          // live project (`restructurePages`' recompile, EDITING; the run's own
          // fan-in, GENERATING) abandons the immediate handoff. The delayed
          // stranded-generation sweep now reaches both states, but only after
          // its grace period and after every job is terminal; a transient read
          // failure is not a reason to trade this compile for that delay.
          //
          // The pass returns the manuscript it wrote, so this reads it the way
          // a completed pass does: `repairPagesFromFinalQa`'s own return value
          // is `loadPagesForExport`, and every page it saved before the barrier
          // is in that answer. Without it the compile would render the snapshot
          // it opened with and publish a PDF that disagrees with the rows the
          // reader's Edit Mode shows — under an unchanged `contentRevision`, so
          // nothing would ever queue the recompile that fixes it. This read
          // doubles as the liveness question worth asking: a database that
          // cannot answer it is one this compile has nothing left to publish
          // against, and letting *that* throw travel is the honest failure.
          //
          // A failed re-read settles with the fence's progress evidence intact.
          try {
            repairedPages = await loadPagesForExport(projectId);
          } catch (rereadError) {
            throw manuscriptUnreadableAfterFence(error, rereadError);
          }
          const changedPageIndexes = pagesTheCompileNoLongerSpeaksFor(pages, repairedPages);
          const stillDescribesReread = (issue: ManuscriptQualityIssue): boolean =>
            issue.affectedPageIndexes.length === 0
              ? changedPageIndexes.size === 0
              : issue.affectedPageIndexes.every((index) => !changedPageIndexes.has(index));
          modelQualityIssues = modelQualityIssues.filter(stillDescribesReread);
          recoveredFinalQaIssues = qualityIssuesFromFinalQa(finalQa, lastPageIndex(pages), pages).filter(
            stillDescribesReread
          );
          repairVerificationIncomplete = true;
          // Record the truncated pass only after the liveness re-read succeeds;
          // `markCompleted` will soon overwrite job progress, while an unreadable
          // manuscript must settle as a failure rather than file a shipped-pass note.
          await recordTruncatedRepairPass({
            job,
            projectId,
            generationJobId,
            error,
            reviewedPages: pages,
            repairedPages
          });
          pages = repairedPages;
        }
        if (error instanceof ExportRepairSupersededError) {
          // The same answer this condition gets further down at the compile's own
          // supersede read, reached from deeper in. The pages this pass had
          // already rewritten stay written — they are an improvement to the
          // manuscript the newer compile is about to publish, not this compile's
          // to take back — and standing down is what keeps the throw away from
          // `markFailed`, which would mark a finished book FAILED and refund it.
          //
          // **The verdict is recorded on the way out, because the sibling
          // stand-down records one and this one is the same compile.** Only a
          // compile that owns the quality verdict ever reaches here —
          // `runFinalReview` is false for every detached repair, presentation
          // reprint and `skipFinalReview` recompile, which is `jobOwnsQualityVerdict`'s
          // exclusion list — and by this point it has run the whole review, the
          // defect screen. That is the only model-graded opinion of this
          // manuscript anyone is going to produce.
          // The compile that supersedes it need not replace it: an edit's own
          // recompile owns the verdict but builds its report with
          // `finalReviewRan: false`, and an image move, remove or insertion queues
          // a `MARKDOWN_RECOMPILE_WITHOUT_VERDICT` recompile that owns no verdict
          // at all. `continueBook` is the reachable door — it puts the project
          // back to COMPLETE and *then* queues a full-review compile, so the book
          // takes chat edits for the whole of it — and returning here empty left
          // `loadProjectQualityReport` reaching past this row to whatever the
          // book's last verdict-owning compile had said, or to nothing.
          //
          // It is also the one stand-down that has to build a report at all:
          // every other return in this handler is below the
          // `recordCompileQualityReport` that ships the compile's real verdict.
          // What it may still claim is `standDownQualityReport`'s question, and
          // the answer is *not* this snapshot verbatim — the repair had already
          // rewritten most of the pages the snapshot complains about. It sets no
          // project status either way, that write being far below the return, so
          // nothing here can hand a book to REVIEW_REQUIRED; the card the reader
          // is left looking at is the whole of what is at stake.
          await standDownForNewerExport({
            projectId,
            generationJobId,
            findings: {
              // `project.pages` rather than `pages`, which is the same array at
              // this point — the reassignment below this catch is the only
              // thing that ever moves it.
              reviewedPages: project.pages,
              deterministicIssues: [...initialIntegrityIssues()],
              modelIssues: settledModelIssues([
                ...modelQualityIssues,
                ...unresolvedPageQualityIssues(project.pages),
                ...(recoveredFinalQaIssues ?? qualityIssuesFromFinalQa(finalQa, lastPageIndex(pages), pages))
              ], project.pages),
              finalReviewRan: true,
              deterministicWarningsAffectVerdict: true
            }
          });
          return error instanceof FinalizationLeaseLostError
            ? { lifecycleSettlement: "defer-to-successor", afterJobCompleted: requeueCompile }
            : {};
        } else if (!(error instanceof ExportRepairFenceUnreadableError)) {
          throw error;
        }
      }
    }
    if (finalization!.state.repairPassCompleted) {
      const reviewed = await finalization!.review("final", pages, reviewAfterRepair);
      finalQa = reviewed.finalQa;
      // Retain only the verdict after the repair, never findings about prose it replaced.
      modelQualityIssues = reviewed.issues;
    }
    if (!finalQa.approved) {
      // Export the best available book instead of failing the whole project;
      // remaining issues stay visible on the job and the flagged pages.
      await updateJobProgress(generationJobId, {
        message: `Final review still reports issues; exporting the best available version. ${finalQa.issues.slice(0, 5).join(" ")}`
      });
    }
    // Two questions off one verdict, and they are not the same question. The
    // repair pass above asked which pages to *redraft* (`quickDraftQaTargets`,
    // capped to whole finding groups). This asks what to show the reader, so it is
    // per message and named pages only — `qualityIssuesFromFinalQa` maps each
    // complaint to the pages that complaint names, bounded by the book's own
    // page count. One array over the whole verdict cannot be right for both,
    // and stamped on every message it was right for neither.
    //
    // Bounded by `pages`, which is the manuscript this compile just reviewed,
    // rather than by `input.targetPages`, which is the plan's count and can
    // differ — the deterministic manuscript audit reports the difference as a
    // mismatch of its own. The card's promise is a page the reader can open.
    modelQualityIssues.push(
      ...(recoveredFinalQaIssues ?? qualityIssuesFromFinalQa(finalQa, lastPageIndex(pages), pages))
    );
  } else {
    await advanceJobStep(generationJobId, "qa", 25, "Running deterministic integrity checks");
  }

  // A compile that owns a review publishes only once every illustrated page has the picture of its
  // current keeper: a page the screen repaired is redrawn here (its revision moved its keeper token),
  // and so is a picture an older release deferred to the compile's final review, which a book on a
  // tier the screen does not read would otherwise never get. An unchanged page's early picture is
  // found under the shared `pageIllustrationJobDedupeKey` and costs nothing.
  const drawsCurrentPictures = ownsOutcome && !skipFinalReview && !detachedRepair && !presentationOnly && !authorManuscript;
  if (drawsCurrentPictures && queuedContentRevision !== null) {
    const illustrations = await enqueueFinalizationIllustrations({
      projectId, planId, contentRevision: queuedContentRevision, input, plan, strategy
    });
    if (illustrations.kind === "superseded") {
      await standDownForNewerExport({ projectId, generationJobId });
      return {};
    }
    await finalization?.phase("illustrations", illustrations.pendingJobIds);
    if (illustrations.pendingJobIds.length > 0) return { lifecycleSettlement: "defer-to-successor", afterJobCompleted: requeueCompile };
    if (illustrations.missingPageIndexes.length > 0) modelQualityIssues.push({
      code: "ILLUSTRATIONS_UNAVAILABLE", source: "deterministic", severity: "warning",
      message: "Some requested illustrations could not be generated.", guidance: "Review these pages and retry their illustrations if needed.",
      affectedPageIndexes: illustrations.missingPageIndexes
    });
  }

  // Resolve one partition for coverage and export after all prose repairs. An obsolete
  // compile still records/withdraws its findings below, but must not spend on chapterization.
  const supersededBeforeCoverage = await exportPublicationSuperseded(projectId, queuedContentRevision);
  const cover = currentCoverAsset(project.images);
  const markdownPages = pages.map((page) => ({
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary,
    imagePath: resolvePublicImageUrl(page.images[0]?.path, config.PUBLIC_API_URL),
    imageAlt: "Illustration"
  }));
  const { publishedMarkdown, readerChapters } = await resolveCompileReaderLayout({
    projectId, input, plan, strategy, pages, textModel: providers.text,
    superseded: supersededBeforeCoverage, detachedRepair, presentationOnly
  });

  // Always rerun integrity checks after repair attempts. Manual edits may
  // skip model rewriting, but they can never bypass publication integrity.
  const storyState =
    (await rebuildProjectStoryState(projectId, plan.promises ?? [])) ??
    (await rebuildStoryStateFromPages(projectId, plan.promises ?? []));
  modelQualityIssues.push(...finalRepairQualityIssues(finalization?.state, pages));
  const interruptedRepairIds = finalization?.state.startedPageIds.filter((id) => !finalization.state.completedPageIds.includes(id)) ?? [];
  if (interruptedRepairIds.length > 0) modelQualityIssues.push({
    code: "FINAL_QA_REPAIR_INTERRUPTED", source: "deterministic", severity: "warning",
    message: "Automatic repair was interrupted on these pages; their saved versions were retained.",
    guidance: "Review these pages or request another repair.",
    affectedPageIndexes: pages.filter((page) => interruptedRepairIds.includes(page.id)).map((page) => page.index)
  });
  // The brief coverage read runs on no tier by default (`briefCoverageReview`), whatever
  // pipeline wrote the book; a revision that lists the gate still runs it. Quick Draft's
  // screen already reads the request beside the manuscript.
  const coverageSkipped = !authorManuscript && (usesQuickDraftReview(input) || !quality.enabled("briefCoverageReview"));
  if (!coverageSkipped) {
    await finalization?.phase("coverage");
    await updateJobProgress(generationJobId, { message: "Checking the finished book against your request" });
  }
  const coverageOptions = { inventory: plan.requirementInventory, brief: input.prompt, promises: [...(plan.promises ?? []), ...storyState.promises.map((promise) => promise.text)],
    pages, chapters: chapterStructureForExport({ plan, pages: markdownPages, readerChapters }), textModel: providers.text,
    evidenceContext: buildManuscriptCoverageContext({ input, plan, pages, images: project.images,
      expectedIllustratedPageIndexes: pages.filter((page) => strategy.shouldIllustratePage(input, plan, page.index)).map((page) => page.index) }) };
  // A superseded delivery still reaches the findings-aware withdrawal below: an
  // early empty stand-down would discard findings about pages the edit left alone.
  const coverageRuns = !authorManuscript && !coverageSkipped;
  briefWork = settled(!coverageRuns ? Promise.resolve(null)
    : manuscriptCoverageForCompile({ ...coverageOptions, projectId, allowModelReview: ownsOutcome && !skipFinalReview }));
  // Everything the verdict is graded on but the coverage read. An owning compile
  // files the read's answer as model findings, never in this sweep.
  const sweptIssues: ManuscriptQualityIssue[] = [
    ...runCompileManuscriptChecks({
      pages,
      expectedPageCount: input.targetPages,
      ...(input.language ? { language: input.language } : {}),
      authorManuscript,
      narrative: isStoryBook(input, plan)
    }),
    // What the composed chapter's repairs could not settle, matched against the pages that still carry
    // it: console errors, except a wrong number, which the reader sees quoted (`readerFindings.ts`).
    // An author's chapter is as long as they wrote it, whatever strategy "auto" resolves to.
    ...(strategyComposesChapters(strategy) && !authorManuscript ? [...unsupportedCaseClaimIssues(pages), ...arithmeticErrorIssues(pages), ...composedChapterLengthIssues(pages, input)] : []),
    ...(repairVerificationIncomplete
      ? [{
          code: "FINAL_QA_REPAIR_INCOMPLETE",
          severity: "error" as const,
          source: "deterministic" as const,
          message: "Final QA repair stopped before every targeted page could be verified.",
          guidance: "Review the remaining flagged pages in Edit Mode or rerun final QA.",
          affectedPageIndexes: pages.filter((page) => page.status === "FAILED_QA").map((page) => page.index)
        }]
      : [])
  ];
  const settleVerdict = async (): Promise<CompileVerdict> => {
    // No model adjudicates the sweep's structural clusters any more: the defect screen reads for
    // duplication, and the adjudicator's findings fixed nothing (console only, never a repair target).
    const coverage = settledValue(await briefWork!);
    if (coverage && ownsOutcome && !skipFinalReview) modelQualityIssues.push(...coverage.issues);
    // An outcome compile's deterministic warnings are new quality evidence even
    // when model review was not requested. Every `skipFinalReview` recompile — an
    // undo, exact replacement, or chat edit — re-runs these checks over prose it
    // never touched, so its warnings remain recorded without retroactively
    // re-grading the book. Errors still block from either mode.
    // Kept as findings and graded, rather than graded and kept, because two of
    // this handler's three stand-downs are below this line: both of them have
    // already stored `qualityReport`, and a stored verdict is an opinion with no
    // way back to the pages it was about. `standDownForNewerExport` is what
    // withdraws the half of it that stops being true, and it can only do that
    // from these.
    const findings: StandDownFindings = {
      reviewedPages: pages,
      deterministicIssues: [...(coverage && (!ownsOutcome || skipFinalReview) ? coverage.issues : []), ...sweptIssues],
      modelIssues: settledModelIssues([...modelQualityIssues, ...pageQualityAdvisoryIssues(pages), ...unresolvedPageQualityIssues(pages)], pages),
      finalReviewRan: runFinalReview,
      deterministicWarningsAffectVerdict: ownsOutcome && !skipFinalReview
    };
    const qualityReport = { ...qualityReportFromFindings(findings), ...(coverage ? { briefCoverage: coverage.stored } : {}) };
    await recordCompileQualityReport(generationJobId, qualityReport);
    // A blocked report used to stop here with no artifacts at all, which held a
    // paid book hostage to its own QA: nothing to read in-app, downloads refused.
    // Now every compile produces the best available book — the same promise the
    // model-QA path already made — and "blocked" only decides whether the project
    // finishes as REVIEW_REQUIRED, which keeps the flagged issues on screen and
    // the free Edit Mode repair path open.
    const reviewRequired = qualityReport.state === "blocked";
    if (reviewRequired) {
      await updateJobProgress(generationJobId, {
        message: qualitySummaryMessage(qualityReport)
      });
    }
    return { findings, qualityReport, reviewRequired };
  };
  verdictWork = settled(settleVerdict());

  // The book's bytes read nothing the verdict decides, so they render while the
  // brief is checked, and are consulted only once the verdict is recorded and the
  // supersede read below has answered — the order the serial code observed them
  // in (`renderCompiledBook`). An edit seen before the read skips both.
  return await withTemporaryDirectory("book-compile-", async (scratchDir) => {
    const pending = pendingExportPaths(scratchDir);
    let characterPreparationJobId: string | null = null;
    const rendering = supersededBeforeCoverage ? undefined : settled(renderCompiledBook({ job, projectId, generationJobId,
      project, plan, input, strategy, authorManuscript, pages: markdownPages, readerChapters, cover, detachedRepair,
      publishedMarkdown, repairFormat, pdfTargetPageCount, pending, finalization }));
    try {
      const verdict = await verdictWork!;
      if (verdict.status === "rejected") {
        // A stop wins wherever it was raised.
        const rendered = await rendering;
        throw rendered?.status === "rejected" && isStopRequestedError(rendered.reason) ? rendered.reason : verdict.reason;
      }
      const { findings, qualityReport, reviewRequired } = verdict.value;
      // Exit before publishing if an edit landed during coverage or structural review: an edit
      // applied while this compile was in QA has already queued the recompile that
      // will publish instead. The binding decision is the claim in
      // `publishCompiledExports`, since an edit can still land after this read.
      if (supersededBeforeCoverage || await exportPublicationSuperseded(projectId, queuedContentRevision)) {
        await standDownForNewerExport({ projectId, generationJobId, findings });
        return {};
      }
      const { markdown, compiled, repairReconstructedMarkdown, pdfPageMapUpdate, printedSheets }: RenderedCompile = settledValue(await rendering!);
      // The one length finding a reader is shown needs the PDF, so it joins the recorded verdict here.
      const shortfall = withPrintedShortfall(qualityReport, printedSheets);
      if (shortfall) await recordCompileQualityReport(generationJobId, shortfall);
      const companions = await renderCompanionExports({
        formats: companionFormatsToRender(repairFormat),
        markdown,
        ...(compiled ? { pageMapPlan: compiled } : {}),
        pending,
        projectId,
        generationJobId,
        title: plan.title,
        author: project.authorName,
        language: input.language,
        qualityReport: shortfall ?? qualityReport
      });
      await finalization?.assertLease();
      const publication = await publishCompiledExports({
        projectId,
        generationJobId,
        ...(finalization ? { assertFinalizationOwnership: (tx) => finalization.assertLease(tx) } : {}),
        pending,
        companionsProduced: companions.produced,
        repairFormat,
        ...(pdfPageMapUpdate !== undefined ? { pdfPageMap: pdfPageMapUpdate } : {}),
        publishReconstructedMarkdown: repairReconstructedMarkdown,
        // Exact repairs reproduce the published document's historical image URLs.
        ...(detachedRepair && publishedMarkdown !== undefined ? {} : { renderedCoverId: cover?.id ?? null }),
        contentRevision: queuedContentRevision,
        expectedProjectStatus,
        status: policy.ownership.kind === "presentation"
          ? policy.ownership.fallbackStatus
          : reviewRequired
            ? "REVIEW_REQUIRED"
            : "COMPLETE",
        ownsProjectStatus,
        generationAttemptId,
        editOperationId,
        characterPreparation: shouldPrepareCharacterCandidates
          ? { planId, attemptId: skipFinalReview ? null : generationAttemptId }
          : null
      });
      if (!publication.published) {
        // The same door as the read above, and the verdict it withdraws now
        // includes any `EPUB_EXPORT_FAILED` warning appended on the way here:
        // that warning is about an EPUB in `pending`, which the `finally` below
        // is about to discard, so it describes a file no reader will ever be
        // offered.
        await standDownForNewerExport({ projectId, generationJobId, findings });
        return publication.blockedByOpenImageJobs || publication.blockedByChangedCover
          ? { lifecycleSettlement: "defer-to-successor", afterJobCompleted: requeueCompile }
          : {};
      }
      characterPreparationJobId = publication.characterPreparationJobId;
      durablePublicationCommitted = true;
      // Publication already committed lifecycle settlement. Checkpoint telemetry
      // cannot turn that delivered result back into a failed/refunded job.
      await finalization?.phase("published").catch(() => undefined);
    } finally {
      // Never discard scratch a render is still writing into.
      await rendering;
      await discardPendingExports(pending);
    }
    const persistedCharacterPreparationJobId = characterPreparationJobId;
    return {
      // Publication committed the durable job plus attempt/edit settlement in
      // the same transaction as these files. `processWorkerJob` may therefore
      // treat later step/message bookkeeping as best-effort without hiding any
      // pre-publication failure.
      durableCompletionCommitted: true,
      ...(persistedCharacterPreparationJobId
        ? {
            // The row already exists durably. This hook only pushes that exact id
            // to Redis; a crash or outage is recovered by the undispatched sweep.
            afterJobCompleted: () =>
              maybeEnqueueCharacterCandidatePreparation(projectId, planId, persistedCharacterPreparationJobId)
          }
        : {})
    };
  });
  } catch (error) {
    if (error instanceof FinalizationLeaseLostError) {
      return { lifecycleSettlement: "defer-to-successor", afterJobCompleted: requeueCompile };
    }
    throw error;
  } finally {
    // Drain owned work before releasing the finalization lease.
    await briefWork; await verdictWork;
    if (durablePublicationCommitted) await finalization?.close().catch(() => undefined);
    else await finalization?.close();
  }
}

type CompileVerdict = { findings: StandDownFindings; qualityReport: ReturnType<typeof qualityReportFromFindings>; reviewRequired: boolean };

function settled<T>(work: Promise<T>): Promise<PromiseSettledResult<T>> {
  return work.then((value) => ({ status: "fulfilled" as const, value }), (reason: unknown) => ({ status: "rejected" as const, reason }));
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

export { dedupeQualityIssues, qualitySummaryMessage };
