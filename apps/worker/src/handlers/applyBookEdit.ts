import { getProjectOrThrow, strategyForInput } from "../generation/bookHelpers.js";
import {
  prepareEmbedding,
  strategyUsesSemanticMemory
} from "../generation/embeddingWrites.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { resolveEditPromptContext } from "../generation/editOperationContext.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { applyImageInsertion } from "./applyImageInsertion.js";
import { applyImageLayout } from "./applyImageLayout.js";
import { restructurePages } from "./restructurePages.js";
import {
  draftTextEditCandidates,
  storedExactReplacementCandidate,
  type TextEditCandidate
} from "./textEditCandidates.js";
import {
  settleSkippedExactTextEdit,
  textExactEditWasSkipped
} from "./applyBookEditNoop.js";
import { keeperStoryExtractForSave } from "../generation/qualityEnrichment.js";
import { loadQualityContext } from "../generation/qualitySettings.js";
import { loadProjectStoryState } from "../generation/storyStateStore.js";
import {
  assertTextEditLeaseTx,
  completeTextEditLease,
  isTextEditLeaseLostError,
  startTextEditLeaseHeartbeat,
  waitForTextEditLease,
  waitForTextEditLeaseCompletion
} from "../generation/textEditLease.js";
import { UnownedTextEditDeliveryError } from "../runtime/jobTypes.js";
import {
  applyStoryDelta,
  bookPlanSchema,
  createProviders,
  parseStoryDelta,
  preEditProjectStatus,
  rebuildStoryState,
  seedStoryStateFromPromises,
  type StoryState
} from "@book-maker/core";
import { EDIT_ADHERENCE_FAILED, ReaderEditFailure } from "@book-maker/core/editFailure";
import { Prisma, prisma } from "@book-maker/db";
import type { ApplyBookEditJob } from "../runtime/jobPayloads.js";
import { randomUUID } from "node:crypto";
import type { DurableEditCompletionClaim } from "../runtime/durableEditCompletion.js";
import type { JobCompletion } from "../runtime/jobTypes.js";
import {
  adoptLegacyTextEditTail,
  publishTextEditManuscript,
  textEditPublicationCompletion,
  textEditPublicationIdentity,
  type TextEditMemoryEntry,
  type TextEditPublicationIdentity,
  type TextEditPublicationPage
} from "../generation/textEditPublication.js";

/**
 * `apply-book-edit` job: apply a user-approved edit to saved pages.
 */

/** Where in the `apply` step's own band each page's phases sit. */
const PAGE_PHASE_SHARE = { draft: 0.05, review: 0.6, save: 0.9 } as const;

type EditPagePhase = keyof typeof PAGE_PHASE_SHARE;

/** The `apply` step owns 40–75 of the job's progress column. */
function applyStepProgress(pagesDone: number, total: number): number {
  return 40 + Math.round((pagesDone / Math.max(total, 1)) * 35);
}

