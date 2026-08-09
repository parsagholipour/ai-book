import { config } from "../runtime/config.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { type WorkerImageAsset } from "../runtime/jobTypes.js";
import { safePathPart } from "../runtime/serialization.js";
import {
  buildCharacterReferencePrompt,
  optimizeImageForStorage,
  publicAssetUrl,
  selectCharacterReferenceAssets,
  shouldGenerateCharacterReferences,
  shouldUseCharacterReferenceImages,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type ImageAdapter,
  type ImageAdapterCapabilities,
  type ProviderSet
} from "@book-maker/core";
import { imageGenerationMetadata, imageStorageMetadata } from "./bookHelpers.js";
import { Prisma, prisma } from "@book-maker/db";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Character reference sheets: the DB/FS half of keeping illustrated casts
 * visually consistent. The pure prompt/selection half lives in
 * packages/core/src/generation/characterReferences.ts; this module owns the
 * asset rows and files, and is shared by the cover, image, book, and
 * character handlers.
 */

export async function ensureCharacterReferenceAssets(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}): Promise<WorkerImageAsset[]> {
  if (!shouldGenerateCharacterReferences(options.input, options.plan)) {
    return [];
  }

  const capabilities = imageCapabilities(options.providers.image);
  if (!shouldUseCharacterReferenceImages(options.input, options.plan, capabilities)) {
    await updateJobProgress(options.generationJobId, {
      message: "Skipping character reference sheets for the selected image model"
    });
    return [];
  }

  const existing = await currentCharacterReferences(options.projectId, options.planId);
  if (hasReferenceForEveryCharacter(existing, options.plan)) {
    return existing.map(toWorkerImageAsset);
  }

  // Every illustrated page's `generate-image` job (and the cover job) calls
  // this before the project has any character reference yet, and several run
  // concurrently by design (`MAX_PARALLEL_IMAGE_JOBS`). Without a claim here,
  // each one sees "nothing exists" and pays to generate a full set — this
  // advisory lock, scoped to (projectId, planId), makes the expensive
  // check-then-generate section run for one caller at a time; everyone else
  // blocks, then finds the winner's rows already in place and returns those
  // instead of generating again.
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`character-references:${options.projectId}:${options.planId}`}))`;
      const claimed = await currentCharacterReferences(options.projectId, options.planId, tx);
      if (hasReferenceForEveryCharacter(claimed, options.plan)) {
        return claimed.map(toWorkerImageAsset);
      }
      return generateCharacterReferenceAssets(options, tx, claimed.length > 0);
    },
    { timeout: 5 * 60_000 }
  );
}

async function currentCharacterReferences(
  projectId: string,
  planId: string,
  client: Pick<typeof prisma, "imageAsset"> = prisma
): Promise<Array<{ id: string; path: string; metadata: unknown }>> {
  const existing = await client.imageAsset.findMany({
    where: { projectId, type: "CHARACTER_REFERENCE" },
    orderBy: { createdAt: "asc" }
  });
  return existing.filter((asset) => imageAssetPlanId(asset.metadata) === planId);
}

async function generateCharacterReferenceAssets(
  options: {
    projectId: string;
    planId: string;
    input: CreateProjectInput;
    plan: BookPlan;
    providers: ProviderSet;
    strategy: BookGenerationStrategy;
    generationJobId?: string | undefined;
  },
  tx: Prisma.TransactionClient,
  hasExistingRows: boolean
): Promise<WorkerImageAsset[]> {
  if (hasExistingRows) {
    await tx.imageAsset.deleteMany({ where: { projectId: options.projectId, type: "CHARACTER_REFERENCE" } });
  }

  const projectImageDir = join(config.IMAGE_STORAGE_DIR, options.projectId);
  await mkdir(projectImageDir, { recursive: true });
  const created: WorkerImageAsset[] = [];

  for (const [index, character] of options.plan.characters.entries()) {
    await updateJobProgress(options.generationJobId, {
      message: `Rendering character reference ${index + 1}/${options.plan.characters.length}: ${character.name}`
    });
    const prompt = buildCharacterReferencePrompt({
      input: options.input,
      plan: options.plan,
      character
    });
    const image = await options.strategy.generateImageBytes({
      image: options.providers.image,
      prompt,
      projectId: options.projectId,
      aspectRatio: "4:3"
    });
    const optimizedImage = await optimizeImageForStorage({ bytes: image.bytes, mimeType: image.mimeType });
    const ext = optimizedImage.extension;
    const filename = `character-reference-${characterSlug(character.name)}.${ext}`;
    const filePath = join(projectImageDir, filename);
    await writeFile(filePath, optimizedImage.bytes);
    const asset = await tx.imageAsset.create({
      data: {
        projectId: options.projectId,
        type: "CHARACTER_REFERENCE",
        prompt,
        provider: image.provider,
        path: publicAssetUrl(config.PUBLIC_API_URL, `/assets/images/${options.projectId}/${filename}`),
        metadata: {
          planId: options.planId,
          characterName: character.name,
          role: character.role,
          visualRules: character.visualRules,
          model: image.model,
          ...imageStorageMetadata(optimizedImage),
          revisedPrompt: image.revisedPrompt,
          ...imageGenerationMetadata(image),
          fileName: filename
        }
      }
    });
    created.push(toWorkerImageAsset(asset));
  }

  return created;
}

export function selectReferenceImagePaths(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  assets: WorkerImageAsset[];
  projectId: string;
  image: ImageAdapter;
  context: string;
}): string[] {
  const capabilities = imageCapabilities(options.image);
  if (!capabilities.supportsReferenceImages || capabilities.maxReferenceImages <= 0) {
    return [];
  }
  const localAssets = options.assets.flatMap((asset) => {
    const path = localImagePathForAsset(asset.path, options.projectId);
    return path ? [{ path, metadata: asset.metadata }] : [];
  });
  return selectCharacterReferenceAssets({
    input: options.input,
    plan: options.plan,
    assets: localAssets,
    context: options.context,
    maxReferences: capabilities.maxReferenceImages
  }).map((asset) => asset.path);
}

export function characterReferencePromptInstruction(count: number): string {
  return [
    `Use the ${count} attached character reference image${count === 1 ? "" : "s"} as the authoritative design source.`,
    "Preserve each referenced character's face, silhouette, outfit, colors, and distinctive details; change only pose, expression, lighting, and scene placement."
  ].join(" ");
}

export function imageCapabilities(image: ImageAdapter): ImageAdapterCapabilities {
  return image.capabilities?.() ?? { supportsReferenceImages: false, maxReferenceImages: 0 };
}

export function hasReferenceForEveryCharacter(assets: Array<{ metadata: unknown }>, plan: BookPlan): boolean {
  const names = new Set(
    assets
      .map((asset) => characterNameFromAssetMetadata(asset.metadata)?.toLowerCase())
      .filter((name): name is string => Boolean(name))
  );
  return plan.characters.every((character) => names.has(character.name.toLowerCase()));
}

export function imageAssetPlanId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>).planId;
  return typeof value === "string" ? value : undefined;
}

export function characterNameFromAssetMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>).characterName;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function localImagePathForAsset(path: string, projectId: string): string | undefined {
  let pathname = path;
  try {
    pathname = new URL(path).pathname;
  } catch {
    // Stored paths can also be relative API asset paths.
  }
  const marker = `/assets/images/${projectId}/`;
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const filename = decodeURIComponent(pathname.slice(markerIndex + marker.length));
  if (!filename || filename.includes("/")) {
    return undefined;
  }
  return join(config.IMAGE_STORAGE_DIR, projectId, filename);
}

export function toWorkerImageAsset(asset: { id: string; path: string; metadata: unknown }): WorkerImageAsset {
  return {
    id: asset.id,
    path: asset.path,
    metadata: asset.metadata
  };
}

export function characterSlug(value: string): string {
  return safePathPart(value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
}
