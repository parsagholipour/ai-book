import { config } from "../runtime/config.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { type WorkerImageAsset } from "../runtime/jobTypes.js";
import { safeJsonStringify } from "../runtime/serialization.js";
import {
  buildCharacterReferencePrompt,
  characterReferenceSeedInstruction,
  errorMessage,
  imageAdapterCapabilities,
  imageRefusalReason,
  isImageContentRefusalError,
  libraryCharacterDiskPath,
  libraryCharactersFromMediaSettings,
  matchLibraryCharacter,
  optimizeImageForStorage,
  publicAssetUrl,
  safePathPart,
  selectCharacterReferenceAssets,
  shouldGenerateCharacterReferences,
  shouldUseCharacterReferenceImages,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type ImageAdapter,
  type LibraryCharacterPortraitSource,
  type LibraryCharacterSnapshot,
  type ProviderSet
} from "@book-maker/core";
import { imageGenerationMetadata, imageStorageMetadata } from "./bookHelpers.js";
import { characterReferenceFileStems, characterReferenceNameKey } from "./characterReferenceFileNames.js";
import {
  characterNameFromAssetMetadata,
  characterReferenceRefusalsAgree,
  characterReferenceSetIsSettled,
  parseCharacterReferenceRefusals,
  type CharacterReferenceRefusal
} from "./characterReferenceSettlement.js";
import {
  discardCharacterReferenceSheetFiles,
  localImagePathForAsset,
  projectImageDir,
  renderedSheetFileNames
} from "./characterReferenceSheetFiles.js";
import type { CharacterReferenceSelection } from "./characterReferencePrompt.js";
import { runCharacterReferenceRenderPass } from "./characterReferenceRenderLease.js";
import { Prisma, prisma } from "@book-maker/db";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Character reference sheets: the DB/FS half of keeping illustrated casts
 * visually consistent. The pure prompt/selection half lives in
 * packages/core/src/generation/characterReferences.ts; this module owns the
 * asset rows and files, and is shared by the cover, image, book, and
 * character handlers.
 */

export type CharacterReferenceRenderOptions = {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
};

export async function ensureCharacterReferenceAssets(
  options: CharacterReferenceRenderOptions
): Promise<WorkerImageAsset[]> {
  if (!shouldGenerateCharacterReferences(options.input, options.plan)) {
    return [];
  }

  const capabilities = imageAdapterCapabilities(options.providers.image);
  if (!shouldUseCharacterReferenceImages(options.input, options.plan, capabilities)) {
    await updateJobProgress(options.generationJobId, {
      message: "Skipping character reference sheets for the selected image model"
    });
    return [];
  }

  // Two independent reads, and the point of this check is to answer without
  // going near the lock — so they go together. Every illustrated page's
  // `generate-image` job and the cover job reach it before doing anything else,
  // and in series it is a second serial round trip per page render. Safe to
  // interleave because the check is only an optimization: the commit writes the
  // sheets and the settlement in one transaction so neither read catches it half
  // done, a mixed reading that under-covers the cast falls through to `read`
  // under the advisory lock, which is the authoritative one, and a mix that
  // over-covers is one the sequential pair could reach too, since the assets
  // were read first either way. The copies inside `read` stay sequential for the
  // reason the commit's creates do — a transaction client runs one query at a
  // time.
  const [existing, refusals] = await Promise.all([
    currentCharacterReferences(options.projectId, options.planId),
    settledCharacterReferenceRefusals(options.planId)
  ]);
  if (characterReferenceSetIsSettled(existing, refusals, options.plan)) {
    return existing.map(toWorkerImageAsset);
  }

  // Every illustrated page's `generate-image` job (and the cover job) calls
  // this before the project has any character reference yet, and several run
  // concurrently by design (`MAX_PARALLEL_IMAGE_JOBS`). Without a claim here,
  // each one sees "nothing exists" and pays to generate a full set. The claim
  // is still the advisory lock scoped to (projectId, planId) — but it now
  // fences a lease rather than the renders themselves, so the model calls in
  // `renderCharacterReferenceSheets` hold neither the lock nor a connection.
  // See `characterReferenceRenderLease.ts` for why that split exists.
  const state = await runCharacterReferenceRenderPass<RenderedCharacterReferences, CharacterReferenceState>({
    projectId: options.projectId,
    planId: options.planId,
    generationJobId: options.generationJobId,
    read: async (client) => {
      const assets = await currentCharacterReferences(options.projectId, options.planId, client);
      const settledRefusals = await settledCharacterReferenceRefusals(options.planId, client);
      return {
        answer: { assets: assets.map(toWorkerImageAsset), refusals: settledRefusals },
        settled: characterReferenceSetIsSettled(assets, settledRefusals, options.plan)
      };
    },
    render: () => renderCharacterReferenceSheets(options),
    // A pass whose answer the commit did not keep leaves a whole cast of files
    // no row names, and nothing else will ever unlink one — see
    // `characterReferenceSheetFiles.ts`.
    discard: (rendered) =>
      discardCharacterReferenceSheetFiles(options.projectId, renderedSheetFileNames(rendered.rendered)),
    published: (rendered, current) => publishedCharacterReferenceSheets(options.projectId, rendered, current),
    supersedes: supersedesSettledCharacterReferences,
    commit: (tx, rendered, current) => commitCharacterReferenceSheets(options, tx, rendered, current)
  });
  return state.answer.assets;
}

