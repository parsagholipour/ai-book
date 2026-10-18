import {
  coverMetadataFromProject,
  getProjectOrThrow,
  imageGenerationMetadata,
  strategyForInput
} from "../generation/bookHelpers.js";
import { coverTemplateOverrideForDesign, storeCoverArtwork, storeTypesetCover } from "../generation/coverStore.js";
import { retypesetCover } from "./coverRetypeset.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { coverImageSelectionForInput, createImageAdapterForSelection, createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { advanceJobStep, cancelStaleGenerationJob, updateJobProgress } from "../runtime/jobLifecycle.js";
import {
  bookPlanSchema,
  bookSeriesFromMediaSettings,
  buildCoverArtworkPrompt,
  coverArtSourceFor,
  coverDesign,
  coverTypesetFor,
  createProviders,
  isCoverPurchasePayload,
  isCoverRetypesetPayload,
  isRevisionOwnedCoverPayload,
  jsonRecord,
  renderCoverPng,
  selectCoverDesign,
  type CoverDesign,
  type CoverTemplateOverride
} from "@book-maker/core";
import { characterReferencePromptInstruction, selectCoverReferenceImagePaths } from "../generation/characterReferences.js";
import { characterReferenceAssetsOrNone } from "../generation/characterReferenceTolerance.js";
import { coverDesignArtwork } from "../generation/coverArtwork.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { prisma } from "@book-maker/db";
import { refundCreditLedgerEntry } from "@book-maker/db/billing";
import type { GenerateImageJob } from "../runtime/jobPayloads.js";

/**
 * `generate-cover` work: cover artwork plus the character reference images that
 * keep illustrated casts visually consistent.
 */

