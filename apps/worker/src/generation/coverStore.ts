import { randomUUID } from "node:crypto";
import {
  COVER_ARTWORK_OBJECT_KEY,
  COVER_WIDTH,
  exportPublicationProjectStatusFromPayload,
  isCoverRetypesetPayload,
  jsonRecord,
  optimizeImageForStorage,
  publicAssetUrl,
  type CoverDesign,
  type CoverTemplateOverride
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { objectKey, objectStore } from "@book-maker/storage";
import { imageStorageMetadata } from "./bookHelpers.js";
import { config } from "../runtime/config.js";
import type { GenerateImageJob } from "../runtime/jobPayloads.js";
import { isStoppedGenerationJob, StopRequestedError } from "../runtime/jobTypes.js";

/**
 * The writes both cover paths make — a cover drawn or chosen (`generateCover`)
 * and a cover set again with new words (`coverRetypeset`) — so the two cannot
 * store a cover two ways.
 */

const COVER_FONTS = [
  "Inter (OFL-1.1)",
  "Source Serif 4 (OFL-1.1)",
  "Playfair Display (OFL-1.1)",
  "Nunito (OFL-1.1)",
  "Bebas Neue (OFL-1.1)",
  "Noto Sans (OFL-1.1)"
];

/**
 * Writes a candidate under its own key before replacing the book's COVER row.
 * The current row's bytes stay immutable if publication fails. Keep predecessors
 * for exports that still reference their URLs, and keep candidates on database
 * errors because the server may have committed before its response was lost.
 * Project deletion owns cleanup under this image prefix.
 */
export async function storeTypesetCover(options: {
  job: GenerateImageJob;
  /** A re-typeset may replace only the artwork it actually rendered. */
  currentCoverId?: string;
  coverPng: Buffer;
  prompt: string;
  provider: string;
  metadata: Record<string, unknown>;
}): Promise<"published" | "superseded" | "settled"> {
  const { projectId, planId, generationJobId, contentRevision } = options.job.data;
  const expectedStatus = exportPublicationProjectStatusFromPayload(options.job.data);
  const optimizedCover = await optimizeImageForStorage({ bytes: options.coverPng, mimeType: "image/png" });
  const filename = `cover-${randomUUID()}.${optimizedCover.extension}`;
  await objectStore().put(objectKey("images", projectId, filename), optimizedCover.bytes, {
    contentType: optimizedCover.mimeType
  });
  const publicPath = publicAssetUrl(config.PUBLIC_API_URL, `/assets/images/${projectId}/${filename}`);
  return prisma.$transaction(async (tx) => {
    // Stop and every cover change lock Project first, then GenerationJob.
    // Uploading a candidate can outlive either; publication has to ask again
    // while those locks exclude a newer change through the row replacement.
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "GenerationJob" WHERE "id" = ${generationJobId} FOR UPDATE`;
    const durable = await tx.generationJob.findUnique({
      where: { id: generationJobId },
      select: { projectId: true, type: true, status: true, contentRevision: true, payload: true, message: true, error: true }
    });
    if (isStoppedGenerationJob(durable)) throw new StopRequestedError();
    if (!durable || durable.status !== "ACTIVE") return "settled";
    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: { currentPlanId: true, contentRevision: true, status: true }
    });
    if (
      durable.projectId !== projectId || durable.type !== "GENERATE_IMAGE" ||
      jsonRecord(durable.payload).assetType !== "COVER" ||
      !project || project.currentPlanId !== planId ||
      (expectedStatus !== null && (
        project.status !== expectedStatus ||
        (contentRevision !== undefined && (
          project.contentRevision !== contentRevision || durable.contentRevision !== contentRevision
        ))
      ))
    ) return "superseded";
    if (options.currentCoverId !== undefined) {
      const current = await tx.imageAsset.findFirst({
        where: { projectId, type: "COVER" }, orderBy: { createdAt: "desc" }, select: { id: true }
      });
      if (current?.id !== options.currentCoverId) return "superseded";
    }
    await tx.imageAsset.deleteMany({ where: { projectId, type: "COVER" } });
    await tx.imageAsset.create({
      data: {
        projectId,
        type: "COVER",
        prompt: options.prompt,
        provider: options.provider,
        path: publicPath,
        metadata: {
          ...imageStorageMetadata(optimizedCover),
          ...options.metadata,
          renderer: "puppeteer",
          fonts: COVER_FONTS
        }
      }
    });
    if (isCoverRetypesetPayload(options.job.data)) {
      // Another delivery must see this publication as settled, not mistake
      // its replacement for a newer cover and cancel the shared book attempt.
      // Paid redraws still finish in the handler after any fallback refund.
      await tx.generationJob.update({
        where: { id: generationJobId },
        data: { status: "COMPLETED", finishedAt: new Date(), progress: 100 }
      });
    }
    return "published";
  });
}

/**
 * Keeps a model-drawn picture beside the cover it became, at the cover's own
 * width, so new words can be set over it later without drawing it again. Each
 * drawing owns its key: a failed cover publication must not change the artwork
 * the current COVER row still references. Predecessors and unpublished candidates
 * stay under the book's deletion-owned image prefix; deleting on a failed database
 * response could discard artwork whose cover actually committed.
 */
export async function storeCoverArtwork(
  projectId: string,
  artwork: { bytes: Buffer; mimeType: string }
): Promise<Record<string, unknown>> {
  const optimized = await optimizeImageForStorage({ bytes: artwork.bytes, mimeType: artwork.mimeType, maxWidth: COVER_WIDTH, quality: 90 });
  const key = objectKey("images", projectId, `cover-art-${randomUUID()}.${optimized.extension}`);
  await objectStore().put(key, optimized.bytes, { contentType: optimized.mimeType });
  return { [COVER_ARTWORK_OBJECT_KEY]: key, artworkStoredMimeType: optimized.mimeType };
}

/**
 * A design was authored as a whole, so it brings its own typography rather than
 * taking the book type's `coverTemplate` — which routes AI artwork.
 */
export function coverTemplateOverrideForDesign(design: CoverDesign): CoverTemplateOverride {
  return {
    id: design.template,
    ...(design.accentColor ? { accentColor: design.accentColor } : {}),
    ...(design.overlayCss ? { overlayCss: design.overlayCss } : {})
  };
}