/**
 * What one read of this plan's sheet set finds. The refusals ride along because
 * the commit has to know what it would be *replacing*, not only what it is
 * writing — see `recordCharacterReferenceRefusals`. Every read that produces one
 * is taken under the advisory lock, and this column has no other writer, so the
 * pair is a reading of the row rather than a guess about it.
 */
type CharacterReferenceState = {
  assets: WorkerImageAsset[];
  refusals: CharacterReferenceRefusal[];
};

async function currentCharacterReferences(
  projectId: string,
  planId: string,
  client: Pick<typeof prisma, "imageAsset"> = prisma
): Promise<Array<{ id: string; path: string; metadata: unknown }>> {
  // **Every waiter runs this once per poll, so what it does not ask for is the
  // cost of waiting.** `MAX_PARALLEL_IMAGE_JOBS + 1` jobs run it every
  // `CHARACTER_REFERENCE_LEASE_POLL_MS` for up to fifteen minutes, and it used
  // to select whole rows — `prompt` above all, the multi-kilobyte text a sheet
  // was drawn from — sort every plan version's sheets (the commit's id-scoped
  // delete is what leaves them there) and drop all but this one's in memory,
  // with no index behind any of it. The in-memory narrowing stays as the
  // statement of what this returns rather than as an optimization: the JSON
  // predicate is Postgres', and a client answering a `where` less precisely may
  // not widen this set.
  const existing = await client.imageAsset.findMany({
    where: { projectId, type: "CHARACTER_REFERENCE", metadata: { path: ["planId"], equals: planId } },
    orderBy: { createdAt: "asc" },
    select: { id: true, path: true, metadata: true }
  });
  return existing.filter((asset) => imageAssetPlanId(asset.metadata) === planId);
}

async function settledCharacterReferenceRefusals(
  planId: string,
  client: Pick<typeof prisma, "planVersion"> = prisma
): Promise<CharacterReferenceRefusal[]> {
  const planVersion = await client.planVersion.findUnique({
    where: { id: planId },
    select: { characterReferenceRefusals: true }
  });
  return parseCharacterReferenceRefusals(planVersion?.characterReferenceRefusals);
}

