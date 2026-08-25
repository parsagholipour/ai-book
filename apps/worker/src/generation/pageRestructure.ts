import { nextPlanVersion, planInputSnapshot } from "./bookHelpers.js";
import { acquireStructuralPageLeaseTx } from "./structuralPageLease.js";
import { stampLegacyGeneratedIllustrationOwnership } from "@book-maker/db/pageIllustrationOwnership";
import {
  bookPlanSchema,
  jsonRecord,
  MAX_STRUCTURAL_ARCHIVED_SNAPSHOTS,
  normalizePlanPageTargets,
  pageIndexMovesForStructuralPlan,
  parseStructuralApplication,
  reconcileStructuralPagePlan,
  type BookPlan,
  type CreateProjectInput,
  type PagePlacement,
  type StructuralApplication,
  type StructuralPageRefusal,
  type StructuralPagePlan
} from "@book-maker/core";
import {
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS,
  Prisma,
  applyPageOrder,
  deletePageContinuityNotes,
  deletePageEmbeddings,
  discardLegacyPageContinuityNotes,
  prisma,
  repointPageContinuityNotes,
  repointPageEmbeddings,
  repointedPageMapUpdate,
  shiftPageIndexes
} from "@book-maker/db";

/**
 * The one transaction that changes a finished book's shape.
 *
 * Everything here has to land together or not at all, and the reason is not
 * tidiness. Between the index shift and the plan-version write the book is a
 * manuscript whose page count does not match its plan snapshot, which is the
 * state `runDeterministicManuscriptChecks` calls `PAGE_COUNT_MISMATCH` and
 * `maybeEnqueueCompile` refuses to compile — so a crash in the middle leaves a
 * book that cannot rebuild its own exports. The delayed stranded sweep can
 * revisit it, but reaches the same `not-ready` answer; atomicity is what keeps
 * that unrecoverable intermediate state from committing.
 *
 * The last statement writes the stamp onto `BookEditOperation.classifier`. That
 * ordering *is* the redelivery fence: the stamp cannot exist without the shift
 * and the shift cannot exist without the stamp, so a second delivery finding
 * the stamp knows to resume rather than shift a second time.
 *
 * **And the stamp is read here, inside this transaction, because outside it the
 * fence only holds against a delivery that has already finished.** The handler
 * used to read the classifier, find no stamp, and shift — a read-then-write with
 * a whole transaction's worth of window between the two halves. Two deliveries
 * of one operation (a stalled BullMQ lock reclaimed, or the stray host worker
 * sharing the Docker stack's queue that `apps/worker/CLAUDE.md` names) therefore
 * both read "not shifted yet" and both shifted: `add 3 pages after page 10`
 * moved the tail down six and left six blank pages, and a move re-applied its
 * ordering on top of itself. Neither is recoverable, because the second shift's
 * own undo record describes a book that was already wrong. The claim below is
 * the first statement of the transaction, so it takes the operation row's write
 * lock: a concurrent delivery running it blocks there until this transaction
 * settles and then reads the row this one left, which is what makes the stamp a
 * compare-and-set rather than a read followed by a hopeful write.
 *
 * **Every read the shift is derived from is taken under that claim, and then
 * reconciled against.** The pages used to be read before the transaction opened,
 * which put the plan-version reads, the provider construction and the
 * transaction's own start between "what the book looks like" and "what is
 * written to it" — and `applyPageOrder` requires an ordering naming every page
 * of the project. A page created or deleted in that window (a continuation's
 * compensation, a manual-edit path, the stray host worker on the same queue) is
 * therefore a `23505` on `@@unique([projectId, index])` or a silent hole in
 * `1..N` that nothing notices until a compile refuses the book. Reading inside
 * the transaction narrows the window to the statements between the read and the
 * ordering write; `reconcileStructuralPagePlan` (core) is what makes what is
 * written *safe for whatever that read saw*, the same way `restoredPageOrder`
 * has always made the undo side safe. Nothing here may go back to reading a page
 * row before the claim.
 *
 * **The plan version's own number is one of those reads.** `nextPlanVersion`
 * used to run before the transaction opened, so the whole shift — the lease CAS,
 * the page reads, the deletes, the reorder — sat between "what number is free"
 * and the `create` that takes it, and `PlanVersion` carries
 * `@@unique([projectId, version])`. Any writer committing a plan version for
 * this project in that window turned the create into a `23505` that rolled the
 * entire shift back, and `apply-book-edit` has no retry budget
 * (`retryJobOptions` names three job types and this is not one), so the delivery
 * went straight to `markFailed`: the edit failed and refunded over a number
 * nobody was looking at. It is derived below instead, one statement after the
 * base version's own row lock — which is the lock every writer that supersedes
 * a plan before creating the next one already blocks on — and the create is
 * retried once on a conflict, which is safe *because* every read is now inside:
 * a second attempt re-reads and re-reconciles rather than replaying stale
 * numbers.
 */

