import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import type { ImageAdapterCapabilities } from "../adapters/types.js";
import { coverArtSourceFor } from "./coverSource.js";

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
  if (!character) {
    return 0;
  }
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
