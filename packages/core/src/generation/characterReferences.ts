import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import type { ImageAdapterCapabilities } from "../adapters/types.js";
import { coverArtSourceFor } from "./coverSource.js";
import { cleanText, coverConceptText } from "./coverText.js";
import { shouldIllustratePage } from "./illustrationSlots.js";
import {
  libraryCharactersFromMediaSettings,
  matchLibraryCharacter,
  type LibraryCharacterSnapshot
} from "./libraryCharacters.js";

type Character = BookPlan["characters"][number];

export type CharacterReferenceAsset = {
  path: string;
  metadata?: unknown;
};

export type BuildCharacterReferencePromptOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  character: Character;
};

export type SelectCharacterReferenceOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  assets: CharacterReferenceAsset[];
  context: string;
  maxReferences: number;
};

export function shouldGenerateCharacterReferences(input: CreateProjectInput, plan: BookPlan): boolean {
  // Only an AI cover can use a reference sheet; a designed cover draws nothing,
  // so generating them for one would be image spend no quote includes.
  return (
    plan.characters.length > 0 &&
    (input.mediaSettings.fullIllustrations || coverArtSourceFor(input.mediaSettings) === "ai")
  );
}

/**
 * The most characters a cover-only book's cover depicts, and so the most saved
 * portraits it attaches. A constant rather than the image adapter's own
 * reference budget, because the cover job and its reference selection have to
 * compute the same cast. Three is the smallest budget a supported model takes.
 */
export const COVER_CAST_MAX = 3;

/**
 * The plan characters an AI cover depicts: the ones its concept names
 * (`coverConceptText`), in plan order, at most `COVER_CAST_MAX`. A concept
 * that names nobody depicts nobody.
 */
export function coverCastCharacters(input: CreateProjectInput, plan: BookPlan): Character[] {
  const concept = coverConceptText(input, plan);
  return plan.characters.filter((character) => characterNamedIn(character, concept)).slice(0, COVER_CAST_MAX);
}

/**
 * The plan characters this book draws a reference sheet for — the set a
 * settled pass has to answer for, and the only set a pass renders.
 *
 * A book with interior illustrations draws its whole cast: every page may
 * need anyone. (A short book whose draft decided who its pictures show draws
 * that cast instead — `characterReferenceCastFromDraft`, stored on the plan
 * version by the worker; this is the answer wherever nothing was decided.)
 * A cover-only book draws none. A sheet keeps a character looking like itself
 * from one picture to the next (`CHARACTER_REFERENCE_MIN_PICTURES`), and the
 * cover is the only picture: it drew everyone at first — "Tiko and the Quiet
 * Sea" (2026-10-01) rendered four sheets for a cover of one tortoise — then
 * only who the cover names, which still bought "The Last Table" (2026-10-17)
 * two sheets for its one cover, $0.078 of its $0.129. A sheet is drawn from
 * the same words the cover would be, so it gave the cover nothing to copy. A
 * cover-cast character the reader saved with a portrait still reaches the
 * cover: it attaches the portrait itself (`coverPortraitCharacters`), which
 * never needed a sheet.
 */
export function characterReferenceCast(input: CreateProjectInput, plan: BookPlan): Character[] {
  if (!shouldGenerateCharacterReferences(input, plan) || !input.mediaSettings.fullIllustrations) {
    return [];
  }
  return plan.characters;
}

/** How many of a book's drawn pictures have to name a character before a sheet is drawn for them. */
export const CHARACTER_REFERENCE_MIN_PICTURES = 2;

/** A page of a whole-book draft, as far as what its picture shows. */
export type DraftPictureSource = { index: number; imagePrompt?: string | null | undefined };

/**
 * The cast an illustrated book's whole-book draft decides its sheets for: the
 * plan characters (in plan order) named in at least
 * `CHARACTER_REFERENCE_MIN_PICTURES` of the pictures the book will draw, plus
 * every one the reader saved with artwork. `undefined` when there is nothing to
 * decide — no sheets at all, or a book whose pages are not illustrated, whose
 * cover cast `characterReferenceCast` already answers — and `[]` is a decision
 * to draw none.
 *
 * A sheet is a consistency aid: it keeps a character looking like itself from
 * one picture to the next, so a character drawn once has nothing to be
 * consistent with. The whole plan cast is what an illustrated book drew, and
 * sheets are $0.039 image calls drawn before any page picture: a 10-page
 * children's story at four pictures (pages 1, 3, 6, 8) named its otter in all
 * four and a frog, a heron and a beaver in one each, and drew four sheets for
 * it; over 45 days books drew four sheets for two pictures and three for one.
 *
 * The drawn pictures are the draft pages that get an interior illustration —
 * `illustratesPage` with a prompt, exactly what `enqueueDraftPageIllustrations`
 * queues, so a page outside the billed cap counts for nothing — and the cover
 * when it is drawn by a model, since an illustrated book's cover attaches the
 * same sheets: as a picture of whom its concept names (`coverCastCharacters`),
 * or of the lead alone when that concept is only the brief
 * (`coverConceptIsBrief`). Names are matched by `characterNamedIn`, the
 * test the cover cast and the page selection already use. A character matching
 * a library snapshot with saved artwork always keeps their sheet, because a
 * page render attaches the reader's face only beside that character's own sheet
 * (`libraryFacesForSheets` in the worker): without it, their saved face would
 * reach no picture at all.
 *
 * Only the short-book pass asks this, and only once per plan version: its
 * answer is stored so every later caller computes the identical cast.
 */
