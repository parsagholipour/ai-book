import { getProjectOrThrow, imageGenerationMetadata, imageStorageMetadata, strategyForInput } from "../generation/bookHelpers.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { jsonPayloadToRecord } from "../runtime/serialization.js";
import {
  characterReferencePromptInstruction,
  ensureCharacterReferenceAssets,
  generateCover,
  selectReferenceImagePaths
} from "./generateCover.js";
import {
  bookPlanSchema,
  createProviders,
  isDiagramFriendlyBookCategory,
  optimizeImageForStorage,
  publicAssetUrl
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { Job } from "bullmq";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `generate-image` job: render and store one page illustration.
 */

export async function generateImage(job: Job) {
  if (jsonPayloadToRecord(job.data).assetType === "COVER") {
    await generateCover(job);
    return;
  }

  const { projectId, pageId, planId, prompt } = job.data as {
    projectId: string;
    pageId: string;
    planId: string;
    prompt: string;
  };
  const generationJobId = job.data.generationJobId as string | undefined;
  const [project, page, planVersion] = await Promise.all([
    getProjectOrThrow(projectId),
    prisma.page.findUnique({ where: { id: pageId } }),
    prisma.planVersion.findUnique({ where: { id: planId } })
  ]);
  if (!page || !planVersion) {
    throw new Error("Page or plan not found for image generation");
  }
  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  const plan = bookPlanSchema.parse(planVersion.planningPackage);
  const characterReferences = await ensureCharacterReferenceAssets({
    projectId,
    planId,
    input,
    plan,
    providers,
    strategy,
    generationJobId
  });
  const referenceImagePaths = selectReferenceImagePaths({
    input,
    plan,
    assets: characterReferences,
    projectId,
    image: providers.image,
    context: [prompt, page.title, page.summary, page.markdown].filter(Boolean).join("\n")
  });
  const imagePrompt = [
    prompt,
    referenceImagePaths.length > 0 ? characterReferencePromptInstruction(referenceImagePaths.length) : "",
    `Global visual style: ${plan.illustrationPlan.globalStyle}`,
    `Continuity rules: ${plan.illustrationPlan.pageRules.join(" ")}`
  ].filter(Boolean).join("\n");
  await advanceJobStep(generationJobId, "prompt", 25, `Building prompt for page ${page.index}`);
  await advanceJobStep(generationJobId, "render", 45, `Rendering page ${page.index}`);
  const image = await strategy.generateImageBytes({
    image: providers.image,
    prompt: imagePrompt,
    projectId,
    pageId,
    referenceImagePaths
  });

  await advanceJobStep(generationJobId, "store", 80, `Storing image for page ${page.index}`);
  const optimizedImage = await optimizeImageForStorage({ bytes: image.bytes, mimeType: image.mimeType });
  const ext = optimizedImage.extension;
  const projectImageDir = join(config.IMAGE_STORAGE_DIR, projectId);
  await mkdir(projectImageDir, { recursive: true });
  const filename = `page-${page.index}.${ext}`;
  const filePath = join(projectImageDir, filename);
  await writeFile(filePath, optimizedImage.bytes);

  await prisma.imageAsset.create({
    data: {
      projectId,
      pageId,
      type: isDiagramFriendlyBookCategory(input.category) ? "DIAGRAM" : "SCENE_ILLUSTRATION",
      prompt: imagePrompt,
      provider: image.provider,
      path: publicAssetUrl(config.PUBLIC_API_URL, `/assets/images/${projectId}/${filename}`),
      metadata: {
        model: image.model,
        ...imageStorageMetadata(optimizedImage),
        revisedPrompt: image.revisedPrompt,
        ...imageGenerationMetadata(image),
        characterReferenceCount: referenceImagePaths.length
      }
    }
  });

  await maybeEnqueueCompile(projectId, planId);
}