export async function applyBookEdit(job: ApplyBookEditJob): Promise<JobCompletion> {
  const {
    projectId,
    operationId,
    affectedPageIndexes,
    planId,
    exactReplacement,
    mode,
    perPageInstructions,
    generationJobId
  } = job.data;
  const operation = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
  if (!operation) {
    throw new Error("Book edit operation not found");
  }
  if (operation.kind === "RESTRUCTURE_PAGES") {
    // Forked on the operation's own column, not on the payload's
    // `structuralEdit`. The payload is JSON a hand-requeue or a reconciler can
    // rebuild without that field, and everything downstream of this line reads
    // a structural job as a text one: `affectedPageIndexes` is always empty for
    // this kind, so the rewrite loop below claims the operation ACTIVE and the
    // project EDITING *outside* the structural fence and then dies on "No
    // matching pages found for this edit" — a paid insert failed for a reason
    // that is not what went wrong, with the shift never attempted. `kind` is
    // written once, when the operation is created, and no later write touches
    // it; `restructurePages` finds the edit itself, on the payload or on the
    // classifier the same enqueue wrote it to.
    //
    // Forked *first* for the strongest version of the reason the image forks
    // are: this one commits an index shift, and its fence is a stamp written in
    // the same transaction as that shift. Reaching the unconditional ACTIVE
    // write below before the fence runs would put a redelivery on the far side
    // of it.
    return await restructurePages(job, operation);
  }
  if (operation.kind === "MOVE_IMAGE" || operation.kind === "REMOVE_IMAGE") {
    // On the column, for the same reason as above and with a worse failure
    // behind it. These two gated on `job.data.imageLayout`, so a job whose
    // payload was rebuilt without that key fell through to the rewrite loop —
    // and a layout payload's `affectedPageIndexes` is *not* empty, it names the
    // pages the pictures sit on. So "remove the illustration on page 3" was
    // handed to the prose rewriter as an instruction about page 3: two model
    // calls on an edit priced at zero, a page of prose replaced, snapshots and
    // an APPLIED operation claiming a text edit nobody asked for — all of it
    // outside the layout handler's own redelivery fence, because the
    // unconditional ACTIVE and EDITING writes below run before it. The
    // classifier carries the resolved intent the Apply wrote in the same
    // transaction as the operation row, so the handler finds the edit on either
    // copy; a job carrying neither settles as a delivered no-op, which is the
    // path a vanished picture already takes.
    await applyImageLayout(job, operation);
    return {};
  }
  if (operation.kind === "ADD_IMAGE") {
    // A paid one-off illustration, not a text rewrite. Forked before the
    // unconditional ACTIVE/EDITING writes below so the insertion can run its
    // own redelivery fence against the operation's pre-write status, and forked
    // on the column rather than on `job.data.imageInsertion` for the reason
    // above: the reader bought a picture, and the rewrite loop would have spent
    // the charge rewriting the page it was going on.
    await applyImageInsertion(job, operation);
    return {};
  }
  // Unlike an ordinary APPLIED text edit, this row changed no manuscript
  // revision and owns no publication tail. Its settlement completed the lease,
  // but the classifier marker is the durable fast-path for every sequential
  // redelivery and keeps this door safe even if lease bookkeeping is repaired.
  if (operation.status === "APPLIED" && textExactEditWasSkipped(operation.classifier)) {
    return {};
  }
  // The enqueue transaction already moved the project to EDITING. This stamp
  // is the only record of which settled status a text edit may restore when
  // its compile handoff cannot be queued; legacy jobs decode as COMPLETE.
  const fallbackStatus = preEditProjectStatus(job.data);
  const durableCompletion: DurableEditCompletionClaim = {
    generationJobId,
    projectId,
    operationId,
    attemptId: job.data.attemptId,
    type: "APPLY_BOOK_EDIT",
    message: "Book edit applied"
  };
  // Paid/operator retry paths intentionally replay the payload against the
  // FAILED operation row. Re-open only the status this delivery actually read;
  // an ordinary stalled ACTIVE delivery may never resurrect a winner's later
  // failure merely because it reached this line late.
  if (operation.status === "FAILED") {
    await prisma.bookEditOperation.updateMany({
      where: { id: operationId, status: "FAILED" },
      data: { status: "ACTIVE" }
    });
  }
  // A stalled Bull delivery and its replacement share both job ids. This token
  // identifies one invocation, and the database-time lease decides which one
  // may write the manuscript after a long provider call.
  const ownerToken = randomUUID();
  const claim = await waitForTextEditLease(operationId, ownerToken);
  if (claim.outcome === "completed" || claim.outcome === "settled") {
    return {};
  }
  if (claim.outcome === "abandoned") {
    throw new UnownedTextEditDeliveryError();
  }
  const heartbeat = startTextEditLeaseHeartbeat(operationId, ownerToken);
  if (claim.phase === "tail") {
    try {
      // Re-read under the claim. The snapshot above was taken before the lease
      // wait, which blocks for as long as another delivery holds the operation
      // — and that delivery is exactly the one that publishes the follow-up
      // checkpoint and rewrites `affectedPageIndexes` to the pages it actually
      // changed. Deciding modern-vs-legacy off the stale copy adopted a
      // published edit as a legacy one and checkpointed its export invalidation
      // as already done, so the stale files were never retired and the barrier
      // never cleared. `continueBook` and `replanEditCandidates` re-read here
      // for the same reason.
      const applied = await prisma.bookEditOperation.findUnique({
        where: { id: operationId },
        select: { classifier: true, affectedPageIndexes: true }
      });
      const replayPageIndexes = applied?.affectedPageIndexes ?? operation.affectedPageIndexes;
      // The same re-read answers the no-op door, which the entry check above
      // can only ask of a marker that was already there. A settlement that
      // landed while this delivery waited changed no manuscript revision and
      // owns no publication tail, so there is nothing here to replay: adopting
      // it as a legacy one claims the project's publication window, stamps a
      // `publicationRevision` on the one row that deliberately has none, and
      // queues a compile that deletes the finished PDF the reader is holding.
      // Only the lease is still owed, exactly as on the stood-down tail below.
      if (textExactEditWasSkipped(applied?.classifier ?? operation.classifier)) {
        await completeStoodDownTextEditTail(operationId, ownerToken);
        return {};
      }
      let identity = textEditPublicationIdentity(applied?.classifier, {
        projectId,
        operationId
      });
      let legacy = false;
      if (!identity) {
        legacy = true;
        identity = await adoptLegacyTextEditTail({
          projectId,
          operationId,
          ownerToken,
          ...(planId ? { planVersionId: planId } : {}),
          fallbackStatus
        });
      }
      if (!identity) {
        // Either a newer lifecycle owns the publication window or there is no
        // plan to compile against; both are terminal for an edit the reader
        // already has. The delivery still owes the APPLIED-tail completion, or
        // the operation keeps a live lease nobody is working under and every
        // redelivery waits out its expiry first.
        await completeStoodDownTextEditTail(operationId, ownerToken);
        return {};
      }
      return textEditPublicationCompletion({
        identity,
        ownerToken,
        memory: () => prepareReplayMemory(job, replayPageIndexes, identity!),
        durableCompletionCommitted: !legacy
      });
    } catch (error) {
      if (!isTextEditLeaseLostError(error)) throw error;
      if ((await waitForTextEditLeaseCompletion(operationId)) === "abandoned") {
        throw new UnownedTextEditDeliveryError();
      }
    } finally {
      await heartbeat.stop();
    }
    // The tail branch is the whole of this delivery. Falling through re-entered
    // drafting: a published edit drove its finished project back to EDITING and
    // re-applied the request over prose it had already changed — with the fence
    // permanently inert, because `heartbeat.stop()` above makes every later
    // `assertHeld()` a no-op.
    return {};
  }
  try {
    await prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { status: "EDITING" } });
      await assertTextEditLeaseTx(tx, operationId, ownerToken);
    });
    await advanceJobStep(generationJobId, "prepare", 20, "Preparing page edit");

    const [project, planVersion] = await Promise.all([
      getProjectOrThrow(projectId),
      planId ? prisma.planVersion.findUnique({ where: { id: planId } }) : null
    ]);
    if (!project.currentPlanId && !planId) {
      throw new Error("Cannot edit a book without a current plan");
    }
    const effectivePlanVersion =
      planVersion ?? (project.currentPlanId ? await prisma.planVersion.findUnique({ where: { id: project.currentPlanId } }) : null);
    if (!effectivePlanVersion) {
      throw new Error("Current plan not found");
    }
    const input = inputForPlanVersion(project, effectivePlanVersion.inputSnapshot);
    const plan = bookPlanSchema.parse(effectivePlanVersion.planningPackage);
    const strategy = strategyForInput(input);
    const providers = createLoggedProviders(job, createProviders(config, input), input);
    // One read of the operator's gates for the whole edit, the way a compile
    // reads them once for all of its passes. `rewritePageForUserRequest` used to
    // load its own per page and `persistKeeperStoryDelta` loaded another behind
    // it, so a ten-page edit spent twenty reads — and a Quality-tab save landing
    // between two of them ran the first pages of one edit under one gate
    // configuration and the rest under another.
    const quality = await loadQualityContext(input);
    const pages = await prisma.page.findMany({
      where: { projectId, index: { in: affectedPageIndexes } },
      orderBy: { index: "asc" },
      include: { chapter: true }
    });
    if (pages.length === 0) {
      throw new Error("No matching pages found for this edit");
    }

    await advanceJobStep(generationJobId, "snapshot", 35, `Preparing ${pages.length} page edit target(s)`, {
      done: 0,
      total: pages.length
    });
    // Rewriting is the long step, and one flat "applying" for the whole of it is
    // what made a multi-page edit look stalled. Each page reports itself three
    // times so both the bar and the phrase above it keep moving; the API turns
    // these counters into the words, this file never does.
    const reportPage = (page: { index: number }, offset: number, phase: EditPagePhase) =>
      advanceJobStep(
        generationJobId,
        "apply",
        applyStepProgress(offset + PAGE_PHASE_SHARE[phase], pages.length),
        `Applying edit to page ${page.index}`,
        { done: offset, total: pages.length, phase, pageIndex: page.index }
      );

    const { editInstruction, characterContext } = resolveEditPromptContext(operation, job.data);
    const storedExactReplacement = storedExactReplacementCandidate(operation.classifier);
    const candidateResult = await draftTextEditCandidates({
      projectId,
      pages,
      input,
      plan,
      strategy,
      providers,
      editInstruction,
      ...(characterContext ? { characterContext } : {}),
      perPageInstructions,
      exactReplacement,
      ...(storedExactReplacement.present
        ? { operationExactReplacement: storedExactReplacement.replacement }
        : {}),
      mode,
      quality,
      generationJobId,
      onPhase: reportPage
    });
    const { candidates, skippedPageIndexes, audit } = candidateResult;
    const updatedPageIndexes = candidates.map((candidate) => candidate.page.index);

    // `unverified` means the review did not run, not that the reader's edit was
    // refused. Keep the raw verdict in the audit, but do not discard delivered
    // candidates or enter the refund boundary over an absence of review.
    if (!candidateResult.satisfied && audit && audit.verdict.basis !== "unverified") {
      await prisma.$transaction(async (tx) => {
        await assertTextEditLeaseTx(tx, operationId, ownerToken);
        await tx.bookEditOperation.update({
          where: { id: operationId },
          data: { adherenceAudit: audit as unknown as Prisma.InputJsonValue }
        });
      });
      throw new ReaderEditFailure(EDIT_ADHERENCE_FAILED);
    }

    if (updatedPageIndexes.length === 0 && skippedPageIndexes.length > 0) {
      const settled = await settleSkippedExactTextEdit({
        job,
        projectId,
        operationId,
        ownerToken,
        skippedPageIndexes,
        fallbackStatus,
        assertLease: heartbeat.assertHeld
      });
      if (!settled && (await waitForTextEditLeaseCompletion(operationId)) === "abandoned") {
        throw new UnownedTextEditDeliveryError();
      }
      return {};
    }

    await advanceJobStep(generationJobId, "export", 85, "Refreshing exports");
    await heartbeat.assertHeld();
    // Embeddings and story extracts are provider work. Prepare every one before
    // the short publication transaction so a refusal or timeout leaves the live
    // manuscript and its snapshots untouched.
    const seedPromises = plan.promises ?? [];
    let currentState = await loadProjectStoryState(projectId, seedPromises);
    const prepared: Array<
      TextEditCandidate & {
        preparedEmbedding: Awaited<ReturnType<typeof prepareEmbedding>> | null;
        storyExtract: Awaited<ReturnType<typeof keeperStoryExtractForSave>>;
      }
    > = [];
    for (const candidate of candidates) {
      const { page, updated } = candidate;
      const preparedEmbedding = strategyUsesSemanticMemory(strategy)
        ? await prepareEmbedding(updated.summary, providers.embedding)
        : null;
      const draft = {
        title: updated.title,
        markdown: updated.markdown,
        summary: updated.summary,
        continuityNotes: updated.continuityNotes,
        ...(updated.imagePrompt ? { imagePrompt: updated.imagePrompt } : {})
      };
      const storyExtract = await keeperStoryExtractForSave({
        projectId,
        pageIndex: page.index,
        draft,
        textModel: providers.text,
        plan,
        input,
        previousExtract: null,
        keeperWasRevised: true,
        currentState,
        quality
      });
      if (storyExtract) {
        currentState = applyStoryDelta(currentState, storyExtract.storyDelta, page.index);
      }
      prepared.push({ ...candidate, preparedEmbedding, storyExtract });
    }
    const publishedPages: TextEditPublicationPage[] = prepared.map(
      ({ page, updated, preparedEmbedding, storyExtract }) => ({
        pageId: page.id,
        pageIndex: page.index,
        revisionBefore: page.revision,
        titleBefore: page.title,
        markdownBefore: page.markdown,
        summaryBefore: page.summary,
        imagePromptBefore: page.imagePrompt,
        qualityReportBefore: page.qualityReport,
        storyDeltaBefore: page.storyDelta,
        titleAfter: updated.title,
        markdownAfter: updated.markdown,
        summaryAfter: updated.summary,
        imagePromptAfter: updated.imagePrompt ?? page.imagePrompt,
        qualityReportAfter: updated.qualityReport,
        storyDeltaAfter: storyExtract?.storyDelta ?? page.storyDelta,
        // The rewrite loop's verdict is saved honestly: a page whose best
        // candidate still failed review stays flagged, so a later full compile's
        // repair pass can target it instead of it passing silently.
        statusAfter: updated.qualityReport.approved ? "COMPLETED" : "FAILED_QA",
        continuityNotes: updated.continuityNotes,
        preparedEmbedding
      })
    );
    const publication = await publishTextEditManuscript({
      projectId,
      operationId,
      ownerToken,
      planVersionId: effectivePlanVersion.id,
      fallbackStatus,
      editInstruction,
      audit,
      skippedPageIndexes,
      storyStateAfter: await storyStateForPublishedEdit(projectId, seedPromises, publishedPages),
      completion: durableCompletion,
      pages: publishedPages
    });
    return textEditPublicationCompletion({
      identity: publication.identity,
      ownerToken,
      memory: publication.memory
    });
  } catch (error) {
    if (!isTextEditLeaseLostError(error)) {
      throw error;
    }
    // The replacement owns every remaining write. Wait through its export
    // handoff so this invocation cannot mark the shared durable job complete
    // while the winner is still applying the edit.
    if ((await waitForTextEditLeaseCompletion(operationId)) === "abandoned") {
      throw new UnownedTextEditDeliveryError();
    }
  } finally {
    await heartbeat.stop();
  }
  return {};
}

