import {
  coverMetadataFromProject,
  getProjectOrThrow,
  imageGenerationMetadata,
  imageStorageMetadata,
  strategyForInput
} from "../generation/bookHelpers.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { coverImageSelectionForInput, createImageAdapterForSelection, createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import {
  bookPlanSchema,
  buildCoverArtworkPrompt,
  coverArtSourceFor,
  createProviders,
  optimizeImageForStorage,
  publicAssetUrl,
  renderCoverPng,
  selectCoverDesign,
  type CoverDesign,
  type CoverTemplateOverride
} from "@book-maker/core";
import {
  characterReferencePromptInstruction,
  ensureCharacterReferenceAssets,
  selectReferenceImagePaths
} from "../generation/characterReferences.js";
import { coverDesignArtwork } from "../generation/coverArtwork.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { prisma } from "@book-maker/db";
import { Job } from "bullmq";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `generate-cover` work: cover artwork plus the character reference images that
 * keep illustrated casts visually consistent.
 */

export async function generateCover(job: Job) {
  const { projectId, planId } = job.data as {
    projectId: string;
    planId: string;
  };
  const generationJobId = job.data.generationJobId as string | undefined;
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
    await advanceJobStep(generationJobId, "store", 90, "Cover disabled");
    await maybeEnqueueCompile(projectId, planId);
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
  const characterReferences = await ensureCharacterReferenceAssets({
    projectId,
    planId,
    input,
    plan,
    providers,
    strategy,
    generationJobId
  });
  await advanceJobStep(generationJobId, "prompt", 20, "Building cover prompt");

  const designedCover = async (fallbackReason?: string): Promise<CoverArtworkResult> => {
    await updateJobProgress(generationJobId, { message: "Choosing a cover design" });
    const choice = await selectCoverDesign({
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
  if (coverArtSource === "design") {
    cover = await designedCover();
  } else {
    const baseArtworkPrompt = buildCoverArtworkPrompt({ input, plan, metadata });
    const referenceImagePaths = selectReferenceImagePaths({
      input,
      plan,
      assets: characterReferences,
      projectId,
      image: providers.image,
      context: [baseArtworkPrompt, ...plan.characters.map((character) => `${character.name}: ${character.description}`)].join("\n")
    });
    const artworkPrompt = [
      baseArtworkPrompt,
      referenceImagePaths.length > 0 ? characterReferencePromptInstruction(referenceImagePaths.length) : ""
    ].filter(Boolean).join("\n");

    await advanceJobStep(generationJobId, "render", 45, "Rendering cover artwork");
    try {
      const artwork = await strategy.generateImageBytes({
        image: providers.image,
        prompt: artworkPrompt,
        projectId,
        referenceImagePaths,
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
  const projectImageDir = join(config.IMAGE_STORAGE_DIR, projectId);
  await mkdir(projectImageDir, { recursive: true });
  const optimizedCover = await optimizeImageForStorage({ bytes: coverPng, mimeType: "image/png" });
  const filename = `cover.${optimizedCover.extension}`;
  const filePath = join(projectImageDir, filename);
  await writeFile(filePath, optimizedCover.bytes);
  const publicPath = publicAssetUrl(config.PUBLIC_API_URL, `/assets/images/${projectId}/${filename}`);

  await prisma.$transaction([
    prisma.imageAsset.deleteMany({ where: { projectId, type: "COVER" } }),
    prisma.imageAsset.create({
      data: {
        projectId,
        type: "COVER",
        prompt: cover.prompt,
        provider: cover.provider,
        path: publicPath,
        metadata: {
          ...imageStorageMetadata(optimizedCover),
          ...cover.metadata,
          renderer: "puppeteer",
          fonts: [
            "Inter (OFL-1.1)",
            "Source Serif 4 (OFL-1.1)",
            "Playfair Display (OFL-1.1)",
            "Nunito (OFL-1.1)",
            "Bebas Neue (OFL-1.1)",
            "Noto Sans (OFL-1.1)"
          ]
        }
      }
    })
  ]);

  await maybeEnqueueCompile(projectId, planId);
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