export type StructuralTransactionOptions = {
  projectId: string;
  operationId: string;
  request: string;
  plan: StructuralPagePlan;
  bookPlan: BookPlan;
  input: CreateProjectInput;
  basePlanVersionId: string;
  previousTargetPages: number;
  ownerToken: string;
};

/**
 * What this delivery was allowed to do, which is not always "shift the book".
 *
 * `already-applied` is a delivery whose winner still owns the stamped edit, so
 * its caller waits rather than drafting the same ids. `resumed` is a crash
 * redelivery that acquired the expired lease, either at drafting or at the
 * post-APPLIED tail. `settled` is an operation somebody failed or cancelled
 * outright while this delivery was preparing. `stale` is the book itself having moved: the plan resolved
 * against a read that no longer describes it and re-fitting it under the claim
 * produced no book, so the caller settles it free the way it settles a resolver
 * refusal — same `StructuralPageRefusal` vocabulary, so the reader's card gets
 * the same sentence either way.
 */
export type StructuralPageChangeResult =
  | { outcome: "applied"; application: StructuralApplication }
  | {
      outcome: "resumed";
      phase: "draft" | "tail";
      application: StructuralApplication | null;
    }
  | { outcome: "already-applied"; application: StructuralApplication | null; retryAt: Date }
  | { outcome: "completed" }
  | { outcome: "settled" }
  | { outcome: "stale"; reason: StructuralPageRefusal };

/**
 * How many times the whole shift may be replayed after losing the version race.
 *
 * One. A single competing commit is what the race actually is; a second
 * conflict would mean sustained contention on one project's plan versions,
 * which nothing in the product produces and which a loop should not sit and
 * fight for a 30 s transaction's worth of writes at a time.
 */
const PLAN_VERSION_CONFLICT_RETRIES = 1;

