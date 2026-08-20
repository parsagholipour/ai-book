import { strategyForInput } from "../generation/bookHelpers.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import {
  buildLibraryCharacterPortraitPrompt,
  createProjectSchema,
  createProviders,
  libraryCharacterDiskPath,
  libraryCharacterFileName,
  libraryCharacterFileToken,
  libraryCharacterRelativeFile,
  optimizeImageForStorage,
  pruneLibraryCharacterImages,
  stripLibraryCharacterMentionMarkers,
  type LibraryCharacterField
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { Job } from "bullmq";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * `generate-character-portrait`: draws the profile portrait for an
 * account-level library character — from the uploaded photo when one exists,
 * from the description alone otherwise.
 *
 * This is the one job with no project behind it: `GenerationJob.projectId` is
 * null, nothing here may touch any `Project` row, and failure settles through
 * the attempt boundary plus the `failCharacterPortraitForJob` branch in
 * jobLifecycle.ts, which flips the character row to FAILED.
 */
export async function generateCharacterPortrait(job: Job): Promise<void> {
  const generationJobId = job.data.generationJobId as string | undefined;
  const libraryCharacterId = job.data.libraryCharacterId as string | undefined;
  const userId = job.data.userId as string | undefined;
  if (!libraryCharacterId || !userId) {
    throw new Error("Character portrait job payload is missing libraryCharacterId or userId.");
  }

  const character = await prisma.libraryCharacter.findFirst({
    where: { id: libraryCharacterId, userId },
    include: {
      outgoingMentions: {
        orderBy: { sortOrder: "asc" },
        include: { targetCharacter: { select: { id: true, name: true } } }
      }
    }
  });
  if (!character) {
    throw new Error("The library character behind this portrait no longer exists.");
  }

  await prisma.libraryCharacter.updateMany({
    where: { id: character.id, portraitStatus: { in: ["QUEUED", "GENERATING"] } },
    data: { portraitStatus: "GENERATING", portraitError: null }
  });

  await advanceJobStep(generationJobId, "prompt", 15);
  // A portrait has no book, so the provider stack runs against a neutral
  // synthetic input: default media settings pick the standard image model, and
  // the schema fills every other field.
  const input = createProjectSchema.parse({ prompt: `Character portrait: ${character.name}` });
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  const strategy = strategyForInput(input);

  const photoPath = await existingCharacterFile(userId, character.photoPath);
  const prompt = buildLibraryCharacterPortraitPrompt(
    {
      name: character.name,
      description: stripLibraryCharacterMentionMarkers(
        character.description,
        (character.outgoingMentions ?? []).map((mention) => mention.targetCharacter)
      ),
      // The recorded look, so a redraw lands on the same person rather than
      // inventing a new one for every generation.
      ...(character.appearance ? { appearance: character.appearance } : {}),
      fields: fieldsFromJson(character.fields)
    },
    { fromPhoto: photoPath !== null }
  );

  await advanceJobStep(generationJobId, "render", 40);
  const image = await strategy.generateImageBytes({
    image: providers.image,
    prompt,
    ...(photoPath ? { referenceImagePaths: [photoPath] } : {}),
    aspectRatio: "1:1"
  });

  await advanceJobStep(generationJobId, "store", 80);
  const optimizedImage = await optimizeImageForStorage({ bytes: image.bytes, mimeType: image.mimeType });
  const fileName = libraryCharacterFileName(
    character.id,
    "portrait",
    optimizedImage.extension,
    libraryCharacterFileToken()
  );
  const diskPath = libraryCharacterDiskPath(
    config.IMAGE_STORAGE_DIR,
    libraryCharacterRelativeFile(userId, fileName)
  );
  if (!diskPath) {
    throw new Error("Could not resolve a storage path for the character portrait.");
  }
  // Row first, bytes second — the same rule the upload route follows, for the
  // same reason: nothing sweeps `characters/`, so a file no row names is
  // permanent and invisible. The previous portrait is left exactly where it is;
  // it is a retained version now, one promote from being the reference again.
  const imageRow = await prisma.libraryCharacterImage.create({
    data: {
      characterId: character.id,
      userId,
      source: "GENERATED",
      fileName,
      byteSize: optimizedImage.outputBytes,
      ...(optimizedImage.width ? { width: optimizedImage.width } : {}),
      ...(optimizedImage.height ? { height: optimizedImage.height } : {}),
      referenceEligible: true
    }
  });
  try {
    await mkdir(dirname(diskPath), { recursive: true });
    await writeFile(diskPath, optimizedImage.bytes);
  } catch (error) {
    // Both halves go back, including whatever a failed `writeFile` left on
    // disk: the name carries a token nothing will mint again, so those bytes
    // would be unreachable by every route, the prune and every sweep.
    await rm(diskPath, { force: true }).catch(() => undefined);
    await prisma.libraryCharacterImage.delete({ where: { id: imageRow.id } }).catch(() => undefined);
    throw error;
  }

  // Compare-and-set rather than an unconditional update: this row was read
  // minutes ago, and only a job that still owns its QUEUED/GENERATING claim may
  // install a reference. Losing the claim is not a failure — the drawing was
  // paid for and is retained either way.
  await prisma.libraryCharacter.updateMany({
    where: { id: character.id, portraitStatus: { in: ["QUEUED", "GENERATING"] } },
    data: {
      portraitPath: fileName,
      // A drawn portrait outlives the photo it was made from, and a redraw
      // over an adopted upload has to stop the row claiming to be one.
      portraitSource: "GENERATED",
      portraitStatus: "READY",
      portraitError: null
    }
  });

  await pruneWorkerCharacterImages(userId, character.id);
}

/**
 * Trims the character back to the retention limit after a new drawing lands.
 *
 * File first, row second — the inverse of the ingest order above, and for the
 * same reason. The live pointers are exempt, so the automatic path can never
 * drop the picture a book draws from.
 */
async function pruneWorkerCharacterImages(userId: string, characterId: string): Promise<void> {
  const [current, images] = await Promise.all([
    prisma.libraryCharacter.findFirst({
      where: { id: characterId, userId },
      select: { photoPath: true, portraitPath: true }
    }),
    prisma.libraryCharacterImage.findMany({
      where: { characterId, userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    })
  ]);
  if (!current) {
    return;
  }
  const doomed = pruneLibraryCharacterImages(images, {
    keepFileNames: [current.photoPath, current.portraitPath]
  });
  for (const image of doomed) {
    const path = libraryCharacterDiskPath(
      config.IMAGE_STORAGE_DIR,
      libraryCharacterRelativeFile(userId, image.fileName)
    );
    if (path) {
      await rm(path, { force: true }).catch(() => undefined);
    }
    await prisma.libraryCharacterImage.deleteMany({ where: { id: image.id, userId } });
  }
}

async function existingCharacterFile(userId: string, fileName: string | null): Promise<string | null> {
  if (!fileName) {
    return null;
  }
  const path = libraryCharacterDiskPath(config.IMAGE_STORAGE_DIR, libraryCharacterRelativeFile(userId, fileName));
  if (!path) {
    return null;
  }
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

function fieldsFromJson(value: unknown): LibraryCharacterField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    return typeof record.key === "string" && typeof record.value === "string"
      ? [{ key: record.key, value: record.value }]
      : [];
  });
}
