import { strategyForInput } from "./bookHelpers.js";
import {
  characterReferencePromptInstruction,
  imageAssetPlanId,
  librarySnapshotForSheet,
  resolveLibraryPortraitSeed,
  selectReferenceImagePaths,
  toWorkerImageAsset,
  type CharacterReferenceSelection
} from "./characterReferences.js";
import {
  imageAdapterCapabilities,
  libraryCharactersFromMediaSettings,
  matchLibraryCharacter,
  optimizeImageForStorage,
  type BookPlan,
  type CreateProjectInput,
  type GeneratedImageBytes,
  type ImageAdapter,
  type LibraryCharacterSnapshot
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { objectKey, objectStore } from "@book-maker/storage";

/**
 * The render core of a one-off illustration — a picture somebody asked for by
 * describing it, rather than one a book's plan scheduled for a page.
 *
 * Two jobs draw one: the chat's `add_image` (`handlers/applyImageInsertion.ts`),
 * which puts it on a page of a finished book, and the Writing Studio's
 * Illustrate (`handlers/writingAssist.ts`), which hands it back to the author
 * as a suggestion. They share everything up to the stored bytes — which
 * references travel, what the prompt says about them, the wrapped render, the
 * optimise-and-store — and nothing after it: where the picture goes, and what
 * settles when it gets there, is each handler's own.
 *
 * `plan` is optional because a Studio book that has never been published has
 * none. Without one there are no character sheets to select (sheets are chosen
 * against the plan's cast), so the selection is library portraits alone.
 */

export type IllustrationReferenceOptions = {
  projectId: string;
  /** The plan version whose sheets are preferred; absent for a never-published Studio book. */
  planVersionId?: string | null | undefined;
  /** What the picture is of — the text sheets and saved characters are matched against. */
  subject: string;
  input: CreateProjectInput;
  plan?: BookPlan | null | undefined;
  image: ImageAdapter;
  projectUserId: string | null;
  /**
   * Saved characters to attach beyond the book's own snapshot match, in
   * priority order — the Studio's cast. Each goes through the same ownership
   * trio (`resolveLibraryPortraitSeed`) as every other portrait read, and only
   * into reference budget the sheets left. Absent for the chat's `add_image`,
   * whose selection is exactly what it always was.
   */
  portraitCandidates?: readonly LibraryCharacterSnapshot[] | undefined;
};

/**
 * Reference images for a one-off illustration.
 *
 * Never `ensureCharacterReferenceAssets`: it filters sheets by
 * `metadata.planId` and would delete and re-render the whole cast after any
 * continuation or replan — one unbilled image call per character inside a job
 * quoted at one image — and for a non-illustrated book it returns nothing,
 * dropping library faces with it. Existing sheets are read as they are: the
 * current plan's, falling back to any earlier plan's, which still show the
 * same cast.
 */
export async function insertionReferenceSelection(
  options: IllustrationReferenceOptions
): Promise<CharacterReferenceSelection> {
  const { plan } = options;
  const allSheets = plan
    ? await prisma.imageAsset.findMany({
        where: { projectId: options.projectId, type: "CHARACTER_REFERENCE" },
        orderBy: { createdAt: "asc" }
      })
    : [];
  const currentPlanSheets = options.planVersionId
    ? allSheets.filter((asset) => imageAssetPlanId(asset.metadata) === options.planVersionId)
    : [];
  const sheets = currentPlanSheets.length > 0 ? currentPlanSheets : allSheets;
  const selection: CharacterReferenceSelection = plan
    ? await selectReferenceImagePaths({
        input: options.input,
        plan,
        assets: sheets.map(toWorkerImageAsset),
        projectId: options.projectId,
        image: options.image,
        context: options.subject
      })
    : { paths: [], libraryFaceNames: [] };
  const capabilities = imageAdapterCapabilities(options.image);
  if (!plan && (!capabilities.supportsReferenceImages || capabilities.maxReferenceImages <= 0)) {
    // `selectReferenceImagePaths` asks this itself; without a plan it is never
    // called, and a provider that takes no references must be sent none.
    return selection;
  }
  const budget = capabilities.maxReferenceImages - selection.paths.length;
  if (budget <= 0) {
    return selection;
  }
  // A saved character named in the subject whose book has no sheet for them —
  // a text-only book has none at all — still gets their portrait attached, or
  // the reader's own character would be drawn from prose alone. The seeding
  // path's ownership trio (`resolveLibraryPortraitSeed`) is the only way a
  // portrait is ever read off a stored snapshot.
  const snapshots = libraryCharactersFromMediaSettings(options.input.mediaSettings);
  const match = matchLibraryCharacter(options.subject, snapshots);
  const withMatch =
    !match || sheets.some((asset) => librarySnapshotForSheet(asset.metadata, [match]) !== null)
      ? selection
      : await withLibraryPortrait(selection, match, options.projectUserId);
  if (!options.portraitCandidates?.length) {
    return withMatch;
  }
  return withCandidatePortraits(withMatch, sheets, options.portraitCandidates, options.projectUserId, capabilities.maxReferenceImages);
}

async function withLibraryPortrait(
  selection: CharacterReferenceSelection,
  match: LibraryCharacterSnapshot,
  projectUserId: string | null
): Promise<CharacterReferenceSelection> {
  const outcome = await resolveLibraryPortraitSeed(match, projectUserId);
  if (!outcome.seeded) {
    return selection;
  }
  return {
    paths: [...selection.paths, outcome.seed.path],
    libraryFaceNames: [...selection.libraryFaceNames, match.name]
  };
}

/**
 * The Studio cast, attached after everything above and only into what is left
 * of the budget. A character already attached — by a sheet or by the snapshot
 * match — is not attached twice.
 */
async function withCandidatePortraits(
  selection: CharacterReferenceSelection,
  sheets: ReadonlyArray<{ metadata: unknown }>,
  candidates: readonly LibraryCharacterSnapshot[],
  projectUserId: string | null,
  maxReferences: number
): Promise<CharacterReferenceSelection> {
  let current = selection;
  for (const candidate of candidates) {
    if (current.paths.length >= maxReferences) {
      break;
    }
    const alreadyAttached =
      current.libraryFaceNames.includes(candidate.name) ||
      sheets.some((asset) => librarySnapshotForSheet(asset.metadata, [candidate]) !== null);
    if (!alreadyAttached) {
      current = await withLibraryPortrait(current, candidate, projectUserId);
    }
  }
  return current;
}

/**
 * The prompt, as a function of what is attached rather than of the selection:
 * the instruction counts the pictures and names the last few as saved faces,
 * so a fallback that can take fewer has to be able to say it again for what
 * it sends (`ImageRequest.promptForReferenceImages`).
 *
 * `context` lines are the caller's own framing — the chat's request and
 * character context, the Studio's passage and cast — and an empty one is
 * dropped. `pageRules` present (even empty) prints the continuity line the
 * chat's insertion always printed; absent prints none.
 */
export function illustrationPromptForReferences(options: {
  subject: string;
  context: readonly string[];
  selection: CharacterReferenceSelection;
  globalStyle: string;
  pageRules?: readonly string[] | undefined;
}): (attached: readonly string[]) => string {
  return (attached) =>
    [
      `Create one interior book illustration depicting: ${options.subject}.`,
      ...options.context,
      characterReferencePromptInstruction(options.selection, attached),
      `Global visual style: ${options.globalStyle}`,
      options.pageRules ? `Continuity rules: ${options.pageRules.join(" ")}` : ""
    ]
      .filter(Boolean)
      .join("\n");
}

/**
 * One wrapped render. No try/catch: a failed render must fail the caller's job
 * (and refund through its attempt settlement). The `FallbackImageAdapter`
 * chain and the copyright-safe rewrite inside the logged provider are the
 * resilience budget, exactly as for generated pages.
 */
export async function renderIllustration(options: {
  input: CreateProjectInput;
  image: ImageAdapter;
  prompt: string;
  projectId: string;
  pageId?: string | undefined;
  selection: CharacterReferenceSelection;
  promptForReferenceImages: (attached: readonly string[]) => string;
}): Promise<GeneratedImageBytes> {
  return strategyForInput(options.input).generateImageBytes({
    image: options.image,
    prompt: options.prompt,
    projectId: options.projectId,
    ...(options.pageId ? { pageId: options.pageId } : {}),
    referenceImagePaths: options.selection.paths,
    promptForReferenceImages: options.promptForReferenceImages
  });
}

/**
 * Optimise and store under `images/<projectId>/`, which the authenticated
 * `/assets/images/` route serves. The caller names the file, because the name
 * is where each caller's idempotence lives: the chat's insertion is
 * delivery-unique, the Studio's is the assist's own id.
 */
export async function storeIllustration(options: {
  projectId: string;
  image: { bytes: Buffer; mimeType: string };
  fileName: (extension: string) => string;
}): Promise<{ fileName: string; objectKey: string; assetPath: string }> {
  const optimized = await optimizeImageForStorage({ bytes: options.image.bytes, mimeType: options.image.mimeType });
  const fileName = options.fileName(optimized.extension);
  const key = objectKey("images", options.projectId, fileName);
  await objectStore().put(key, optimized.bytes, { contentType: optimized.mimeType });
  return { fileName, objectKey: key, assetPath: `/assets/images/${options.projectId}/${fileName}` };
}