export async function applyStructuralPageChange(
  options: StructuralTransactionOptions
): Promise<StructuralPageChangeResult> {
  const { projectId } = options;

  const shift = async (tx: Prisma.TransactionClient) => {
    // Project is the root lock for every edit transaction that can later touch
    // both Project and BookEditOperation. Stop holds Project before it revokes
    // the operation lease; taking the lease first here inverted that order and
    // let cancellation deadlock against a structural publication.
    await tx.project.update({
      where: { id: projectId },
      data: { contentRevision: { increment: 0 } }
    });

    // --- The claim, and it is the redelivery fence -------------------------
    // First operation-row statement on purpose: one database-time CAS both takes the row lock
    // and installs this delivery's expiring owner token. The old ACTIVE update
    // fenced only the index shift — ACTIVE matched ACTIVE, so its transaction
    // loser received the winner's stamp and then drafted, settled and rolled
    // back as if it owned it. A live owner now makes the loser report
    // `already-applied`; an expired owner makes a crash redelivery `resumed`.
    const lease = await acquireStructuralPageLeaseTx(tx, options.operationId, options.ownerToken);
    if (lease.outcome === "settled" || lease.outcome === "completed") {
      return { outcome: lease.outcome };
    }
    if (lease.outcome === "busy") {
      console.warn("Structural page edit stood down: another delivery owns the stamped edit", {
        event: "generation.structural_delivery_lost_claim",
        projectId,
        operationId: options.operationId,
        action: options.plan.action
      });
      return {
        outcome: "already-applied" as const,
        application: lease.application,
        retryAt: lease.retryAt
      };
    }
    if (lease.phase === "tail" || lease.application) {
      return {
        outcome: "resumed" as const,
        phase: lease.phase,
        application: lease.application
      };
    }
    const held = await tx.bookEditOperation.findUnique({
      where: { id: options.operationId },
      select: { classifier: true }
    });
    const alreadyApplied = parseStructuralApplication(held?.classifier);
    if (alreadyApplied) {
      return { outcome: "resumed" as const, phase: "draft" as const, application: alreadyApplied };
    }

    // --- The book, read under the claim ------------------------------------
    // `chapterId` rides this read rather than earning one of its own: it is the
    // same pre-edit snapshot the undo record, the embedding re-point and the
    // page map are all derived from, and `pagesToRehome` compares against it.
    // It is read *here* rather than before the transaction because everything
    // below is written from it — see the note at the top of this file, and
    // `reconcileStructuralPagePlan` for what a plan resolved against an older
    // read does to `applyPageOrder`.
    const pagesBefore = await tx.page.findMany({
      where: { projectId },
      orderBy: { index: "asc" },
      select: {
        id: true,
        index: true,
        chapterId: true,
        images: { select: { id: true, type: true, path: true, metadata: true } }
      }
    });
    const reconciliation = reconcileStructuralPagePlan(options.plan, pagesBefore);
    if (!reconciliation.ok) {
      // Nothing has been written yet, so this commits the claim and no more.
      // The caller settles it free rather than failing a book that is fine.
      console.warn("Structural page edit stood down: the book changed before the shift could run", {
        event: "generation.structural_plan_stale",
        projectId,
        operationId: options.operationId,
        action: options.plan.action,
        reason: reconciliation.reason
      });
      return { outcome: "stale" as const, reason: reconciliation.reason };
    }
    const plan = reconciliation.plan;
    if (reconciliation.drifted) {
      // Never silent: the shift still lands, but on a book the card did not
      // quite describe, and the run log is the only record of which one.
      console.warn("Structural page edit re-fitted its plan to a book that moved under it", {
        event: "generation.structural_plan_reconciled",
        projectId,
        operationId: options.operationId,
        action: plan.action,
        plannedPages: options.plan.totalPages,
        totalPages: plan.totalPages
      });
    }
    const chapters = await tx.chapter.findMany({
      where: { projectId },
      select: { id: true, index: true, targetPages: true }
    });
    // Read whole, before anything is deleted: `PageEditSnapshot` cascades on
    // `Page`, so a deleted page's own undo record dies with it. The removed
    // pages ride the classifier instead, the way image undo already restores
    // assets. Read under the claim too, so the record is of the rows this
    // transaction is about to take rather than of rows some other path may
    // already have taken — an undo replaying the latter puts back a page
    // somebody else deliberately removed.
    const removedPages =
      plan.removedPageIds.length > 0
        ? await tx.page.findMany({
            where: { projectId, id: { in: plan.removedPageIds } },
            orderBy: { index: "asc" },
            include: { images: { select: { id: true } } }
          })
        : [];
    const snapshotsToArchive =
      plan.removedPageIds.length > 0
        ? await tx.pageEditSnapshot.findMany({
            where: { projectId, pageId: { in: plan.removedPageIds } },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }]
          })
        : [];
    if (snapshotsToArchive.length > MAX_STRUCTURAL_ARCHIVED_SNAPSHOTS) {
      // The claim is the only write so far. Commit it and settle this free,
      // exactly like a stale plan, rather than truncating an older undo chain
      // or trying to move unbounded history inside the transaction ceiling.
      console.warn("Structural page edit stood down: deleted pages carry too much undo history", {
        event: "generation.structural_snapshot_archive_too_large",
        projectId,
        operationId: options.operationId,
        snapshotCount: snapshotsToArchive.length,
        maximum: MAX_STRUCTURAL_ARCHIVED_SNAPSHOTS
      });
      return { outcome: "stale" as const, reason: "undo_history_too_large" as const };
    }
    const extendedPlan = planWithChapterTargets(
      projectId,
      options.bookPlan,
      chapters,
      plan.chapterPageCounts,
      plan.totalPages
    );

    // Page-scoped rows that remain without stable Page ownership cannot safely
    // be adopted by their current index: an older edit may have
    // reused that number already. They are excluded from generation reads and
    // retired at the first structural change instead of being attributed to a
    // different page.
    await discardLegacyPageContinuityNotes(tx, projectId);

    // A reserved numeric filename names this pre-edit index. Preserve the
    // stable Page ownership before insert/delete/move changes that number, so
    // a later keeper replacement can retire the old generated render without
    // mistaking a user-moved hero (whose filename names another source page)
    // for system-owned output of this page.
    await stampLegacyGeneratedIllustrationOwnership(tx, projectId, pagesBefore);

    if (plan.action === "insert") {
      await shiftPageIndexes(tx, projectId, { afterIndex: plan.insertAfterIndex, delta: plan.newPageIndexes.length });
      await tx.page.createMany({
        data: plan.newPageIndexes.map((index) => ({
          projectId,
          chapterId: plan.newPageChapterId,
          index,
          title: `Page ${index}`,
          markdown: "",
          summary: "",
          status: "PENDING"
        }))
      });
    } else {
      if (plan.removedPageIds.length > 0) {
        if (snapshotsToArchive.length > 0) {
          // Preserve every field and the original primary key before Page's
          // cascade takes the live rows. `archiveKey` has no structural-op FK:
          // if that operation is permanently retired, these rows continue to
          // block a partial Undo of the older operation while its page is gone.
          await tx.archivedPageEditSnapshot.createMany({
            data: snapshotsToArchive.map((snapshot) => ({
              id: snapshot.id,
              projectId: snapshot.projectId,
              pageId: snapshot.pageId,
              operationId: snapshot.operationId,
              archiveKey: options.operationId,
              pageIndex: snapshot.pageIndex,
              titleBefore: snapshot.titleBefore,
              markdownBefore: snapshot.markdownBefore,
              summaryBefore: snapshot.summaryBefore,
              revisionBefore: snapshot.revisionBefore,
              ...(snapshot.storyDeltaBefore === null
                ? {}
                : { storyDeltaBefore: snapshot.storyDeltaBefore as Prisma.InputJsonValue }),
              titleAfter: snapshot.titleAfter,
              markdownAfter: snapshot.markdownAfter,
              summaryAfter: snapshot.summaryAfter,
              revisionAfter: snapshot.revisionAfter,
              createdAt: snapshot.createdAt
            })),
            skipDuplicates: true
          });
        }
        await deletePageContinuityNotes(tx, projectId, plan.removedPageIds);
        // Their semantic memory first, while their ids are still the thing that
        // names it: `Embedding` has no foreign key to `Page`, so nothing else
        // ever takes these rows, and the reorder below hands their
        // `page:<index>` scopes to the pages moving up.
        await deletePageEmbeddings(tx, projectId, plan.removedPageIds);
        // Before the reorder: pass two of the shift lands survivors on indexes
        // the deleted pages still hold otherwise.
        await tx.page.deleteMany({ where: { projectId, id: { in: plan.removedPageIds } } });
      }
      await applyPageOrder(tx, projectId, plan.order);
      for (const [chapterId, pageIds] of pagesToRehome(plan.order, pagesBefore)) {
        await tx.page.updateMany({
          // Named rows only, and no chapter predicate — see `pagesToRehome`.
          where: { id: { in: pageIds }, projectId },
          data: { chapterId }
        });
      }
    }

    // One derivation for both re-points: it maps every page of the book, and
    // neither callee mutates what it is handed (both only read `pageId`/`index`
    // to build their statements), so the second walk bought nothing inside a
    // transaction on a 30 s ceiling.
    const moved = movedPageOrder(plan, pagesBefore);
    await repointPageContinuityNotes(tx, projectId, moved);
    await repointPageEmbeddings(tx, projectId, moved);

    for (const chapter of chapters) {
      const count = plan.chapterPageCounts[chapter.id];
      if (count !== undefined && count !== chapter.targetPages) {
        await tx.chapter.update({ where: { id: chapter.id }, data: { targetPages: count } });
      }
    }

    await tx.planVersion.update({ where: { id: options.basePlanVersionId }, data: { status: "SUPERSEDED" } });
    // Derived here rather than before the transaction, and here rather than at
    // the top of it: the statement above holds the base version's row lock, and
    // superseding the plan it is replacing is what every other writer that adds
    // a version to a book does first too (`continueBook`, `replanBook`,
    // `revisePlan`). So a competitor is already blocked behind that row by the
    // time this read runs, and the number it answers with cannot be one such a
    // competitor is about to commit. What it does not fence is a writer that
    // takes no such lock — the operator's `plan-book` route, the plan repair
    // script — which is what the retry around this transaction is for.
    const version = await nextPlanVersion(projectId, tx);
    const created = await tx.planVersion.create({
      data: {
        projectId,
        version,
        status: "APPROVED",
        approvedAt: new Date(),
        planningPackage: extendedPlan as unknown as Prisma.InputJsonValue,
        // The snapshot, not the project row, is what `inputForPlanVersion`
        // reads — and a compile that sees a page count other than this one
        // publishes a correct book flagged REVIEW_REQUIRED.
        inputSnapshot: planInputSnapshot({ ...options.input, targetPages: plan.totalPages }),
        messages: [
          { role: "user", content: `Restructure pages: ${options.request}`.slice(0, 2000), at: new Date().toISOString() }
        ]
      }
    });
    // Read inside the transaction, and immediately before the write: a compile
    // that published between the two would have its map clobbered either way,
    // and this is the narrowest that window gets without a second lock.
    const stored = await tx.project.findUnique({ where: { id: projectId }, select: { pdfPageMap: true } });
    await tx.project.update({
      where: { id: projectId },
      data: {
        currentPlanId: created.id,
        targetPages: plan.totalPages,
        // The map is measured against the old pagination and deliberately kept
        // in force during EDITING, because the reader is still looking at the
        // PDF it describes until the recompile lands — so a reader's "page 12"
        // has to keep meaning the printed page 12 in front of them. What this
        // edit moved is the model indexes on the far side of it, so those are
        // re-pointed rather than the whole map thrown away; the recompile
        // measures a new one over it. See `repointedPageMapUpdate` for what a
        // map that cannot keep every range degrades to.
        ...repointedPageMapUpdate(stored?.pdfPageMap, pageIndexMovesForStructuralPlan(plan, pagesBefore))
      }
    });

    const application: StructuralApplication = {
      action: plan.action,
      pageOrderBefore: pagesBefore.map((page) => ({
        pageId: page.id,
        index: page.index,
        // A move may re-home a page below. Keep its old membership beside its
        // old index so both API Undo and drafting-failure rollback can restore
        // the complete pre-edit shape.
        ...(page.chapterId === undefined ? {} : { chapterId: page.chapterId })
      })),
      insertedPageIds: [],
      removedPages: removedPages.map((page) => ({
        id: page.id,
        index: page.index,
        chapterId: page.chapterId,
        title: page.title,
        markdown: page.markdown,
        summary: page.summary,
        imagePrompt: page.imagePrompt,
        revision: page.revision,
        ...(page.storyDelta === null ? {} : { storyDelta: page.storyDelta }),
        // The page's state rides the record with its prose. Undo recreates the
        // row from this and nothing else, so a field left out here is a field
        // the reader silently loses: a `FAILED_QA` page would come back
        // approved, and `imageFailureReason` is the marker
        // `projectAlreadyIllustrated` reads to know a free-tier illustrated-book
        // slot was already spent.
        status: page.status,
        ...(page.qualityReport === null ? {} : { qualityReport: page.qualityReport }),
        ...(page.imageFailureReason === null ? {} : { imageFailureReason: page.imageFailureReason }),
        imageAssetIds: page.images.map((image) => image.id)
      })),
      ...(snapshotsToArchive.length > 0
        ? {
            snapshotArchive: {
              key: options.operationId,
              snapshotCount: snapshotsToArchive.length
            }
          }
        : {}),
      basePlanVersionId: options.basePlanVersionId,
      newPlanVersionId: created.id,
      previousTargetPages: options.previousTargetPages,
      previousChapterTargetPages: Object.fromEntries(
        chapters.map((chapter) => [chapter.id, chapter.targetPages])
      ),
      appliedAt: new Date().toISOString()
    };
    if (plan.action === "insert") {
      const inserted = await tx.page.findMany({
        where: { projectId, index: { in: plan.newPageIndexes } },
        orderBy: { index: "asc" },
        select: { id: true }
      });
      application.insertedPageIds = inserted.map((page) => page.id);
    }

    // Last, always: the stamp is what a redelivery reads to know the shift
    // already happened, so it may never be visible before the shift is.
    await tx.bookEditOperation.update({
      where: { id: options.operationId },
      data: {
        classifier: {
          // The copy read under this transaction's own lock, never one the
          // caller carried in: a rollback or a retry may have rewritten the
          // classifier since, and merging onto a stale copy would put back
          // whatever it took off.
          ...jsonRecord(held?.classifier),
          structuralApplication: application
        } as Prisma.InputJsonValue
      }
    });
    return { outcome: "applied" as const, application };
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(shift, PAGE_RESTRUCTURE_TRANSACTION_OPTIONS);
    } catch (error) {
      if (attempt >= PLAN_VERSION_CONFLICT_RETRIES || !isPlanVersionNumberConflict(error)) {
        throw error;
      }
      // Nothing was written — the conflict rolled the shift back whole — so the
      // replay starts from the same place the first attempt did: the lease CAS
      // re-acquires under this delivery's own token, and every read is taken
      // again. A book the winner changed underneath this edit therefore reaches
      // `reconcileStructuralPagePlan` on the second attempt exactly as it would
      // have on the first, and may still answer `stale`.
      console.warn("Structural page edit lost the plan-version number and is replaying its shift", {
        event: "generation.structural_plan_version_conflict",
        projectId,
        operationId: options.operationId,
        action: options.plan.action
      });
    }
  }
}

