import {
  compilePolicyPayload,
  compilePublicationDedupeKey,
  COVER_PURCHASE,
  includeCoverForSource,
  jsonRecord,
  type CompilePublicationPolicy
} from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { hasOpenProjectWork } from "./editOperations.js";
import { jsonInputValue } from "./support.js";

/**
 * One change to how a finished book is presented — its cover, its title or
 * both — in one transaction: a revision bump to EDITING, an undispatched
 * presentation-only compile (the book's quality verdict stays) and, for a drawn
 * cover, a revision-owned cover row. The compile stands down while the cover is
 * open, and the cover's completion — or its failure, which never fails the book
 * — queues it again.
 *
 * The Writing Studio's cover routes (`manuscript/manuscriptCover.ts`) and the
 * chat's title edit (`bookTitleEdits.ts`) both commit through here.
 */
export class ManuscriptCoverRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export const COVER_CHANGE_REFUSALS = {
  busy: () =>
    new ManuscriptCoverRefusal(
      409,
      "PROJECT_BUSY",
      "Your book is still being worked on. Change the cover once the current job finishes."
    ),
  publishFirst: () =>
    new ManuscriptCoverRefusal(409, "PUBLISH_FIRST", "Publish your book first — then you can generate a cover for it."),
  notSettled: () =>
    new ManuscriptCoverRefusal(409, "BOOK_NOT_READY", "Your book needs to finish updating before its cover can change.")
} as const;

export const COVER_CHANGE_SETTLED_STATUSES = new Set(["COMPLETE", "REVIEW_REQUIRED"]);

export type CoverChange = {
  /** Written onto the project and the current plan snapshot; absent keeps the book's setting. */
  coverArtSource?: "ai" | "design";
  /** The COVER row to install in the same commit (an upload). */
  asset?: { path: string; metadata: Record<string, unknown> };
  /** Queue a revision-owned cover job (a drawn cover). */
  drawCover?: { attemptId?: string; ledgerEntryId?: string | null; purchase: boolean };
  /**
   * A new title, written to every copy a reader can see it in the same commit:
   * the project row (the app, the cover typesetting, file names, shares) and
   * the current plan (the compile's title page, cover alt text and EPUB and
   * Word metadata, on both the worker and the API's inline rebuild).
   */
  title?: string;
  /** Merged onto the project's `mediaSettings` in the same commit. */
  mediaSettingsPatch?: Record<string, unknown>;
};

export type CommittedCoverChange = {
  jobIds: string[];
  primaryJobId: string;
  contentRevision: number;
  restoreStatus: string;
};

/**
 * The one transaction every cover or title change of a finished book makes.
 * Takes the project row lock first (the order publish and every edit use),
 * refuses while any job or chat Apply owns the book, and returns the job rows
 * to dispatch after commit.
 */
