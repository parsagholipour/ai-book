import {
  assetsImagePathFrom,
  compilePolicyPayload,
  compilePublicationDedupeKey,
  COVER_PURCHASE,
  creditPricing,
  includeCoverForSource,
  jsonRecord,
  publicAssetUrl,
  type CompilePublicationPolicy
} from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import { startGenerationAttempt } from "@book-maker/db/billing";
import { objectKey, objectStore } from "@book-maker/storage";
import { dispatchGenerationJob, enqueueGenerationJob } from "../../queue.js";
import { hasOpenProjectWork } from "../editOperations.js";
import { fingerprintGenerationRequest, jsonInputValue, versionedImageAssetUrl } from "../support.js";
import { publishBlockedReason, type ManuscriptProject } from "./manuscriptDerivation.js";
import type { ManuscriptCoverDto, ManuscriptCoverSource } from "./manuscriptDto.js";
import { storeManuscriptImage, UPLOADED_COVER_PREFIX } from "./manuscriptImages.js";
import type { ManuscriptWireContext } from "./manuscriptSerializers.js";
import { manuscriptIsPublished } from "./manuscriptStore.js";

/**
 * The cover of an author's book (spec "Covers"): the designed one every book
 * starts with (free), the author's own upload (free), or AI artwork at the
 * existing `coverRegeneration` price.
 *
 * The picture lives where every other cover does — the one COVER `ImageAsset`,
 * which the compile prints on the first sheet — and what *made* it is read off
 * that row's metadata, never the project settings: the worker writes
 * `coverArtSource: "design" | "ai"` on everything it renders, an upload writes
 * `source: "upload"`. That split is also what keeps a publish from redrawing
 * an upload or an AI cover for a retitle: publish only re-typesets a cover
 * whose metadata says `design`.
 *
 * A change to a published book's cover is a *presentation* change: nothing in
 * `Page.markdown` moves. So it goes the way `presentationEdits.ts` goes — one
 * transaction bumps `contentRevision`, moves the book to EDITING and writes an
 * undispatched presentation-only compile (the book's quality verdict stays),
 * plus, for a drawn cover, a revision-owned cover row shaped like publish's.
 * The compile stands down while the cover is open and the cover's completion —
 * or its failure, which never fails the book — queues it again.
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

const REFUSALS = {
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

const SETTLED_STATUSES = new Set(["COMPLETE", "REVIEW_REQUIRED"]);

/** Where the current cover came from, read off the row the worker (or an upload) wrote. */
export function coverSourceFromMetadata(metadata: unknown): ManuscriptCoverSource {
  const record = jsonRecord(metadata);
  if (record.source === "upload") return "upload";
  return record.coverArtSource === "ai" ? "ai" : "design";
}

/** What the book is asking a cover job to make: its settings, where only "ai" is not a design. */
function requestedCoverSource(mediaSettings: unknown): ManuscriptCoverSource {
  return jsonRecord(mediaSettings).coverArtSource === "ai" ? "ai" : "design";
}

export async function loadManuscriptCover(project: { id: string; mediaSettings: unknown }): Promise<ManuscriptCoverDto> {
  const [asset, openImageJobs] = await Promise.all([
    prisma.imageAsset.findFirst({
      where: { projectId: project.id, type: "COVER" },
      orderBy: { createdAt: "desc" },
      select: { id: true, path: true, metadata: true }
    }),
    prisma.generationJob.findMany({
      where: { projectId: project.id, type: "GENERATE_IMAGE", status: { in: ["QUEUED", "ACTIVE"] } },
      select: { payload: true }
    })
  ]);
  const pending = openImageJobs.some((job) => jsonRecord(job.payload).assetType === "COVER");
  return {
    source: pending || !asset ? requestedCoverSource(project.mediaSettings) : coverSourceFromMetadata(asset.metadata),
    // Versioned: a drawn cover is always `cover.<ext>`, so the bare path would
    // name yesterday's picture after a redraw.
    imageUrl: asset ? versionedImageAssetUrl(assetsImagePathFrom(asset.path) ?? asset.path, asset) : null,
    pending
  };
}