export async function generateCover(job: GenerateImageJob) {
  if (isCoverRetypesetPayload(job.data)) {
    await retypesetCover(job);
    return;
  }
  const { projectId, planId, generationJobId } = job.data;
  const [project, planVersion] = await Promise.all([
    getProjectOrThrow(projectId),
    prisma.planVersion.findUnique({ where: { id: planId } })
  ]);
  if (!planVersion) {
    throw new Error("Plan not found for cover generation");
  }

  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const coverArtSource = coverArtSourceFor(input.mediaSettings);
  if (coverArtSource === "none") {
    // The compile check fires from maybeCompileAfterCompletedJob once this
    // job's row is COMPLETED; from in here it always counted itself as open.
    await advanceJobStep(generationJobId, "store", 90, "Cover disabled");
    return;
  }

  const strategy = strategyForInput(input);
  const coverImageSelection = coverImageSelectionForInput(input);
  const baseProviders = createProviders(config, input);
  const providers = createLoggedProviders(
    job,
    coverImageSelection ? { ...baseProviders, image: createImageAdapterForSelection(coverImageSelection) } : baseProviders,
    input,
    { imageSelection: coverImageSelection }
  );
  const plan = bookPlanSchema.parse(planVersion.planningPackage);
  const metadata = coverMetadataFromProject(project, plan);
  // Outside the artwork guard below, and deliberately tolerant instead: the
  // sheets are an enhancement to the cover, never a precondition for one, and
  // this call is the only thing between a finished book and `markFailed`'s
  // refund of the whole run. See `characterReferenceTolerance.ts`.
  const characterReferences = await characterReferenceAssetsOrNone(
    {
      projectId,
      planId,
      input,
      plan,
      providers,
      strategy,
      generationJobId
    },
    "cover"
  );
  await advanceJobStep(generationJobId, "prompt", 20, "Building cover prompt");

  // A revision-owned job is a book the reader already holds, re-typeset for a new
  // manuscript revision — a Studio publish that changed the title or byline. Its
  // designed cover keeps the artwork the reader chose to keep, and only the
  // typography moves; asking the selector again could hand the same book a
  // different picture for a one-word title change.
  const keptDesign = coverArtSource === "design" && isRevisionOwnedCoverPayload(job.data)
    ? await currentCoverDesign(projectId)
    : undefined;
  // A series book wears its earlier book's design, so the covers read as one
  // series: the artwork is the design's, the title typeset over it is this book's.
  const seriesDesignId = coverArtSource === "design" && !keptDesign ? bookSeriesFromMediaSettings(input.mediaSettings)?.coverDesignId : undefined;
  const seriesDesign = seriesDesignId ? coverDesign(seriesDesignId) : undefined;
  const designedCover = async (fallbackReason?: string): Promise<CoverArtworkResult> => {
    await updateJobProgress(generationJobId, { message: "Choosing a cover design" });
    const choice: { design: CoverDesign; selectedBy: string; reason?: string } = keptDesign
      ? { design: keptDesign, selectedBy: "kept" }
      : seriesDesign
        ? { design: seriesDesign, selectedBy: "series" }
        : await selectCoverDesign({
          textModel: providers.text,
          input,
          plan,
          seed: projectId,
          title: metadata.title,
          subtitle: metadata.subtitle,
          bailOnError: isStopRequestedError
        });
    await advanceJobStep(generationJobId, "render", 45, `Rendering the ${choice.design.name} cover`);
    const artwork = await coverDesignArtwork(choice.design);
    return {
      artwork: { bytes: artwork.bytes, mimeType: artwork.mimeType },
      prompt: `Designed cover: ${choice.design.name} — ${choice.design.description}`,
      provider: BUNDLED_COVER_PROVIDER,
      template: coverTemplateOverrideForDesign(choice.design),
      metadata: {
        coverArtSource: "design",
        coverDesignId: choice.design.id,
        coverDesignName: choice.design.name,
        coverDesignSelectedBy: choice.selectedBy,
        coverDesignArtwork: artwork.source,
        coverTemplate: choice.design.template,
        artworkMimeType: artwork.mimeType,
        // A bundled design costs nothing, and saying so keeps it out of the
        // Costs tab's "unpriced" bucket, which means understated real spend.
        costUsd: 0,
        ...(choice.reason ? { coverDesignReason: choice.reason } : {}),
        ...(fallbackReason ? { coverFallbackReason: fallbackReason } : {})
      }
    };
  };

  let cover: CoverArtworkResult;
  let purchasedArtworkFailed = false;
  if (coverArtSource === "design") {
    cover = await designedCover();
  } else {
    const baseArtworkPrompt = buildCoverArtworkPrompt({ input, plan, metadata });
    const references = await selectCoverReferenceImagePaths({
      input,
      plan,
      assets: characterReferences,
      projectId,
      image: providers.image,
      artworkPrompt: baseArtworkPrompt
    });
    const referenceImagePaths = references.paths;
    // A function of what is attached: the instruction counts the pictures and
    // names the last few, so a fallback taking fewer re-states it.
    const promptForReferenceImages = (attached: readonly string[]) =>
      [
        baseArtworkPrompt,
        characterReferencePromptInstruction(references, attached)
      ].filter(Boolean).join("\n");
    const artworkPrompt = promptForReferenceImages(referenceImagePaths);

    await advanceJobStep(generationJobId, "render", 45, "Rendering cover artwork");
    try {
      const artwork = await strategy.generateImageBytes({
        image: providers.image,
        prompt: artworkPrompt,
        projectId,
        referenceImagePaths,
        promptForReferenceImages,
        aspectRatio: "3:4"
      });
      cover = {
        artwork: { bytes: artwork.bytes, mimeType: artwork.mimeType },
        prompt: artworkPrompt,
        provider: artwork.provider,
        metadata: {
          coverArtSource: "ai",
          model: artwork.model,
          artworkMimeType: artwork.mimeType,
          revisedPrompt: artwork.revisedPrompt,
          ...imageGenerationMetadata(artwork),
          coverTemplate: input.mediaSettings.coverTemplate,
          sourceImageProvider: artwork.provider,
          sourceImageModel: artwork.model,
          characterReferenceCount: referenceImagePaths.length
        }
      };
    } catch (error) {
      if (isStopRequestedError(error)) {
        throw error;
      }
      // The cover is the last thing a book makes, so every page is already
      // written and charged for. Failing here used to mark the project FAILED
      // and refund the whole run; a designed cover finishes the book instead.
      await updateJobProgress(generationJobId, {
        message: "Cover artwork failed; falling back to a designed cover"
      });
      cover = await designedCover("ai_cover_failed");
      purchasedArtworkFailed = isCoverPurchase(job);
      if (purchasedArtworkFailed) {
        cover.metadata = { ...cover.metadata, coverPurchaseRefunded: true };
      }
    }
  }

  await advanceJobStep(generationJobId, "render", 68, "Rendering cover typography");
  const coverPng = await renderCoverPng({
    input,
    plan,
    metadata,
    artwork: cover.artwork,
    ...(cover.template ? { template: cover.template } : {})
  });

  await advanceJobStep(generationJobId, "store", 84, "Storing cover");
  // A drawn picture is kept beside the cover it became, so new words — a pen
  // name typed while the book was still being written, a new title — can be set
  // over it later for free (`coverRetypeset.ts`). A design is the catalog's to keep.
  const artworkRecord = cover.metadata.coverArtSource === "ai" ? await keptArtworkRecord(projectId, cover.artwork) : {};
  const publication = await storeTypesetCover({
    job,
    coverPng,
    prompt: cover.prompt,
    provider: cover.provider,
    metadata: { ...cover.metadata, ...artworkRecord, typeset: coverTypesetFor(metadata) }
  });
  if (publication === "superseded") {
    await cancelStaleGenerationJob(job, "The book changed while the cover was being rendered.");
  }
  if (publication !== "published") return;
  if (purchasedArtworkFailed) {
    await refundPurchasedCover(job);
  }
}

