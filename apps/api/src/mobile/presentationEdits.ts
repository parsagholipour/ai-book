import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { type ProjectForChat } from "./projectChat.js";
import { jsonInputValue, jsonRecord } from "./support.js";
import {
  compilePolicyPayload,
  compilePublicationDedupeKey,
  compilePublicationPolicyFromPayload,
  PRESENTATION_ONLY_RECOMPILE,
  type CompilePublicationPolicy
} from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * The mechanism shared by every *presentation* edit: a change to how the book
 * is compiled rather than to what it says.
 *
 * These are free by construction. Nothing in `Page.markdown` moves, no model
 * runs, and no `BookEditOperation` or ledger entry is created — the change is
 * one field on `Project.mediaSettings` plus a recompile. The durable compile
 * intent is written in the same transaction as that field and carries
 * `skipFinalReview`, so the QA repair pass cannot rewrite prose the user never
 * asked to touch. Redis dispatch happens only after commit; the undispatched
 * job sweep recovers a crash or outage in that handoff.
 *
 * It is queued `presentationOnly`, and that is what keeps the book's quality
 * verdict intact. With no final review the recompile's own report is the
 * deterministic checks alone; read as the project's verdict it would delete
 * every chapter-coherence and final-QA finding the book earned — and the
 * `affectedPageIndexes` the quality card's "Fix page N" button is built from —
 * because a reader toggled the Sources list. The prose those findings describe
 * has not changed, so the older verdict is still the true one.
 *
 * Callers keep their own no-op guards and their own copy; only this step is
 * common. See `backMatterEdits.ts` (the Sources list) and
 * `chapterHeadingEdits.ts` (chapter headings).
 */
export async function applyPresentationPreference(
  project: ProjectForChat & { currentPlanId: string },
  patch: Record<string, unknown>
): Promise<void> {
  // The preference, EDITING transition, revision bump and durable outbox row
  // are one commit. A detached repair for the previous presentation therefore
  // either commits before this transaction or loses its publication claim;
  // there is never a committed EDITING revision with no policy source for the
  // stranded-generation reconciler to recover.
  const generationJob = await prisma.$transaction(async (tx) => {
    // This UPDATE is the row lock and the intended revision bump. At
    // READ COMMITTED, PostgreSQL waits for a concurrent updater and applies
    // the increment to the row version that updater committed; RETURNING then
    // gives us that same live version. Build the mediaSettings merge only
    // after it returns — parameters supplied to the locking statement itself
    // would have been captured before the wait and could overwrite the winner.
    const claimed = await tx.project.update({
      where: { id: project.id },
      data: {
        contentRevision: { increment: 1 }
      },
      select: {
        contentRevision: true,
        currentPlanId: true,
        mediaSettings: true,
        status: true
      }
    });
    if (claimed.currentPlanId === null) {
      throw new Error(`Cannot apply a presentation edit without a current plan for project ${project.id}`);
    }
    // A second presentation change can arrive while the first compile still
    // owns EDITING. The project row no longer says which settled status that
    // compile must restore, so recover it from the policy durably attached to
    // the compile for the revision we just superseded. Concurrent presentation
    // edits serialize at the claim above, so the later one sees both the first
    // preference and the compile row its transaction committed.
    let fallbackStatus = claimed.status === "REVIEW_REQUIRED"
      ? "REVIEW_REQUIRED" as const
      : claimed.status === "COMPLETE"
        ? "COMPLETE" as const
        : null;
    if (fallbackStatus === null) {
      if (claimed.status !== "EDITING") {
        throw new Error(`Cannot apply a presentation edit while project ${project.id} is ${claimed.status}`);
      }
      const predecessor = await tx.generationJob.findFirst({
        where: {
          projectId: project.id,
          type: "COMPILE_EXPORT",
          contentRevision: claimed.contentRevision - 1,
          payload: { path: [PRESENTATION_ONLY_RECOMPILE], equals: true }
        },
        orderBy: { createdAt: "desc" },
        select: { payload: true }
      });
      const predecessorPolicy = predecessor
        ? compilePublicationPolicyFromPayload(predecessor.payload)
        : null;
      if (predecessorPolicy?.ownership.kind !== "presentation") {
        // EDITING is not evidence that the book was previously COMPLETE. A
        // missing policy is safer to roll back than to publish unchanged,
        // still-flagged prose under the wrong settled status.
        throw new Error(`Cannot recover presentation compile policy for project ${project.id}`);
      }
      fallbackStatus = predecessorPolicy.ownership.fallbackStatus;
    }
    await tx.project.update({
      where: { id: project.id },
      data: {
        mediaSettings: jsonInputValue({ ...jsonRecord(claimed.mediaSettings), ...patch }),
        status: "EDITING"
      }
    });
    const policy: CompilePublicationPolicy = {
      review: { skipFinalReview: true, withoutQualityVerdict: false },
      expectedProjectStatus: "EDITING",
      ownership: { kind: "presentation", fallbackStatus }
    };
    const payload = {
      planId: claimed.currentPlanId,
      contentRevision: claimed.contentRevision,
      ...compilePolicyPayload(policy, "EDITING")
    };
    return enqueueGenerationJob({
      projectId: project.id,
      type: "COMPILE_EXPORT",
      payload,
      dedupeKey: compilePublicationDedupeKey({
        projectId: project.id,
        planId: claimed.currentPlanId,
        contentRevision: claimed.contentRevision,
        policy,
        projectStatus: "EDITING"
      }),
      contentRevision: claimed.contentRevision,
      transaction: tx,
      dispatch: false
    });
  });
  await dispatchGenerationJob(generationJob.id);
}