/** Everything `serializeManuscript` needs that is not one of its two rows. */
export async function manuscriptWireContext(project: { id: string; mediaSettings: unknown }): Promise<ManuscriptWireContext> {
  const [blocked, cover] = await Promise.all([publishBlockedReason(project.id), loadManuscriptCover(project)]);
  return { publishBlockedReason: blocked, cover };
}

/** A published book with a plan the compile can print from; covers of anything else wait for publish. */
function publishedPlanId(project: ManuscriptProject, firstPublishedAt: Date | null): string | null {
  return manuscriptIsPublished(project.mediaSettings, firstPublishedAt) ? project.currentPlanId : null;
}

type CoverChange = {
  /** Written onto the project and the current plan snapshot; absent keeps the book's setting. */
  coverArtSource?: "ai" | "design";
  /** The COVER row to install in the same commit (an upload). */
  asset?: { path: string; metadata: Record<string, unknown> };
  /** Queue a revision-owned cover job (a drawn cover). */
  drawCover?: { attemptId?: string; ledgerEntryId?: string | null; purchase: boolean };
};

/**
 * The one transaction every cover change of a published book makes. Takes the
 * project row lock first (the order publish and every edit use), refuses while
 * any job or chat Apply owns the book, and returns the job rows to dispatch
 * after commit.
 */