/**
 * Derive the aggregate this edit publishes, rather than folding onto the one it
 * loaded.
 *
 * `applyStoryDelta` can only ever add: a fact is appended, a promise pushed or
 * marked, an entity field overwritten. Nothing in it retracts. So folding the
 * new extracts onto `Project.storyState` keeps every fact the edited pages used
 * to state — the page the reader has just paid to have a detail taken out of
 * goes on briefing every later draft, review and continuation with it, and only
 * an unrelated compile or Undo would ever re-derive it away. Which is why this
 * path has always rebuilt (`rebuildProjectStoryState`) instead.
 *
 * The rebuild runs in memory, over the deltas this publication is about to
 * write, so the aggregate still moves inside the one manuscript transaction
 * that moves the pages it is derived from — atomicity a post-commit rebuild
 * would give back. It reads what `rebuildStoryStateFromPages` reads and folds
 * it the same way, minus that helper's write and its CAS loop.
 */
async function storyStateForPublishedEdit(
  projectId: string,
  seedPromises: readonly string[],
  published: readonly Pick<TextEditPublicationPage, "pageIndex" | "storyDeltaAfter">[]
): Promise<StoryState> {
  const publishedDeltas = new Map(published.map((page) => [page.pageIndex, page.storyDeltaAfter]));
  const rows = await prisma.page.findMany({
    where: { projectId },
    orderBy: { index: "asc" },
    select: { index: true, storyDelta: true }
  });
  const deltas = rows.flatMap((row) => {
    const delta = parseStoryDelta(
      publishedDeltas.has(row.index) ? publishedDeltas.get(row.index) : row.storyDelta
    );
    return delta ? [{ pageIndex: row.index, delta }] : [];
  });
  return rebuildStoryState(deltas, seedStoryStateFromPromises(seedPromises));
}