/**
 * A `23505` on `PlanVersion`'s `@@unique([projectId, version])`, and only that.
 *
 * Read off the error's own `code` and `meta` rather than through
 * `instanceof Prisma.PrismaClientKnownRequestError`, because this predicate sits
 * on the failure path of a 30 s transaction where the error may be anything at
 * all — a timeout, a dropped connection, a `StopRequestedError` raised under it.
 * It has to be able to answer "no" for every one of those without depending on
 * the concrete class it was handed, or the retry decision becomes its own way of
 * losing the original error.
 *
 * Narrow on purpose: the other unique indexes this transaction can violate are
 * `Page`'s and `Chapter`'s `@@unique([projectId, index])`, which
 * `reconcileStructuralPagePlan` is what answers. Neither names a `version`
 * column, so a replay can never be a retry of one of those.
 */
function isPlanVersionNumberConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const known = error as { code?: unknown; meta?: { modelName?: unknown; target?: unknown } | undefined };
  if (known.code !== "P2002") {
    return false;
  }
  if (known.meta?.modelName === "PlanVersion") {
    return true;
  }
  // Older engines report the constraint name instead of the column list.
  const target = known.meta?.target;
  const named = Array.isArray(target) ? target.join(",") : typeof target === "string" ? target : "";
  return named.includes("version");
}

