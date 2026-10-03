import {
  assetsImagePathFrom,
  creditPricing,
  includeCoverForSource,
  jsonRecord,
  publicAssetUrl
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { startGenerationAttempt } from "@book-maker/db/billing";
import { objectKey, objectStore } from "@book-maker/storage";
import {
  commitCoverChange,
  COVER_CHANGE_REFUSALS,
  COVER_CHANGE_SETTLED_STATUSES,
  dispatchCoverJobs
} from "../coverChange.js";
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

export { ManuscriptCoverRefusal } from "../coverChange.js";

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
    throw COVER_CHANGE_REFUSALS.busy();
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
    throw COVER_CHANGE_REFUSALS.publishFirst();
  }
  // The fast path; the transaction asks again under the project lock.
  if (await hasOpenProjectWork(project.id)) {
    throw COVER_CHANGE_REFUSALS.busy();
  }
  if (!COVER_CHANGE_SETTLED_STATUSES.has(project.status)) {
    throw COVER_CHANGE_REFUSALS.notSettled();
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
    throw COVER_CHANGE_REFUSALS.busy();
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