export async function commitCoverChange(
  tx: Prisma.TransactionClient,
  projectId: string,
  change: CoverChange
): Promise<CommittedCoverChange> {
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { status: true, contentRevision: true, currentPlanId: true, mediaSettings: true }
  });
  if (!project?.currentPlanId) throw COVER_CHANGE_REFUSALS.publishFirst();
  const openOperations = await tx.bookEditOperation.count({ where: { projectId, status: { in: ["QUEUED", "ACTIVE"] } } });
  if (openOperations > 0 || (await hasOpenProjectWork(projectId))) throw COVER_CHANGE_REFUSALS.busy();
  if (!COVER_CHANGE_SETTLED_STATUSES.has(project.status)) throw COVER_CHANGE_REFUSALS.notSettled();
  const fallbackStatus = project.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE";
  const planId = project.currentPlanId;

  if (change.asset) {
    await tx.imageAsset.deleteMany({ where: { projectId, type: "COVER" } });
    await tx.imageAsset.create({
      data: {
        projectId,
        type: "COVER",
        prompt: "A cover the author uploaded",
        provider: "upload",
        path: change.asset.path,
        metadata: jsonInputValue(change.asset.metadata)
      }
    });
  }
  const sourcePatch = change.coverArtSource
    ? { coverArtSource: change.coverArtSource, includeCover: includeCoverForSource(change.coverArtSource) }
    : null;
  const settingsPatch = sourcePatch || change.mediaSettingsPatch ? { ...change.mediaSettingsPatch, ...sourcePatch } : null;
  const bumped = await tx.project.update({
    where: { id: projectId },
    data: {
      status: "EDITING",
      contentRevision: { increment: 1 },
      ...(change.title !== undefined ? { title: change.title } : {}),
      ...(settingsPatch ? { mediaSettings: jsonInputValue({ ...jsonRecord(project.mediaSettings), ...settingsPatch }) } : {})
    },
    select: { contentRevision: true }
  });
  if (sourcePatch || change.title !== undefined) {
    // The cover job reads its source off the *plan snapshot*
    // (`inputForPlanVersion`), not the project row, so both say it; and the
    // compile prints the plan's title, so the plan says the new one.
    const plan = await tx.planVersion.findUnique({
      where: { id: planId },
      select: { inputSnapshot: true, planningPackage: true }
    });
    const snapshot = jsonRecord(plan?.inputSnapshot);
    await tx.planVersion.update({
      where: { id: planId },
      data: {
        inputSnapshot: jsonInputValue({
          ...snapshot,
          ...(change.title !== undefined ? { title: change.title } : {}),
          ...(sourcePatch ? { mediaSettings: { ...jsonRecord(snapshot.mediaSettings), ...sourcePatch } } : {})
        }),
        ...(change.title !== undefined
          ? { planningPackage: jsonInputValue({ ...jsonRecord(plan?.planningPackage), title: change.title }) }
          : {})
      }
    });
  }
  const contentRevision = bumped.contentRevision;
  const attemptId = change.drawCover?.attemptId;
  const policy: CompilePublicationPolicy = {
    review: { skipFinalReview: true, withoutQualityVerdict: false },
    expectedProjectStatus: "EDITING",
    ownership: { kind: "presentation", fallbackStatus }
  };
  // The compile is free presentation work and never carries the purchase's
  // attempt: the cover job alone settles that (`coverSettlement.ts`), so a
  // refunded purchase cannot stand the reprint down as stale, and a reprint
  // that fails after the artwork landed cannot leave the purchase open.
  const compile = await enqueueGenerationJob({
    projectId,
    type: "COMPILE_EXPORT",
    dedupeKey: compilePublicationDedupeKey({ projectId, planId, contentRevision, policy, projectStatus: "EDITING" }),
    contentRevision,
    payload: { planId, contentRevision, ...compilePolicyPayload(policy, "EDITING") },
    transaction: tx,
    dispatch: false
  });
  if (!change.drawCover) {
    return { jobIds: [compile.id], primaryJobId: compile.id, contentRevision, restoreStatus: fallbackStatus };
  }
  const ledgerEntryId = change.drawCover.ledgerEntryId;
  const cover = await enqueueGenerationJob({
    projectId,
    type: "GENERATE_IMAGE",
    dedupeKey: `generate-cover:${projectId}:${planId}:revision-${contentRevision}:status-EDITING`,
    contentRevision,
    payload: {
      planId,
      assetType: "COVER",
      contentRevision,
      exportPublicationProjectStatus: "EDITING",
      // A cover the reader bought on its own: this job's attempt is the
      // purchase, and the worker settles it off this flag (`COVER_PURCHASE`).
      ...(change.drawCover.purchase ? { [COVER_PURCHASE]: true } : {}),
      ...(ledgerEntryId ? { billingLedgerEntryId: ledgerEntryId } : {})
    },
    transaction: tx,
    dispatch: false,
    ...(attemptId ? { attemptId } : {})
  });
  return { jobIds: [compile.id, cover.id], primaryJobId: cover.id, contentRevision, restoreStatus: fallbackStatus };
}

/**
 * Dispatch after commit. A failure leaves the durable rows for the
 * undispatched-job sweep; the book is put back to its settled status so it is
 * not left EDITING behind jobs that may be late (publish's own fallback). A
 * cover job that then runs against the settled book stands down as stale, and
 * a paid one is refunded by that cancellation.
 */
export async function dispatchCoverJobs(projectId: string, committed: CommittedCoverChange): Promise<void> {
  try {
    for (const jobId of committed.jobIds) {
      await dispatchGenerationJob(jobId);
    }
  } catch (error) {
    console.error(`A cover or title change could not dispatch its jobs for project ${projectId}`, error);
    await prisma.project
      .updateMany({
        where: { id: projectId, status: "EDITING", contentRevision: committed.contentRevision },
        data: { status: committed.restoreStatus as "COMPLETE" | "REVIEW_REQUIRED" }
      })
      .catch(() => undefined);
  }
}