/**
 * Every page whose index changed, as `{ pageId, index }` at its new home.
 *
 * An insert moves the tail without naming it in an ordering, so it is derived
 * from the pages that existed before rather than read off the plan.
 */
function movedPageOrder(
  plan: StructuralPagePlan,
  pagesBefore: readonly { id: string; index: number }[]
): { pageId: string; index: number }[] {
  if (plan.action !== "insert") {
    return plan.order.map((placement) => ({ pageId: placement.pageId, index: placement.index }));
  }
  const delta = plan.newPageIndexes.length;
  return pagesBefore
    .filter((page) => page.index > plan.insertAfterIndex)
    .map((page) => ({ pageId: page.id, index: page.index + delta }));
}

/**
 * The pages this edit re-homes, grouped by the chapter each one lands in.
 *
 * `plan.order` names **every** page of the book — `pageOrderStatements` requires
 * that — so a statement per placement was a round trip per page inside a
 * transaction with a 30 s ceiling, and almost every one of them wrote nothing. A
 * chapter is stored only as `Page.chapterId` and never as a range of indexes, so
 * renumbering a page cannot move it between chapters: a delete carries every
 * survivor's own chapter through untouched, and a move re-homes only the pages
 * it moved, into the single chapter they land in. That is why the grouping
 * collapses to no statement at all for a delete and one for a move, rather than
 * one per page either way.
 *
 * **This grouping is the whole filter: the write carries no chapter predicate.**
 * It used to carry `chapterId: { not: chapterId }` as a second opinion, so that a
 * page already sitting in its destination cost nothing. The loop below already
 * decides that — a placement naming the chapter the page holds is skipped, `null`
 * to `null` included — so the guard filtered nothing out, and on a nullable
 * column it filtered something *in*: Prisma compiles `{ not: v }` to a bare
 * `"chapterId" <> $1` (7.8.0, checked against the emitted SQL — no
 * `IS DISTINCT FROM`, no `OR … IS NULL`), which is UNKNOWN for a row whose
 * chapter is null and therefore never updates it. A page in no chapter is an
 * ordinary book shape rather than a theoretical one — `Page.chapter` is
 * `onDelete: SetNull`, and the whole-book save paths store a page outside every
 * chapter range with a null id — so moving one into the middle of chapter 2 left
 * it printed inside chapter 2 while belonging to no chapter at all, with the
 * heading walk and `chapterPageCounts` (which counts only truthy ids) then
 * describing a book other than the one on disk.
 *
 * A placement this snapshot cannot account for is still *named* rather than
 * skipped, and that case is unreachable rather than merely handled:
 * `reconcileStructuralPagePlan` holds the ordering to the very read `pagesBefore`
 * comes from, so a placement naming a page the book does not hold is dropped
 * before it gets here — and one that survived anyway matches no row.
 */