/**
 * A cover the reader bought on its own — the Writing Studio's "Generate with
 * AI" (`apps/api/src/mobile/manuscript/manuscriptCover.ts`) — rather than one
 * that came with a book. Its payload says so and names the charge.
 */
function isCoverPurchase(job: GenerateImageJob): boolean {
  return isCoverPurchasePayload(job.data) && Boolean(job.data.billingLedgerEntryId);
}

/**
 * The artwork a purchase paid for could not be drawn, and the book got a free
 * designed cover instead: the charge goes back. The job itself succeeded, and
 * its completion closes the purchase's attempt (`attemptCompletesWithJob`), so
 * the ledger entry is refunded here, before that; a refund is one cumulative
 * reversal per charge, so any later settlement tops it up to nothing.
 *
 * Not best-effort. Swallowed, a refund that could not be written was followed
 * by that completion committing a purchase nobody received. Thrown, the job
 * fails instead: `markFailed` refunds through the attempt, whose `refundPending`
 * the reconciler finishes, and a purchase is always a revision-owned cover
 * (`coverSettlement.ts`), whose failure never fails the book — the design just
 * stored still prints through the compile its failure releases.
 */
async function refundPurchasedCover(job: GenerateImageJob): Promise<void> {
  const ledgerEntryId = job.data.billingLedgerEntryId;
  if (!ledgerEntryId) return;
  await refundCreditLedgerEntry(ledgerEntryId, "AI cover artwork could not be drawn; a designed cover was used");
}

/**
 * Keeps the drawn picture for a later re-typeset, or records nothing. It is an
 * enhancement to the cover, never a precondition for one: during generation
 * this job's failure is the whole paid book's (`markFailed`), so a storage blip
 * on the second write may not cost what the first one delivered. A cover
 * without the record reads as one drawn before artwork was kept.
 */
async function keptArtworkRecord(
  projectId: string,
  artwork: { bytes: Buffer; mimeType: string }
): Promise<Record<string, unknown>> {
  try {
    return await storeCoverArtwork(projectId, artwork);
  } catch (error) {
    console.warn(`Could not keep the cover artwork of project ${projectId}; its words cannot be re-set for free`, error);
    return {};
  }
}

/** The catalog design the book's current cover was rendered from, when it was a designed one. */
async function currentCoverDesign(projectId: string): Promise<CoverDesign | undefined> {
  const current = await prisma.imageAsset.findFirst({
    where: { projectId, type: "COVER" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true }
  });
  const metadata = jsonRecord(current?.metadata);
  return metadata.coverArtSource === "design" && typeof metadata.coverDesignId === "string"
    ? coverDesign(metadata.coverDesignId)
    : undefined;
}

/** `ImageAsset.provider` for a cover that came from the catalog, not a model. */
export const BUNDLED_COVER_PROVIDER = "bundled";

type CoverArtworkResult = {
  artwork: { bytes: Buffer; mimeType: string };
  /** Stored on the asset; the admin views read it as the cover's provenance. */
  prompt: string;
  provider: string;
  template?: CoverTemplateOverride;
  metadata: Record<string, unknown>;
};

export { coverTemplateOverrideForDesign };
