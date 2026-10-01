import {
  coverCastCharacters,
  coverPortraitCharacters,
  imageAdapterCapabilities,
  libraryCharactersFromMediaSettings,
  matchLibraryCharacter,
  selectCharacterReferenceAssets,
  type BookPlan,
  type CreateProjectInput,
  type ImageAdapter,
  type LibraryCharacterSnapshot
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { type WorkerImageAsset } from "../runtime/jobTypes.js";
import { characterReferenceNameKey } from "./characterReferenceFileNames.js";
import type { CharacterReferenceSelection } from "./characterReferencePrompt.js";
import { characterNameFromAssetMetadata } from "./characterReferenceSettlement.js";
import { imageReferenceForAsset } from "./characterReferenceSheetFiles.js";
import { resolveLibraryPortraitSeed } from "./libraryPortraitSeed.js";

/**
 * What a page or cover render attaches: the sheets the pass drew, and the
 * reader's own saved artwork. Split out of `characterReferences.ts`, which
 * draws the sheets and re-exports all of this, so callers and test mocks still
 * reach it through that module.
 */

export async function selectReferenceImagePaths(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  assets: WorkerImageAsset[];
  projectId: string;
  image: ImageAdapter;
  context: string;
}): Promise<CharacterReferenceSelection> {
  const capabilities = imageAdapterCapabilities(options.image);
  if (!capabilities.supportsReferenceImages || capabilities.maxReferenceImages <= 0) {
    return { paths: [], libraryFaceNames: [] };
  }
  const localAssets = options.assets.flatMap((asset) => {
    const path = imageReferenceForAsset(asset.path, options.projectId);
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

/**
 * What an AI cover attaches.
 *
 * A book with illustrated pages keeps the selection every page render makes.
 * A cover-only book attaches exactly the cast its sheet pass drew for —
 * `coverCastCharacters`, the characters the cover concept names — plus, for a
 * cover-cast character the reader saved with artwork, that artwork itself in
 * place of the sheet `characterReferenceCast` did not draw. The old context
 * listed every character's name, so every sheet scored as named and the
 * Tiko cover was handed three characters it never showed.
 */
export async function selectCoverReferenceImagePaths(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  assets: WorkerImageAsset[];
  projectId: string;
  image: ImageAdapter;
  artworkPrompt: string;
}): Promise<CharacterReferenceSelection> {
  if (options.input.mediaSettings.fullIllustrations) {
    return selectReferenceImagePaths({
      input: options.input,
      plan: options.plan,
      assets: options.assets,
      projectId: options.projectId,
      image: options.image,
      context: [
        options.artworkPrompt,
        ...options.plan.characters.map((character) => `${character.name}: ${character.description}`)
      ].join("\n")
    });
  }
  const capabilities = imageAdapterCapabilities(options.image);
  if (!capabilities.supportsReferenceImages || capabilities.maxReferenceImages <= 0) {
    return { paths: [], libraryFaceNames: [] };
  }
  const cast = new Set(
    coverCastCharacters(options.input, options.plan).map((character) => characterReferenceNameKey(character.name))
  );
  if (cast.size === 0) {
    return { paths: [], libraryFaceNames: [] };
  }
  const castSheets = options.assets.flatMap((asset) => {
    const name = characterNameFromAssetMetadata(asset.metadata);
    const path = imageReferenceForAsset(asset.path, options.projectId);
    return name && path && cast.has(characterReferenceNameKey(name)) ? [{ path, metadata: asset.metadata }] : [];
  });
  const paths = selectCharacterReferenceAssets({
    input: options.input,
    plan: options.plan,
    assets: castSheets,
    context: options.artworkPrompt,
    maxReferences: capabilities.maxReferenceImages
  }).map((asset) => asset.path);
  const portraits = coverPortraitCharacters(options.input, options.plan);
  if (portraits.length > 0 && paths.length < capabilities.maxReferenceImages) {
    // The seeding path's ownership trio, so a snapshot naming another user's
    // file — or a file deleted since the build — attaches nothing.
    const ownerUserId =
      (await prisma.project.findUnique({ where: { id: options.projectId }, select: { userId: true } }))?.userId ?? null;
    for (const { snapshot } of portraits) {
      if (paths.length >= capabilities.maxReferenceImages) {
        break;
      }
      const outcome = await resolveLibraryPortraitSeed(snapshot, ownerUserId);
      if (outcome.seeded) {
        paths.push(outcome.seed.path);
      }
    }
  }
  return { paths, libraryFaceNames: [] };
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
    const match = librarySnapshotForSheet(sheet.metadata, snapshots);
    if (!match) {
      continue;
    }
    const outcome = await resolveLibraryPortraitSeed(match, ownerUserId);
    if (outcome.seeded) {
      // The book calls the character by the plan's name, so that is the name the
      // face instruction has to use; the snapshot's own is the fallback for a
      // sheet somehow written without one.
      faces.push({ name: characterNameFromAssetMetadata(sheet.metadata) ?? match.name, path: outcome.seed.path });
    }
  }
  return faces;
}

/**
 * Which library character a rendered sheet belongs to.
 *
 * The seeding pass already resolved this and wrote the answer onto the sheet's
 * own row, so a page render reads that id back instead of running the name
 * matcher a second time. Re-deriving it here reproduced every matching defect
 * at render time and — worse — could reach a *different* answer than the sheet
 * was actually drawn from, which is a face attached to the wrong character.
 * The name match survives only for sheets rendered before the id was recorded.
 *
 * An id that names no snapshot resolves to nothing rather than falling back to
 * the name: the snapshot set has moved out from under the sheet, and guessing
 * by name against a moved set is precisely the wrong-face bug.
 */
export function librarySnapshotForSheet(
  metadata: unknown,
  snapshots: readonly LibraryCharacterSnapshot[]
): LibraryCharacterSnapshot | null {
  const recordedId = libraryCharacterIdFromAssetMetadata(metadata);
  if (recordedId) {
    return snapshots.find((snapshot) => snapshot.id === recordedId) ?? null;
  }
  const name = characterNameFromAssetMetadata(metadata);
  return name ? matchLibraryCharacter(name, snapshots) : null;
}

/**
 * The library character a sheet was seeded from, as recorded at render time.
 * Absent on sheets rendered before the id was written, and on every sheet of a
 * book that mentioned no saved character.
 */
export function libraryCharacterIdFromAssetMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>).libraryCharacterId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