function pagesToRehome(
  order: readonly PagePlacement[],
  pagesBefore: readonly { id: string; chapterId: string | null }[]
): Map<string | null, string[]> {
  const held = new Map(pagesBefore.map((page) => [page.id, page.chapterId]));
  const grouped = new Map<string | null, string[]>();
  for (const placement of order) {
    // `undefined` is an ordering that does not track chapters at all, which is
    // not the same as a page belonging to none — see `PagePlacement.chapterId`.
    if (placement.chapterId === undefined || placement.chapterId === held.get(placement.pageId)) {
      continue;
    }
    const named = grouped.get(placement.chapterId);
    if (named) {
      named.push(placement.pageId);
    } else {
      grouped.set(placement.chapterId, [placement.pageId]);
    }
  }
  return grouped;
}

/**
 * The plan with its chapter targets and total length brought back in line.
 *
 * The compile places every printed chapter heading by walking these targets
 * cumulatively (`chapterStartsForPages`, and `normalizePlanPageTargets`
 * wherever a page count has moved), so targets that no longer sum to the
 * book's length put the headings on the wrong pages and drop the last ones off
 * the end of a book that shrank — a re-chaptering nobody asked for.
 *
 * **The returned plan's targets always sum to `totalPages`.** They have to: the
 * `inputSnapshot` written in the same statement as this plan already carries
 * that number, the two are one record of the same book, and `inputForPlanVersion`
 * reads the snapshot. A plan left untouched beside a snapshot that moved is
 * exactly the drift this function exists to prevent.
 *
 * The measured page distribution is the source of truth wherever there is one,
 * and it runs out in two places — neither of which may return the plan as it
 * came in:
 *
 * - **Nothing matched.** `chapterPageCounts` is keyed on `Page.chapterId`, so a
 *   book whose pages all carry a null one measures nothing at all. `Page.chapter`
 *   is `onDelete: SetNull` and the whole-book paths save a page outside every
 *   chapter range with a null id, so this is a real book shape rather than a
 *   theoretical one — and it is the one where the plan's chapters are the *only*
 *   partition the printed book has left.
 * - **The tail chapter cannot absorb the rest.** A page in no chapter still
 *   counts toward the book, so the last chapter takes whatever the per-chapter
 *   counts do not explain; that is the reconciliation which leaves every earlier
 *   chapter's start page exactly where the reader last saw it. It bottoms out at
 *   one page, and a book that lost more than the tail had is re-partitioned by
 *   `normalizePlanPageTargets` — the same proportional re-fit every other
 *   page-count change in the pipeline goes through — rather than left short.
 */
