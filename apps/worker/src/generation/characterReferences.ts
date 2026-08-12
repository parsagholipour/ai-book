import { config } from "../runtime/config.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { type WorkerImageAsset } from "../runtime/jobTypes.js";
import { safePathPart } from "../runtime/serialization.js";
import {
  buildCharacterReferencePrompt,
  characterReferenceSeedInstruction,
  libraryCharacterDiskPath,
  libraryCharacterFaceInstruction,
  libraryCharactersFromMediaSettings,
  matchLibraryCharacter,
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
  type LibraryCharacterPortraitSource,
  type LibraryCharacterSnapshot,
  type ProviderSet
} from "@book-maker/core";
import { imageGenerationMetadata, imageStorageMetadata } from "./bookHelpers.js";
import { Prisma, prisma } from "@book-maker/db";
import { mkdir, stat, writeFile } from "node:fs/promises";
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

  // The renders are independent, so a small worker pool runs them
  // concurrently instead of paying one image-model latency per character in
  // series — this whole section sits inside the advisory-lock transaction's
  // timeout. Workers stop picking up new characters after the first failure
  // (a rejected Promise.all cannot cancel siblings, and renders nobody will
  // keep spend the same image budget the retry needs). The transaction's row
  // writes stay sequential below: an interactive transaction client must not
  // run queries concurrently.
  const characters = options.plan.characters;
  const librarySnapshots = libraryCharactersFromMediaSettings(options.input.mediaSettings);
  // The snapshots are stored JSON that client flows can reach, so a portrait
  // may only be read out of the book owner's own characters directory: the
  // owner's id is required as the path's first segment, and a snapshot naming
  // any other user's portrait resolves to nothing. Operator-console books have
  // no owner and seed nothing.
  const seedOwnerUserId = librarySnapshots.some((snapshot) => snapshot.portraitFile)
    ? ((await prisma.project.findUnique({ where: { id: options.projectId }, select: { userId: true } }))?.userId ??
      null)
    : null;
  type RenderedReference = {
    character: (typeof characters)[number];
    prompt: string;
    image: Awaited<ReturnType<typeof options.strategy.generateImageBytes>>;
    optimizedImage: Awaited<ReturnType<typeof optimizeImageForStorage>>;
    filename: string;
    seededFromLibraryCharacterId?: string | undefined;
    seedSource?: LibraryCharacterPortraitSource | undefined;
  };
  const rendered = Array.from({ length: characters.length }) as RenderedReference[];
  let cursor = 0;
  let failed = false;
  const renderWorker = async () => {
    while (!failed && cursor < characters.length) {
      const index = cursor;
      cursor += 1;
      const character = characters[index]!;
      try {
        await updateJobProgress(options.generationJobId, {
          message: `Rendering character reference ${index + 1}/${characters.length}: ${character.name}`
        });
        // A plan character matching a mentioned library character inherits its
        // generated portrait: the portrait file is fed as a reference image so
        // the sheet keeps the face the user already approved. This whole
        // function runs only when the adapter supports reference images
        // (`shouldUseCharacterReferenceImages` above), and a portrait that has
        // gone missing — the character was deleted since the build — is skipped
        // silently rather than failing a book that no longer depends on it.
        const seed = await libraryPortraitSeedForName(character.name, librarySnapshots, seedOwnerUserId);
        const prompt = [
          buildCharacterReferencePrompt({
            input: options.input,
            plan: options.plan,
            character
          }),
          ...(seed ? [characterReferenceSeedInstruction(seed.source)] : [])
        ].join("\n");
        const image = await options.strategy.generateImageBytes({
          image: options.providers.image,
          prompt,
          projectId: options.projectId,
          ...(seed ? { referenceImagePaths: [seed.path] } : {}),
          aspectRatio: "4:3"
        });
        const optimizedImage = await optimizeImageForStorage({ bytes: image.bytes, mimeType: image.mimeType });
        const filename = `character-reference-${characterSlug(character.name)}.${optimizedImage.extension}`;
        await writeFile(join(projectImageDir, filename), optimizedImage.bytes);
        rendered[index] = {
          character,
          prompt,
          image,
          optimizedImage,
          filename,
          ...(seed ? { seededFromLibraryCharacterId: seed.id, seedSource: seed.source } : {})
        };
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CHARACTER_REFERENCE_RENDER_CONCURRENCY, Math.max(characters.length, 1)) }, renderWorker)
  );

  const created: WorkerImageAsset[] = [];
  for (const item of rendered) {
    const asset = await tx.imageAsset.create({
      data: {
        projectId: options.projectId,
        type: "CHARACTER_REFERENCE",
        prompt: item.prompt,
        provider: item.image.provider,
        path: publicAssetUrl(config.PUBLIC_API_URL, `/assets/images/${options.projectId}/${item.filename}`),
        metadata: {
          planId: options.planId,
          characterName: item.character.name,
          role: item.character.role,
          visualRules: item.character.visualRules,
          model: item.image.model,
          ...imageStorageMetadata(item.optimizedImage),
          revisedPrompt: item.image.revisedPrompt,
          ...imageGenerationMetadata(item.image),
          fileName: item.filename,
          ...(item.seededFromLibraryCharacterId
            ? {
                libraryCharacterId: item.seededFromLibraryCharacterId,
                seededFromPortrait: true,
                seedSource: item.seedSource ?? "generated"
              }
            : {})
        }
      }
    });
    created.push(toWorkerImageAsset(asset));
  }

  return created;
}