async function commitCoverChange(
  tx: Prisma.TransactionClient,
  projectId: string,
  change: CoverChange
): Promise<{ jobIds: string[]; primaryJobId: string; contentRevision: number; restoreStatus: string }> {
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { status: true, contentRevision: true, currentPlanId: true, mediaSettings: true }
  });
  if (!project?.currentPlanId) throw REFUSALS.publishFirst();
  const openOperations = await tx.bookEditOperation.count({ where: { projectId, status: { in: ["QUEUED", "ACTIVE"] } } });
  if (openOperations > 0 || (await hasOpenProjectWork(projectId))) throw REFUSALS.busy();
  if (!SETTLED_STATUSES.has(project.status)) throw REFUSALS.notSettled();
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
  const bumped = await tx.project.update({
    where: { id: projectId },
    data: {
      status: "EDITING",
      contentRevision: { increment: 1 },
      ...(sourcePatch ? { mediaSettings: jsonInputValue({ ...jsonRecord(project.mediaSettings), ...sourcePatch }) } : {})
    },
    select: { contentRevision: true }
  });
  if (sourcePatch) {
    // The cover job reads its source off the *plan snapshot*
    // (`inputForPlanVersion`), not the project row, so both say it.
    const plan = await tx.planVersion.findUnique({ where: { id: planId }, select: { inputSnapshot: true } });
    const snapshot = jsonRecord(plan?.inputSnapshot);
    await tx.planVersion.update({
      where: { id: planId },
      data: {
        inputSnapshot: jsonInputValue({
          ...snapshot,
          mediaSettings: { ...jsonRecord(snapshot.mediaSettings), ...sourcePatch }
        })
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
async function dispatchCoverJobs(projectId: string, committed: { jobIds: string[]; contentRevision: number; restoreStatus: string }) {
  try {
    for (const jobId of committed.jobIds) {
      await dispatchGenerationJob(jobId);
    }
  } catch (error) {
    console.error(`Writing Studio cover change could not dispatch its jobs for project ${projectId}`, error);
    await prisma.project
      .updateMany({
        where: { id: projectId, status: "EDITING", contentRevision: committed.contentRevision },
        data: { status: committed.restoreStatus as "COMPLETE" | "REVIEW_REQUIRED" }
      })
      .catch(() => undefined);
  }
}

/**
 * `PUT /manuscript/cover`: the author's own picture as the cover. Stored like
 * a manuscript picture (re-encoded, never SVG) under `cover-upload-<uuid>`.
 * Unpublished, that is all — the first publish finds a cover and draws none.
 * Published, the PDF is recompiled so it carries the new cover.
 */
export async function uploadManuscriptCover(options: {
  project: ManuscriptProject;
  firstPublishedAt: Date | null;
  bytes: Buffer;
  mimeType: string;
  publicApiUrl: string;
}): Promise<"stored" | "unsupported"> {
  const { project } = options;
  const planId = publishedPlanId(project, options.firstPublishedAt);
  if (planId && (await hasOpenProjectWork(project.id))) {
    throw REFUSALS.busy();
  }
  const stored = await storeManuscriptImage(project.id, options.bytes, options.mimeType, UPLOADED_COVER_PREFIX);
  if (!stored) {
    return "unsupported";
  }
  const asset = {
    path: publicAssetUrl(options.publicApiUrl, stored.url),
    metadata: {
      source: "upload",
      width: stored.width,
      height: stored.height,
      mimeType: stored.mimeType,
      bytes: stored.bytes,
      // An upload cost nothing to make; saying so keeps it out of the Costs
      // tab's "unpriced" bucket.
      costUsd: 0
    }
  };
  const previous = await prisma.imageAsset.findMany({
    where: { projectId: project.id, type: "COVER" },
    select: { path: true, metadata: true }
  });
  try {
    if (planId) {
      // Said as "design" too, so nothing later reads an old "ai" choice as a
      // reason to draw paid artwork over the author's picture.
      const committed = await prisma.$transaction((tx) =>
        commitCoverChange(tx, project.id, { asset, coverArtSource: "design" })
      );
      await dispatchCoverJobs(project.id, committed);
    } else {
      await prisma.$transaction(async (tx) => {
        await tx.imageAsset.deleteMany({ where: { projectId: project.id, type: "COVER" } });
        await tx.imageAsset.create({
          data: {
            projectId: project.id,
            type: "COVER",
            prompt: "A cover the author uploaded",
            provider: "upload",
            path: asset.path,
            metadata: jsonInputValue(asset.metadata)
          }
        });
      });
    }
  } catch (error) {
    await removeUnreferencedCoverObject(project.id, stored.filename, asset.path);
    throw error;
  }
  // The upload it replaced is nobody's picture any more. A drawn cover's
  // `cover.<ext>` is left alone: the next drawn cover writes over it.
  await removeUploadedCoverObjects(project.id, previous);
  return "stored";
}

/**
 * Whether a failed upload's object may go is decided by the rows, never by the
 * exception. A transaction that reports a failure may still have committed — a
 * connection dropped at COMMIT — and then the book's cover row names this very
 * object; deleting it on the strength of the throw left the book pointing at
 * nothing. So the object goes only when a re-read finds no row naming it, and a
 * re-read that cannot answer keeps it: an unreferenced `cover-upload-…` object
 * is reclaimed by the Studio image sweep after its grace period
 * (`studioImageSweep.ts`), while a deleted referenced one is gone for good.
 */
async function removeUnreferencedCoverObject(projectId: string, filename: string, path: string): Promise<void> {
  let referenced: boolean;
  try {
    referenced = (await prisma.imageAsset.count({ where: { projectId, path } })) > 0;
  } catch (error) {
    console.warn(`Kept cover object ${filename} for project ${projectId}: its rows could not be re-read`, error);
    return;
  }
  if (!referenced) {
    await removeCoverObject(projectId, filename);
  }
}

async function removeCoverObject(projectId: string, filename: string): Promise<void> {
  try {
    await objectStore().delete(objectKey("images", projectId, filename));
  } catch (error) {
    console.warn(`Could not remove cover object ${filename} for project ${projectId}`, error);
  }
}

/**
 * `POST /manuscript/cover/generate`: AI artwork, charged `coverRegeneration`
 * (`COVER_REGENERATION`) through `startGenerationAttempt` — the charge, the
 * EDITING move and both job rows commit together or not at all, and a replayed
 * requestId answers the attempt it already made.
 *
 * The attempt is the purchase, and only the cover job carries it — the compile
 * row does not. That job settles it on every path (`coverSettlement.ts`): its
 * completion commits it (the artwork is on the book whether or not the reprint
 * after it succeeds), a fallback to a design refunds `billingLedgerEntryId`
 * before that completion (`generateCover.ts`), a failure refunds it through
 * `markFailed` without failing the book, and a stop or stale cancellation
 * cancels and refunds it. A failed cover also releases the reprint, so the book
 * goes back to its settled status with the cover it had.
 */
export async function generateManuscriptCover(options: {
  userId: string;
  project: ManuscriptProject;
  firstPublishedAt: Date | null;
  requestId: string;
}): Promise<void> {
  const { project, requestId } = options;
  if (!publishedPlanId(project, options.firstPublishedAt)) {
    throw REFUSALS.publishFirst();
  }
  // The fast path; the transaction asks again under the project lock.
  if (await hasOpenProjectWork(project.id)) {
    throw REFUSALS.busy();
  }
  if (!SETTLED_STATUSES.has(project.status)) {
    throw REFUSALS.notSettled();
  }
  const cost = creditPricing().coverRegeneration;
  const holder: { committed?: Awaited<ReturnType<typeof commitCoverChange>> } = {};
  const started = await startGenerationAttempt({
    userId: options.userId,
    commandKey: `mobile:studio-cover:${project.id}:${requestId}`,
    requestFingerprint: fingerprintGenerationRequest({ projectId: project.id, requestId, coverArtSource: "ai" }),
    projectId: project.id,
    operation: "COVER_REGENERATION",
    quotedCredits: cost,
    description: "AI cover",
    metadata: { projectId: project.id, coverArtSource: "ai" },
    create: async (tx, { attemptId, ledgerEntry }) => {
      const committed = await commitCoverChange(tx, project.id, {
        coverArtSource: "ai",
        drawCover: { attemptId, ledgerEntryId: ledgerEntry?.id ?? null, purchase: true }
      });
      holder.committed = committed;
      return { projectId: project.id, primaryJobId: committed.primaryJobId };
    }
  });
  if (started.replayed || !holder.committed) {
    return;
  }
  await dispatchCoverJobs(project.id, holder.committed);
}

/**
 * `DELETE /manuscript/cover`: back to a designed cover, free. Published, a
 * designed cover is drawn now (the selector picks afresh: the one being
 * removed was never a design); unpublished, the cover row goes and the first
 * publish draws one.
 */
export async function resetManuscriptCover(options: { project: ManuscriptProject; firstPublishedAt: Date | null }): Promise<void> {
  const { project } = options;
  const current = await loadManuscriptCover(project);
  if (current.source === "design" && !current.pending && current.imageUrl !== null) {
    // Already a designed cover: nothing to put back, and nothing to redraw.
    return;
  }
  if (publishedPlanId(project, options.firstPublishedAt)) {
    const committed = await prisma.$transaction((tx) =>
      commitCoverChange(tx, project.id, { coverArtSource: "design", drawCover: { purchase: false } })
    );
    await dispatchCoverJobs(project.id, committed);
    return;
  }
  if (await hasOpenProjectWork(project.id)) {
    throw REFUSALS.busy();
  }
  const previous = await prisma.imageAsset.findMany({
    where: { projectId: project.id, type: "COVER" },
    select: { path: true, metadata: true }
  });
  await prisma.$transaction(async (tx) => {
    await tx.imageAsset.deleteMany({ where: { projectId: project.id, type: "COVER" } });
    // Merged onto the document as it is inside this transaction, not the copy
    // the route read (`updateManuscriptSettings` does the same).
    const live = await tx.project.findUnique({ where: { id: project.id }, select: { mediaSettings: true } });
    await tx.project.update({
      where: { id: project.id },
      data: {
        mediaSettings: jsonInputValue({
          ...jsonRecord(live?.mediaSettings ?? project.mediaSettings),
          coverArtSource: "design",
          includeCover: includeCoverForSource("design")
        })
      }
    });
  });
  await removeUploadedCoverObjects(project.id, previous);
}

async function removeUploadedCoverObjects(projectId: string, rows: ReadonlyArray<{ path: string; metadata: unknown }>) {
  for (const row of rows) {
    const filename = (assetsImagePathFrom(row.path) ?? row.path).split("/").pop() ?? "";
    if (coverSourceFromMetadata(row.metadata) === "upload" && filename.startsWith(UPLOADED_COVER_PREFIX)) {
      await removeCoverObject(projectId, filename);
    }
  }
}
