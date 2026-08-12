import { config } from "../runtime/config.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { type WorkerImageAsset } from "../runtime/jobTypes.js";
import { safeJsonStringify, safePathPart } from "../runtime/serialization.js";
import {
  buildCharacterReferencePrompt,
  characterReferenceSeedInstruction,
  foldCharacterName,
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
import { createHash } from "node:crypto";
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
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
  // Names decide filenames, so the whole cast's stems are resolved together and
  // up front: two characters must never share one, and the renders below run
  // concurrently into this one directory.
  const fileStems = characterReferenceFileStems(characters.map((character) => character.name));
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
  // A book that @-mentioned nothing has no seed to lose. Recording a skip
  // reason on its sheets would put "no_library_match" on every character of
  // every ordinary book, which is noise standing exactly where the signal for
  // the books that *did* mention someone has to be readable.
  const bookHasLibraryCharacters = librarySnapshots.length > 0;
  type RenderedReference = {
    character: (typeof characters)[number];
    prompt: string;
    image: Awaited<ReturnType<typeof options.strategy.generateImageBytes>>;
    optimizedImage: Awaited<ReturnType<typeof optimizeImageForStorage>>;
    filename: string;
    seeding: LibraryPortraitSeedOutcome;
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
        // gone missing — the character was deleted since the build — does not
        // fail a book that no longer depends on it. It is no longer *silent*,
        // though: the reason is stamped on the row and written to the run log,
        // because from the finished book a dropped seed and a character who was
        // never in the library look exactly alike.
        const seeding = await libraryPortraitSeedForName(character.name, librarySnapshots, seedOwnerUserId);
        if (!seeding.seeded && bookHasLibraryCharacters) {
          await logLibrarySeedSkipped({
            projectId: options.projectId,
            planId: options.planId,
            generationJobId: options.generationJobId,
            characterName: character.name,
            outcome: seeding
          });
        }
        const prompt = [
          buildCharacterReferencePrompt({
            input: options.input,
            plan: options.plan,
            character
          }),
          ...(seeding.seeded ? [characterReferenceSeedInstruction(seeding.seed.source)] : [])
        ].join("\n");
        const image = await options.strategy.generateImageBytes({
          image: options.providers.image,
          prompt,
          projectId: options.projectId,
          ...(seeding.seeded ? { referenceImagePaths: [seeding.seed.path] } : {}),
          aspectRatio: "4:3"
        });
        const optimizedImage = await optimizeImageForStorage({ bytes: image.bytes, mimeType: image.mimeType });
        const filename = `${fileStems[index]!}.${optimizedImage.extension}`;
        await writeFile(join(projectImageDir, filename), optimizedImage.bytes);
        rendered[index] = {
          character,
          prompt,
          image,
          optimizedImage,
          filename,
          seeding
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
          ...librarySeedMetadata(item.seeding, bookHasLibraryCharacters)
        }
      }
    });
    created.push(toWorkerImageAsset(asset));
  }

  return created;
}

const CHARACTER_REFERENCE_RENDER_CONCURRENCY = 3;

/**
 * Why a plan character's reference sheet was rendered without the reader's own
 * saved artwork.
 *
 * All six used to be one `return null` that recorded nothing, which is what
 * made "my saved character came out as a different person" a database dig: the
 * sheet, the plan and the book all look ordinary, and the only trace of the
 * decision was its absence. They are kept apart because they need different
 * answers — a rename by the planner (`no_library_match`) is a matcher problem,
 * a `portrait_file_missing` is a character deleted since the build, and
 * `portrait_owned_by_another_user` is a planted snapshot being refused and is
 * working as intended.
 */
export type LibraryPortraitSeedSkipReason =
  | "no_library_match"
  | "no_portrait"
  | "project_has_no_owner"
  | "portrait_owned_by_another_user"
  | "portrait_path_rejected"
  | "portrait_file_missing";

type LibraryPortraitSeed = { id: string; path: string; source: LibraryCharacterPortraitSource };

type LibraryPortraitSeedOutcome =
  | { seeded: true; seed: LibraryPortraitSeed }
  | {
      seeded: false;
      reason: LibraryPortraitSeedSkipReason;
      /** Present once a snapshot was matched — every reason but `no_library_match`. */
      libraryCharacterId?: string | undefined;
    };

async function libraryPortraitSeedForName(
  name: string,
  snapshots: readonly LibraryCharacterSnapshot[],
  ownerUserId: string | null
): Promise<LibraryPortraitSeedOutcome> {
  return resolveLibraryPortraitSeed(matchLibraryCharacter(name, snapshots), ownerUserId);
}