/**
 * Complete the delivery marker for an APPLIED tail with nothing left to
 * publish. A false compare-and-set is ownership evidence and keeps the existing
 * wait/stand-down protocol; a thrown write has an unknown outcome, and failing
 * a delivered edit here would refund it.
 */
async function completeStoodDownTextEditTail(
  operationId: string,
  ownerToken: string
): Promise<void> {
  let completed: boolean;
  try {
    completed = await completeTextEditLease(operationId, ownerToken);
  } catch (error) {
    console.error("Text edit lease completion failed for a stood-down APPLIED tail", {
      event: "generation.text_edit_lease_completion_failed",
      operationId,
      phase: "applied-tail",
      recovery: "applied-tail-replay",
      error
    });
    return;
  }
  if (!completed && (await waitForTextEditLeaseCompletion(operationId)) === "abandoned") {
    throw new UnownedTextEditDeliveryError();
  }
}

/** Rebuild only a missing optional embedding tail on an APPLIED redelivery. */
async function prepareReplayMemory(
  job: ApplyBookEditJob,
  affectedPageIndexes: readonly number[],
  identity: TextEditPublicationIdentity
): Promise<TextEditMemoryEntry[]> {
  const [project, planVersion] = await Promise.all([
    getProjectOrThrow(identity.projectId),
    prisma.planVersion.findUnique({ where: { id: identity.planVersionId } })
  ]);
  if (!planVersion || project.contentRevision !== identity.publicationRevision) {
    return [];
  }
  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const strategy = strategyForInput(input);
  if (!strategyUsesSemanticMemory(strategy)) {
    return [];
  }
  const expectedPageIndexes = [...new Set(affectedPageIndexes)];
  if (expectedPageIndexes.length === 0) {
    throw new Error("Text edit memory replay is missing its affected page indexes");
  }
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  const pages = await prisma.page.findMany({
    where: {
      projectId: identity.projectId,
      index: { in: expectedPageIndexes }
    },
    orderBy: { index: "asc" },
    select: { id: true, index: true, revision: true, summary: true }
  });
  if (pages.length !== expectedPageIndexes.length) {
    throw new Error("Text edit memory replay could not resolve every affected page");
  }
  const prepared: TextEditMemoryEntry[] = [];
  for (const page of pages) {
    prepared.push({
      pageId: page.id,
      pageIndex: page.index,
      pageRevision: page.revision,
      summary: page.summary,
      preparedEmbedding: await prepareEmbedding(page.summary, providers.embedding)
    });
  }
  return prepared;
}