/**
 * The pass that just ran owns the whole answer: it attempted every character,
 * so a name missing from this list is one it drew. Written with the sheets, in
 * their transaction — a settlement without them re-renders nothing, and sheets
 * without it are the per-page rebuild `characterReferenceSetIsSettled`
 * describes.
 *
 * `updateMany` because a plan version can be deleted out from under a running
 * render — an undo of a structural edit removes the one it approved — and a
 * settlement with nobody left to read it is not worth failing the book for.
 *
 * A settlement equal to what the row already holds is not written, and that is
 * the ordinary pass: nobody refused, against a column already NULL. `DbNull`
 * over NULL is a row version, a WAL record and a dead tuple on `PlanVersion`
 * for no change, inside the transaction holding the lock every other image job
 * of this book claims through. Only *equality* is skipped — a pass that draws a
 * character an earlier one was refused still clears the column, which is the
 * whole mechanism by which a refusal can be taken back. Order is not part of the
 * answer, since the render pool decides which refused name lands first, so the
 * two are compared as sets.
 *
 * `recorded` is the *parsed* prior value, and `parseCharacterReferenceRefusals`
 * is this column's only reader — so an equal-parse skip cannot hide a difference
 * from anyone; at worst it leaves a document this function did not spell, which
 * every read already tolerates.
 */
async function recordCharacterReferenceRefusals(
  tx: Prisma.TransactionClient,
  planId: string,
  refusals: readonly CharacterReferenceRefusal[],
  recorded: readonly CharacterReferenceRefusal[]
): Promise<void> {
  if (characterReferenceRefusalsAgree(recorded, refusals)) {
    return;
  }
  await tx.planVersion.updateMany({
    where: { id: planId },
    data: {
      characterReferenceRefusals:
        refusals.length > 0 ? (refusals.map((refusal) => ({ ...refusal })) as Prisma.InputJsonValue) : Prisma.DbNull
    }
  });
}

type RenderedCharacterReference = {
  character: BookPlan["characters"][number];
  prompt: string;
  image: Awaited<ReturnType<BookGenerationStrategy["generateImageBytes"]>>;
  optimizedImage: Awaited<ReturnType<typeof optimizeImageForStorage>>;
  filename: string;
  seeding: LibraryPortraitSeedOutcome;
};

/** One pass's whole answer for the cast: what it drew, and who it was refused. */
type RenderedCharacterReferences = {
  rendered: Array<RenderedCharacterReference | undefined>;
  refused: CharacterReferenceRefusal[];
  bookHasLibraryCharacters: boolean;
};

/**
 * The slow half, and the reason it is a half at all: nothing here holds the
 * advisory lock, a transaction or a database connection. Every model call this
 * pass makes — the renders, and the copyright rewrite plus second render a
 * refusal buys — happens between the two short transactions in
 * `characterReferenceRenderLease.ts`, so no amount of provider latency can
 * abort a commit or block another image job.
 */