async function resolveLibraryPortraitSeed(
  match: LibraryCharacterSnapshot | null,
  ownerUserId: string | null
): Promise<LibraryPortraitSeedOutcome> {
  if (!match) {
    return { seeded: false, reason: "no_library_match" };
  }
  const matched = { libraryCharacterId: match.id };
  if (!match.portraitFile) {
    return { seeded: false, reason: "no_portrait", ...matched };
  }
  if (!ownerUserId) {
    return { seeded: false, reason: "project_has_no_owner", ...matched };
  }
  // The snapshots are stored JSON that client flows can reach, so a portrait is
  // only ever read out of the book owner's own characters directory.
  if (!match.portraitFile.startsWith(`${ownerUserId}/`)) {
    return { seeded: false, reason: "portrait_owned_by_another_user", ...matched };
  }
  const path = libraryCharacterDiskPath(config.IMAGE_STORAGE_DIR, match.portraitFile);
  if (!path) {
    return { seeded: false, reason: "portrait_path_rejected", ...matched };
  }
  try {
    if (!(await stat(path)).isFile()) {
      return { seeded: false, reason: "portrait_file_missing", ...matched };
    }
  } catch {
    return { seeded: false, reason: "portrait_file_missing", ...matched };
  }
  return { seeded: true, seed: { id: match.id, path, source: match.portraitSource ?? "generated" } };
}

/** What a rendered sheet's row records about its seeding, successful or not. */
function librarySeedMetadata(
  outcome: LibraryPortraitSeedOutcome,
  bookHasLibraryCharacters: boolean
): Record<string, unknown> {
  if (outcome.seeded) {
    return {
      libraryCharacterId: outcome.seed.id,
      seededFromPortrait: true,
      seedSource: outcome.seed.source
    };
  }
  if (!bookHasLibraryCharacters) {
    return {};
  }
  return {
    seededFromPortrait: false,
    librarySeedSkipped: outcome.reason,
    ...(outcome.libraryCharacterId ? { libraryCharacterId: outcome.libraryCharacterId } : {})
  };
}

/**
 * One line per dropped seed, in the project's run log directory — the place
 * this codebase keeps its debugging artifacts.
 *
 * This module has no bullmq `Job` (it is called from four handlers and from the
 * book passes), so it cannot use `createRunLogger`; the file name follows the
 * same `<run>-<job>.jsonl` convention with a fixed job part so the line lands
 * beside the render that produced it. Writing it is never allowed to fail a
 * book: a lost diagnostic is the cheapest thing in this function.
 */
async function logLibrarySeedSkipped(options: {
  projectId: string;
  planId: string;
  generationJobId: string | undefined;
  characterName: string;
  outcome: Extract<LibraryPortraitSeedOutcome, { seeded: false }>;
}): Promise<void> {
  const logDir = join(config.BOOK_STORAGE_DIR, options.projectId, "runs");
  const runId = safePathPart(options.generationJobId ?? "unknown-run");
  const entry = {
    timestamp: new Date().toISOString(),
    event: "character.reference.library_seed_skipped",
    projectId: options.projectId,
    planId: options.planId,
    generationJobId: options.generationJobId,
    characterName: options.characterName,
    reason: options.outcome.reason,
    libraryCharacterId: options.outcome.libraryCharacterId
  };
  try {
    await mkdir(logDir, { recursive: true });
    await appendFile(join(logDir, `${runId}-character-references.jsonl`), `${safeJsonStringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error(`Failed to record a skipped character portrait seed for ${options.projectId}`, error);
  }
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
function librarySnapshotForSheet(
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

/**
 * The filename-safe stem for one character's reference sheet.
 *
 * The ASCII path is deliberately byte-for-byte what it always was, so no
 * existing book's files move. What it could not do is name a character whose
 * name holds no ASCII at all: every Persian, Cyrillic, Hebrew or CJK name
 * emptied out and `safePathPart`'s own fallback turned the empty string into
 * the literal "unknown", so a Persian book's entire cast wrote to
 * `character-reference-unknown.jpg` — one file, several concurrent writers, and
 * every character afterwards drawn from whichever render happened to land last.
 * Nothing rebuilt it either: `hasReferenceForEveryCharacter` compares names, so
 * the set looked complete for the life of the plan.
 *
 * The fallback hashes the *folded* name, so the two spellings of one Persian
 * name (an Arabic kaf against a Persian one, a stray ZWNJ, a diacritic the
 * planner echoed back) still resolve to the same file rather than to two.
 */
export function characterSlug(value: string): string {
  const ascii = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (ascii) {
    return safePathPart(ascii);
  }
  return `char-${createHash("sha256").update(foldCharacterName(value)).digest("hex").slice(0, 10)}`;
}

/**
 * One filename stem per plan character, unique within the cast.
 *
 * `characterSlug` is per-name and so cannot promise that on its own: a name
 * that is mostly non-Latin still yields an ASCII slug from whatever Latin it
 * does contain, so "Ada بهرام" and "Ada کیوان" both reduce to `ada`. Uniqueness
 * is a property of the cast, not of a name, and it has to hold before the
 * renders start — they run concurrently into a single project directory, and
 * two characters sharing a stem is one file written twice and a book whose
 * whole cast wears one face.
 */
export function characterReferenceFileStems(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const base = `character-reference-${characterSlug(name)}`;
    let stem = base;
    for (let suffix = 2; taken.has(stem); suffix += 1) {
      stem = `${base}-${suffix}`;
    }
    taken.add(stem);
    return stem;
  });
}