export function characterReferenceCastFromDraft(
  input: CreateProjectInput,
  plan: BookPlan,
  pages: readonly DraftPictureSource[],
  illustratesPage: (input: CreateProjectInput, plan: BookPlan, pageIndex: number) => boolean = shouldIllustratePage
): Character[] | undefined {
  if (!shouldGenerateCharacterReferences(input, plan) || !input.mediaSettings.fullIllustrations) {
    return undefined;
  }
  const pictures = pages.flatMap((page) => {
    const prompt = page.imagePrompt?.trim();
    return prompt && illustratesPage(input, plan, page.index) ? [prompt] : [];
  });
  const coverCast = coverArtSourceFor(input.mediaSettings) !== "ai"
    ? []
    : coverConceptIsBrief(input, plan) ? plan.characters.slice(0, 1) : coverCastCharacters(input, plan);
  const snapshots = libraryCharactersFromMediaSettings(input.mediaSettings);
  return plan.characters.filter(
    (character) =>
      Boolean(matchLibraryCharacter(character.name, snapshots)?.portraitFile) ||
      pictures.filter((picture) => characterNamedIn(character, picture)).length + (coverCast.includes(character) ? 1 : 0) >=
        CHARACTER_REFERENCE_MIN_PICTURES
  );
}

/**
 * Whether an AI cover's concept is only the book's brief: the planner wrote none, so
 * `makeFallbackPlan`'s `Cover illustration for <title>: <prompt>` stands (or the bare prompt, which
 * `coverConceptText` falls back to). 145 of 172 plans with characters in the 45 days to 2026-10-17
 * carried it. A brief names everyone the story has, not who the cover shows, so counting it as a
 * picture of each of them gave every one-off friend a second picture and kept every sheet; read
 * that way it shows the lead (`plan.characters[0]`), which keeps the cover consistent with the
 * pages without drawing a sheet for a character one page shows.
 */
function coverConceptIsBrief(input: CreateProjectInput, plan: BookPlan): boolean {
  const concept = cleanText(plan.illustrationPlan.coverPrompt);
  const brief = cleanText(input.prompt);
  return !concept || (brief.length > 0 && concept.startsWith("Cover illustration for ") && concept.endsWith(brief));
}

/**
 * Cover-cast characters of a cover-only AI book whose library snapshot carries
 * saved artwork: the cover attaches that file in place of a sheet. Read off the
 * snapshot alone, so the cast is the same answer for every caller; a file that
 * has gone, or that is not the owner's, resolves to nothing at render time and
 * the character is drawn from prose — the deletion valve seeding already has.
 */
export function coverPortraitCharacters(
  input: CreateProjectInput,
  plan: BookPlan
): Array<{ character: Character; snapshot: LibraryCharacterSnapshot }> {
  if (input.mediaSettings.fullIllustrations || coverArtSourceFor(input.mediaSettings) !== "ai") {
    return [];
  }
  const snapshots = libraryCharactersFromMediaSettings(input.mediaSettings);
  if (!snapshots.some((snapshot) => snapshot.portraitFile)) {
    return [];
  }
  return coverCastCharacters(input, plan).flatMap((character) => {
    const snapshot = matchLibraryCharacter(character.name, snapshots);
    return snapshot?.portraitFile ? [{ character, snapshot }] : [];
  });
}

export function shouldUseCharacterReferenceImages(
  input: CreateProjectInput,
  plan: BookPlan,
  capabilities: ImageAdapterCapabilities
): boolean {
  return (
    shouldGenerateCharacterReferences(input, plan) &&
    capabilities.supportsReferenceImages &&
    capabilities.maxReferenceImages > 0
  );
}