async function renderCharacterReferenceSheets(
  options: CharacterReferenceRenderOptions
): Promise<RenderedCharacterReferences> {
  const imageDir = projectImageDir(options.projectId);
  await mkdir(imageDir, { recursive: true });

  // The renders are independent, so a small worker pool runs them
  // concurrently instead of paying one image-model latency per character in
  // series. Workers stop picking up new characters after the first failure
  // (a rejected Promise.all cannot cancel siblings, and renders nobody will
  // keep spend the same image budget the retry needs).
  const characters = options.plan.characters;
  // Names decide filenames, so the whole cast's stems are resolved together and
  // up front: two characters must never share one, and the renders below run
  // concurrently into this one directory. The pass's own id rides on every stem
  // for the harder half of that — this directory is shared by every render pass
  // of the book too, and since the renders left the advisory lock two of them
  // can overlap. `characterReferenceFileNames.ts` has the reasoning.
  const fileStems = characterReferenceFileStems(
    characters.map((character) => character.name),
    randomUUID()
  );
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
  const rendered = Array.from({ length: characters.length }) as Array<RenderedCharacterReference | undefined>;
  const refused: CharacterReferenceRefusal[] = [];
  let cursor = 0;
  let failed = false;
  let failure: { error: unknown } | undefined;
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
        const seed = seeding.seeded ? seeding.seed : null;
        // "The attached image is this character's existing, approved artwork"
        // is a claim about a picture, so it is a function of the picture: a
        // fallback provider that can take no references drops the sentence
        // with the file rather than describing an attachment that is gone.
        const promptForReferenceImages = (attached: readonly string[]) =>
          [
            buildCharacterReferencePrompt({
              input: options.input,
              plan: options.plan,
              character
            }),
            ...(seed && attached.length > 0 ? [characterReferenceSeedInstruction(seed.source)] : [])
          ].join("\n");
        const prompt = promptForReferenceImages(seed ? [seed.path] : []);
        const image = await options.strategy.generateImageBytes({
          image: options.providers.image,
          prompt,
          projectId: options.projectId,
          ...(seed ? { referenceImagePaths: [seed.path] } : {}),
          promptForReferenceImages,
          aspectRatio: "4:3"
        });
        const optimizedImage = await optimizeImageForStorage({ bytes: image.bytes, mimeType: image.mimeType });
        const filename = `${fileStems[index]!}.${optimizedImage.extension}`;
        await writeFile(join(imageDir, filename), optimizedImage.bytes);
        rendered[index] = {
          character,
          prompt,
          image,
          optimizedImage,
          filename,
          seeding
        };
      } catch (error) {
        // A provider that read the prompt and declined to draw it — a
        // copyrighted character, a blocked likeness — has answered, and it will
        // answer the same way every time. Failing here failed the whole
        // GENERATE_BOOK job, so a book whose cast one filter objected to went
        // FAILED before a single page existed, while an interior illustration
        // and a cover that cannot be drawn both let the book finish without
        // them. A sheet is weaker than either: it is the *consistency* aid the
        // page renders attach, so losing one costs one character's likeness
        // holding still, not a page. The rest of the cast keeps rendering —
        // `failed` stays false — and the refusal is written down below.
        if (isImageContentRefusalError(error)) {
          const reason = imageRefusalReason(error);
          refused.push({ name: character.name, reason });
          await logCharacterReferenceRefused({
            projectId: options.projectId,
            planId: options.planId,
            generationJobId: options.generationJobId,
            characterName: character.name,
            reason,
            detail: errorMessage(error)
          });
          continue;
        }
        // Anything else — an outage, a timeout, a spent quota — is not a
        // verdict about this prompt, and recording it as one would settle a
        // book to "no reference sheets" that would have been drawn a minute
        // later. It stays fatal so the job's existing retry ladder runs — but it
        // is *held* rather than thrown, because a rejected `Promise.all` settles
        // while its siblings are still inside a render and their `writeFile`s
        // would land behind the sweep below. `failed` already stops new pickups,
        // so waiting the drawing workers out costs one image call. The first
        // failure is the one raised, which is what `Promise.all` gave.
        failed = true;
        failure ??= { error };
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CHARACTER_REFERENCE_RENDER_CONCURRENCY, Math.max(characters.length, 1)) }, renderWorker)
  );
  // The other half of "a pass owns the files it wrote": an outage part way
  // through the cast throws, `generate-book` retries under a fresh render id,
  // and the sheets this attempt wrote are unreachable from the moment it stops.
  if (failure) {
    await discardCharacterReferenceSheetFiles(options.projectId, renderedSheetFileNames(rendered));
    throw failure.error;
  }

  return { rendered, refused, bookHasLibraryCharacters };
}

