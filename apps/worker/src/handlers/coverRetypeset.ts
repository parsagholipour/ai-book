import {
  bookPlanSchema,
  COVER_ARTWORK_OBJECT_KEY,
  coverDesign,
  coverRetypesetSource,
  coverTypesetFor,
  jsonRecord,
  renderCoverPng,
  type CoverTemplateOverride
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { objectStore } from "@book-maker/storage";
import { coverMetadataFromProject, getProjectOrThrow } from "../generation/bookHelpers.js";
import { coverDesignArtwork } from "../generation/coverArtwork.js";
import { coverTemplateOverrideForDesign, storeTypesetCover } from "../generation/coverStore.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { advanceJobStep, cancelStaleGenerationJob, updateJobProgress } from "../runtime/jobLifecycle.js";
import type { GenerateImageJob } from "../runtime/jobPayloads.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";

/**
 * A cover set again over the picture it already wears (`COVER_RETYPESET`):
 * the title, subtitle and byline re-typeset from the book's row, the artwork
 * taken from the catalog design it was rendered from or from the drawn artwork
 * stored beside it. No model call, no charge.
 *
 * **It never fails, and it never draws.** It runs in two places — while a book
 * is still being written, where a cover job's failure is the *book's* failure
 * (`markFailed` on a fully paid run), and over a published book, where the
 * reprint waits on it. Neither may be lost over a cover that kept its old
 * words, so anything but a stop leaves the cover as it is and completes; the
 * fan-in after it reads the same words again and, finding this job's dedupe key
 * already spent, compiles with the cover the book has. A cover with nothing to
 * re-set from — an upload, or a drawn cover from before artwork was kept — is
 * the same no-op: changing the words in its pixels is a paid redraw, which only
 * the reader can choose.
 */
export async function retypesetCover(job: GenerateImageJob): Promise<void> {
  try {
    await setCoverAgain(job);
  } catch (error) {
    if (isStopRequestedError(error)) throw error;
    console.warn(`Could not set the cover of project ${job.data.projectId} again; it keeps its words`, error);
    try {
      await updateJobProgress(job.data.generationJobId, { message: "Cover kept as it was" });
    } catch {
      // Bookkeeping about a cover that already kept its words.
    }
  }
}

/** Storage facts of the row being replaced, which the new file restates for itself. */
const STORAGE_KEYS = new Set([
  "mimeType",
  "originalMimeType",
  "optimized",
  "maxWidth",
  "originalBytes",
  "outputBytes",
  "originalWidth",
  "originalHeight",
  "width",
  "height",
  "renderer",
  "fonts"
]);

async function setCoverAgain(job: GenerateImageJob): Promise<void> {
  const { projectId, planId, generationJobId } = job.data;
  const [project, planVersion, current] = await Promise.all([
    getProjectOrThrow(projectId),
    prisma.planVersion.findUnique({ where: { id: planId } }),
    prisma.imageAsset.findFirst({ where: { projectId, type: "COVER" }, orderBy: { createdAt: "desc" } })
  ]);
  if (!planVersion || !current) {
    await advanceJobStep(generationJobId, "store", 90, "No cover to set again");
    return;
  }
  const previous = jsonRecord(current.metadata);
  const picture = await pictureToSetAgain(previous);
  if (!picture) {
    await advanceJobStep(generationJobId, "store", 90, "Cover kept as it was");
    return;
  }

  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const plan = bookPlanSchema.parse(planVersion.planningPackage);
  const metadata = coverMetadataFromProject(project, plan);
  await advanceJobStep(generationJobId, "render", 68, "Setting the cover's words again");
  const coverPng = await renderCoverPng({
    input,
    plan,
    metadata,
    artwork: picture.artwork,
    ...(picture.template ? { template: picture.template } : {})
  });

  await advanceJobStep(generationJobId, "store", 84, "Storing cover");
  const publication = await storeTypesetCover({
    job,
    currentCoverId: current.id,
    coverPng,
    prompt: current.prompt,
    provider: current.provider,
    metadata: {
      ...Object.fromEntries(Object.entries(previous).filter(([key]) => !STORAGE_KEYS.has(key))),
      // Everything else — the drawing's provenance and its cost — still describes the picture.
      typeset: coverTypesetFor(metadata),
      retypesetAt: new Date().toISOString()
    }
  });
  if (publication === "superseded") {
    await cancelStaleGenerationJob(job, "The book or its cover changed while the cover was being typeset.");
  }
}

async function pictureToSetAgain(
  previous: Record<string, unknown>
): Promise<{ artwork: { bytes: Buffer; mimeType: string }; template?: CoverTemplateOverride } | undefined> {
  const source = coverRetypesetSource(previous);
  if (source === "design") {
    const design = coverDesign(String(previous.coverDesignId));
    if (!design) return undefined;
    const artwork = await coverDesignArtwork(design);
    return { artwork: { bytes: artwork.bytes, mimeType: artwork.mimeType }, template: coverTemplateOverrideForDesign(design) };
  }
  if (source === "artwork") {
    const bytes = await objectStore().get(String(previous[COVER_ARTWORK_OBJECT_KEY]));
    if (!bytes) return undefined;
    const mimeType = typeof previous.artworkStoredMimeType === "string" ? previous.artworkStoredMimeType : "image/jpeg";
    return { artwork: { bytes, mimeType } };
  }
  return undefined;
}