export function buildCharacterReferencePrompt(options: BuildCharacterReferencePromptOptions): string {
  const character = options.character;
  const style = options.input.mediaSettings.imageStyle ?? options.plan.illustrationPlan.globalStyle;
  return [
    "Text-free single-character reference image for a fictional book character.",
    `Character name: ${character.name}.`,
    `Role: ${character.role}.`,
    `Description: ${character.description}.`,
    character.traits.length ? `Personality traits to imply visually: ${character.traits.join(", ")}.` : "",
    character.visualRules.length
      ? `Authoritative visual rules to preserve in every future illustration: ${character.visualRules.join(" ")}`
      : "Create a simple, memorable, repeatable design with distinctive silhouette, outfit, palette, and face details.",
    `Book art style: ${style}.`,
    "Show exactly one full-body character in one simple front-facing pose, centered in the image.",
    "Do not show alternate angles, turnarounds, expression studies, multiple poses, duplicate characters, panels, thumbnails, or close-up detail views.",
    "Use a plain light background, clear silhouette, consistent outfit and colors, natural child-safe presentation when age is young.",
    "Do not include readable text, labels, captions, letters, numbers, signatures, watermarks, logos, UI, panels with headings, or speech bubbles."
  ]
    .filter(Boolean)
    .join("\n");
}

export function selectCharacterReferenceAssets(options: SelectCharacterReferenceOptions): CharacterReferenceAsset[] {
  if (options.maxReferences <= 0 || options.assets.length === 0 || options.plan.characters.length === 0) {
    return [];
  }

  const ordered = oneSheetPerCharacter(
    options.assets
      .map((asset) => ({
        asset,
        characterIndex: characterIndexForAsset(options.plan.characters, asset),
        score: scoreAssetForContext(options.plan.characters, asset, options.context)
      }))
      .filter((entry) => entry.characterIndex >= 0)
  );

  if (options.input.category === "KIDS" && ordered.length <= options.maxReferences) {
    return ordered.sort(byPlanOrderThenScore).map((entry) => entry.asset);
  }

  const matched = ordered
    .filter((entry) => entry.score > 0)
    .sort((first, second) => second.score - first.score || first.characterIndex - second.characterIndex);
  if (matched.length > 0) {
    return matched.slice(0, options.maxReferences).map((entry) => entry.asset);
  }

  if (ordered.length === 1) {
    return [ordered[0]!.asset];
  }

  return [];
}

type ScoredCharacterReference = {
  asset: CharacterReferenceAsset;
  characterIndex: number;
  score: number;
};

/**
 * One sheet per plan character, because a superseded cast is still the same
 * cast.
 *
 * A book's sheets used to be one plan version's: the render pass deleted every
 * `CHARACTER_REFERENCE` row on the project before writing its own. That delete
 * is scoped to the ids the commit read now — it had to be, or one plan
 * version's commit would destroy another's — so every replan and every
 * continuation leaves a whole cast behind, and the one reader that ranges
 * across them (`insertionReferenceSelection` in
 * `apps/worker/src/handlers/applyImageInsertion.ts`, which falls back to *all*
 * of a project's sheets when the current plan has none) hands this function
 * three drawings of Ada beside three of Beatrice.
 *
 * They score identically — the score is a function of the character's name and
 * the context, not of the file — so the sort below is a tie every duplicate
 * wins, and a book replanned twice spent its entire 3-to-5 reference budget on
 * one character while the rest of the cast was attached to nothing and drawn
 * from prose alone. The `ordered.length === 1` fallback missed for the same
 * reason: one character with three sheets counted as three.
 *
 * The **last** copy wins. Every caller reads the rows `orderBy: { createdAt:
 * "asc" }`, so the last sheet for a character is the newest one — drawn against
 * the most recent plan's description of them, which is the one the current
 * plan's `characters` entry was reconciled against.
 */
function oneSheetPerCharacter(entries: ScoredCharacterReference[]): ScoredCharacterReference[] {
  const newest = new Map<number, ScoredCharacterReference>();
  for (const entry of entries) {
    newest.set(entry.characterIndex, entry);
  }
  return [...newest.values()];
}

function byPlanOrderThenScore(
  first: { characterIndex: number; score: number },
  second: { characterIndex: number; score: number }
): number {
  return first.characterIndex - second.characterIndex || second.score - first.score;
}

function scoreAssetForContext(characters: Character[], asset: CharacterReferenceAsset, context: string): number {
  const character = characters[characterIndexForAsset(characters, asset)];
  return character ? nameScore(character, context) : 0;
}

/** Whether `text` names the character, by the same test the sheet selection scores with. */
function characterNamedIn(character: Character, text: string): boolean {
  return nameScore(character, text) > 0;
}

function nameScore(character: Character, context: string): number {
  const haystack = context.toLowerCase();
  let score = mentionsName(haystack, character.name) ? 10 : 0;
  const firstName = character.name.split(/\s+/)[0];
  if (firstName && firstName !== character.name && mentionsName(haystack, firstName)) {
    score += 4;
  }
  return score;
}

function characterIndexForAsset(characters: Character[], asset: CharacterReferenceAsset): number {
  const name = characterNameFromMetadata(asset.metadata);
  if (!name) {
    return -1;
  }
  return characters.findIndex((character) => character.name.toLowerCase() === name.toLowerCase());
}

function characterNameFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>).characterName;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mentionsName(haystack: string, name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(trimmed)}([^a-z0-9]|$)`, "i").test(haystack);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