function planWithChapterTargets(
  projectId: string,
  plan: BookPlan,
  chapters: readonly { id: string; index: number }[],
  counts: Record<string, number>,
  totalPages: number
): BookPlan {
  const countByChapterIndex = new Map<number, number>();
  for (const chapter of chapters) {
    const count = counts[chapter.id];
    if (count !== undefined) {
      countByChapterIndex.set(chapter.index, count);
    }
  }
  const rebalanced = plan.chapters.map((chapter) => ({
    ...chapter,
    targetPages: countByChapterIndex.get(chapter.index) ?? chapter.targetPages
  }));
  const planned = rebalanced.reduce((sum, chapter) => sum + chapter.targetPages, 0);
  const last = rebalanced.at(-1);
  if (last && planned !== totalPages) {
    last.targetPages = Math.max(1, last.targetPages + (totalPages - planned));
  }
  const settled = rebalanced.reduce((sum, chapter) => sum + chapter.targetPages, 0);
  const repartitioned = settled !== totalPages;
  if (repartitioned || countByChapterIndex.size === 0) {
    // The silent version of this was the bug: the plan came back untouched and
    // the snapshot beside it already said the book was a different length.
    console.warn("Structural page edit reconciled the plan's chapter targets without a full page count", {
      event: "generation.consistency_warning",
      warning: repartitioned ? "structural_chapter_targets_repartitioned" : "structural_chapter_targets_unmeasured",
      projectId,
      measuredChapters: countByChapterIndex.size,
      planChapters: plan.chapters.length,
      plannedPages: settled,
      totalPages
    });
  }
  const reconciled = { ...plan, chapters: rebalanced };
  return bookPlanSchema.parse(repartitioned ? normalizePlanPageTargets(reconciled, totalPages) : reconciled);
}