const CHARACTER_REFERENCE_RENDER_CONCURRENCY = 3;

async function libraryPortraitSeedForName(
  name: string,
  snapshots: readonly LibraryCharacterSnapshot[],
  ownerUserId: string | null
): Promise<{ id: string; path: string; source: LibraryCharacterPortraitSource } | null> {
  const match = matchLibraryCharacter(name, snapshots);
  if (!match?.portraitFile || !ownerUserId || !match.portraitFile.startsWith(`${ownerUserId}/`)) {
    return null;
  }
  const path = libraryCharacterDiskPath(config.IMAGE_STORAGE_DIR, match.portraitFile);
  if (!path) {
    return null;
  }
  try {
    if (!(await stat(path)).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  return { id: match.id, path, source: match.portraitSource ?? "generated" };
}

/**
 * What a page or cover render attaches: the per-book character sheets, plus —
 * where the model's reference budget has room left — the reader's own saved
 * artwork for those same characters.
 *
 * The sheet is a redraw of that artwork, so by the time it reaches a page the
 * face is two generations from the one the reader recognises. Sending the
 * original alongside it is what stops that compounding. It is strictly
 * additive: the faces only ever fill slots the sheets did not want, so a page
 * with as many characters as the budget allows still gets every sheet.
 */
export type CharacterReferenceSelection = {
  paths: string[];
  /** Characters whose own artwork travels at the end of `paths`, in that order. */
  libraryFaceNames: string[];
};

export async function selectReferenceImagePaths(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  assets: WorkerImageAsset[];
  projectId: string;
  image: ImageAdapter;
  context: string;
}): Promise<CharacterReferenceSelection> {
  const capabilities = imageCapabilities(options.image);
  if (!capabilities.supportsReferenceImages || capabilities.maxReferenceImages <= 0) {
    return { paths: [], libraryFaceNames: [] };
  }
  const localAssets = options.assets.flatMap((asset) => {
    const path = localImagePathForAsset(asset.path, options.projectId);
    return path ? [{ path, metadata: asset.metadata }] : [];
  });
  const sheets = selectCharacterReferenceAssets({
    input: options.input,
    plan: options.plan,
    assets: localAssets,
    context: options.context,
    maxReferences: capabilities.maxReferenceImages
  });
  const paths = sheets.map((asset) => asset.path);
  const faces = await libraryFacesForSheets({
    sheets,
    input: options.input,
    projectId: options.projectId,
    budget: capabilities.maxReferenceImages - paths.length
  });
  return {
    paths: [...paths, ...faces.map((face) => face.path)],
    libraryFaceNames: faces.map((face) => face.name)
  };
}

async function libraryFacesForSheets(options: {
  sheets: Array<{ metadata?: unknown }>;
  input: CreateProjectInput;
  projectId: string;
  budget: number;
}): Promise<Array<{ name: string; path: string }>> {
  if (options.budget <= 0) {
    return [];
  }
  const snapshots = libraryCharactersFromMediaSettings(options.input.mediaSettings);
  if (!snapshots.some((snapshot) => snapshot.portraitFile)) {
    return [];
  }
  // Same ownership rule as the seeding path: a snapshot is stored JSON that
  // client flows can reach, so a file is only read out of the book owner's own
  // characters directory. An operator-console book has no owner and gets none.
  const ownerUserId =
    (await prisma.project.findUnique({ where: { id: options.projectId }, select: { userId: true } }))?.userId ?? null;
  if (!ownerUserId) {
    return [];
  }
  const faces: Array<{ name: string; path: string }> = [];
  for (const sheet of options.sheets) {
    if (faces.length >= options.budget) {
      break;
    }
    const name = characterNameFromAssetMetadata(sheet.metadata);
    if (!name) {
      continue;
    }
    const seed = await libraryPortraitSeedForName(name, snapshots, ownerUserId);
    if (seed) {
      faces.push({ name, path: seed.path });
    }
  }
  return faces;
}

export function characterReferencePromptInstruction(selection: CharacterReferenceSelection): string {
  const count = selection.paths.length;
  if (count === 0) {
    return "";
  }
  return [
    `Use the ${count} attached character reference image${count === 1 ? "" : "s"} as the authoritative design source.`,
    "Preserve each referenced character's face, silhouette, outfit, colors, and distinctive details; change only pose, expression, lighting, and scene placement.",
    libraryCharacterFaceInstruction(selection.libraryFaceNames)
  ]
    .filter(Boolean)
    .join(" ");
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