/**
 * Whether the rows this plan holds name the sheets *this* pass wrote.
 *
 * Asked at one moment only — the commit threw and nobody knows whether it
 * landed — and it decides an irreversible unlink of a whole cast, so see
 * `renderIsUnpublished` in `characterReferenceRenderLease.ts` for why an
 * exception may not answer it.
 *
 * The evidence is the **file**, and it is computed in the same path space the
 * sweep would unlink in, so the two cannot come to disagree about which bytes
 * are at stake. `characterReferenceFileStems` stamps every stem with this pass's
 * own render id, so a stored row resolving to one of these paths could only have
 * been written by this commit: a rival's cast — drawn under its own id — can
 * neither answer for this pass nor be mistaken for it, which is what makes a
 * read taken after the lease was released sound. One row is enough, the commit
 * being atomic, and one is also the safe direction for a question whose `false`
 * deletes files.
 *
 * A pass that drew nobody — every character refused — has no file to sweep and
 * no filename that could prove anything, so it answers `false` and the sweep
 * runs over an empty list.
 */
function publishedCharacterReferenceSheets(
  projectId: string,
  result: RenderedCharacterReferences,
  current: CharacterReferenceState
): boolean {
  const written = new Set(
    renderedSheetFileNames(result.rendered).map((filename) => join(projectImageDir(projectId), filename))
  );
  return current.assets.some((asset) => {
    const stored = localImagePathForAsset(asset.path, projectId);
    return stored !== undefined && written.has(stored);
  });
}

/**
 * Whether this pass's answer may replace the one that reached the commit first.
 *
 * Two passes over one cast is ordinary now that the renders sit outside the
 * advisory lock — a lease that expired under a slow render is the usual way
 * there — and the loser used to stand down unconditionally, its answer being a
 * duplicate. For two passes that drew the cast it is. But a pass may also answer
 * with a *refusal*, and a refusal settles the set: nothing re-renders it after
 * that, so the sheet a losing pass drew is not late, it is gone for the life of
 * the plan version, and a character's likeness was decided by which commit won a
 * race rather than by which render drew a picture. The two can genuinely
 * disagree — a copyright refusal buys a *text* call to rewrite the prompt, so
 * the second attempt is not the same prompt twice.
 *
 * So a drawing beats a refusal for the same character, and nothing else beats
 * anything: we drew somebody the settled answer only recorded a refusal for,
 * **and** we drew everybody it has a sheet for. The second half is load-bearing
 * because `commitCharacterReferenceSheets` replaces the rows it read rather than
 * merging with them — without it, a pass that drew Beatrice but was refused Ada
 * would take one refusal back by recording another, and the two could ping-pong.
 * Incomparable answers are left with whoever committed first; two full successes
 * are a tie, and a tie is the one thing arrival order settles well.
 */
function supersedesSettledCharacterReferences(
  result: RenderedCharacterReferences,
  settled: CharacterReferenceState
): boolean {
  const drawn = result.rendered.filter((item): item is RenderedCharacterReference => Boolean(item));
  const drew = new Set(drawn.map((item) => characterReferenceNameKey(item.character.name)));
  const settledSheets = settled.assets
    .map((asset) => characterNameFromAssetMetadata(asset.metadata))
    .filter((name): name is string => Boolean(name));
  return (
    settled.refusals.some((refusal) => drew.has(characterReferenceNameKey(refusal.name))) &&
    settledSheets.every((name) => drew.has(characterReferenceNameKey(name)))
  );
}

/**
 * The durable half: one short transaction, under the advisory lock, with every
 * model call already behind it.
 *
 * The settlement and the sheets still commit together — one landing without
 * the other is either a cast re-rendered per page or a character silently
 * given up on — and the delete of the stale set is still atomic with the
 * creates that replace it. What no longer shares that transaction is the
 * waiting.
 */
async function commitCharacterReferenceSheets(
  options: CharacterReferenceRenderOptions,
  tx: Prisma.TransactionClient,
  result: RenderedCharacterReferences,
  current: CharacterReferenceState
): Promise<CharacterReferenceState> {
  // Staked on the rows this pass read under the lock, never on the project.
  // `currentCharacterReferences` filters by `metadata.planId` and the creates
  // below write this plan's cast and nothing else, so every row a
  // `{ projectId, type }` delete took beyond that set was one this transaction
  // neither counted nor replaced: another plan version's settled answer, gone
  // as collateral. The guard has been plan-scoped since the render was first
  // claimed and only the `where` stayed project-wide. Two handlers read those
  // superseded rows on purpose — `handlers/characters.ts` filters a replanned
  // project's sheets by plan precisely because the older ones are still there,
  // and `handlers/applyImageInsertion.ts` falls back to them when the current
  // plan has none — so losing them draws a cast the reader recognises from
  // prose alone, and buys an unbilled re-render of every character if that plan
  // version is current again, which an undo of a structural edit makes it.
  if (current.assets.length > 0) {
    await tx.imageAsset.deleteMany({ where: { id: { in: current.assets.map((asset) => asset.id) } } });
  }
  await recordCharacterReferenceRefusals(tx, options.planId, result.refused, current.refusals);

  // Sequential by necessity: an interactive transaction client must not run
  // queries concurrently.
  const created: WorkerImageAsset[] = [];
  for (const item of result.rendered) {
    if (!item) {
      continue;
    }
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
          ...librarySeedMetadata(item.seeding, result.bookHasLibraryCharacters)
        }
      }
    });
    created.push(toWorkerImageAsset(asset));
  }

  return { assets: created, refusals: [...result.refused] };
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

export type LibraryPortraitSeedOutcome =
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

/**
 * The security-relevant ownership trio — owner-prefix check,
 * `libraryCharacterDiskPath`, `stat` — lives here and only here; every path
 * that reads a portrait off a stored snapshot (seeding, page faces, the chat
 * `add_image` insertion) resolves through it.
 */
export async function resolveLibraryPortraitSeed(
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
 * One line per refused sheet, beside the skipped-seed lines above and for the
 * same reason: from the finished book, a character drawn without a reference
 * sheet and a character the plan never had look exactly alike.
 */
async function logCharacterReferenceRefused(options: {
  projectId: string;
  planId: string;
  generationJobId: string | undefined;
  characterName: string;
  reason: string;
  detail: string;
}): Promise<void> {
  console.warn("Character reference sheet refused; the book will render without it", {
    event: "generation.consistency_warning",
    warning: "character_reference_refused",
    projectId: options.projectId,
    // The refusal is permanent *per plan version*, and this is the only place it
    // is announced anywhere an operator is looking — the run-log line below is a
    // file inside the project's own directory. Without the plan id it names the
    // fact and not the row that holds it, which is the row
    // `scripts/clear-character-reference-refusals.ts` has to be pointed at.
    planId: options.planId,
    characterName: options.characterName,
    reason: options.reason
  });
  const logDir = join(config.BOOK_STORAGE_DIR, options.projectId, "runs");
  const runId = safePathPart(options.generationJobId ?? "unknown-run");
  const entry = {
    timestamp: new Date().toISOString(),
    event: "character.reference.refused",
    projectId: options.projectId,
    planId: options.planId,
    generationJobId: options.generationJobId,
    characterName: options.characterName,
    reason: options.reason,
    detail: options.detail
  };
  try {
    await mkdir(logDir, { recursive: true });
    await appendFile(join(logDir, `${runId}-character-references.jsonl`), `${safeJsonStringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error(`Failed to record a refused character reference sheet for ${options.projectId}`, error);
  }
}

// What a render attaches and what it says about it: one module, because the
// sentences are indexed and a layer that shortens the attachment has to be
// able to state them again. Re-exported here so every caller still reaches
// both through the module that builds the selection.
export { characterReferencePromptInstruction } from "./characterReferencePrompt.js";
export type { CharacterReferenceSelection } from "./characterReferencePrompt.js";

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

export function imageAssetPlanId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>).planId;
  return typeof value === "string" ? value : undefined;
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

export function toWorkerImageAsset(asset: { id: string; path: string; metadata: unknown }): WorkerImageAsset {
  return {
    id: asset.id,
    path: asset.path,
    metadata: asset.metadata
  };
}
