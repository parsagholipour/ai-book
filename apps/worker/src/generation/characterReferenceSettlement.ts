import { characterReferenceNameKey } from "./characterReferenceFileNames.js";
import { type BookPlan } from "@book-maker/core";

/**
 * What counts as an *answer* for a plan's cast, and how two answers are
 * compared.
 *
 * The third pure piece cut out of `characterReferences.ts`, beside the naming rules in
 * `characterReferenceFileNames.ts` and the file lifetimes in
 * `characterReferenceSheetFiles.ts`: no row, no file, no provider. It is the
 * whole of the pass's cost control — every illustrated page's image job and the
 * cover job ask `characterReferenceSetIsSettled` before doing anything else, and
 * a set it calls unsettled is a cast redrawn.
 */

export function characterReferenceRefusalsAgree(
  left: readonly CharacterReferenceRefusal[],
  right: readonly CharacterReferenceRefusal[]
): boolean {
  return left.length === right.length && refusalSetKey(left) === refusalSetKey(right);
}

/** Two separators no name and no provider reason code holds, so no two sets fold to one key. */
function refusalSetKey(refusals: readonly CharacterReferenceRefusal[]): string {
  return refusals
    .map((refusal) => `${refusal.name}\u0000${refusal.reason}`)
    .sort()
    .join("\u0001");
}

/** A plan character an image provider declined to draw, and the word it used. */
export type CharacterReferenceRefusal = {
  name: string;
  reason: string;
};

/**
 * Whether this plan's sheet set has an answer for every character — a drawn
 * sheet, or a recorded refusal.
 *
 * The check used to be "does every character have a sheet", which a refused
 * character can never satisfy. Once the render pass was allowed to carry on
 * past a refusal that would have been an unbounded bill: every illustrated
 * page's image job and the cover job call this, each would find the set
 * incomplete, take the advisory lock, delete the sheets and render the whole
 * cast again — the refusal paid for once per page, and the rest of the cast
 * redrawn per page, which is the consistency the sheets exist to provide.
 * Both sides go through `characterReferenceNameKey`, which is the whole point
 * of that helper: the stored sides trim on the way out, so a plan name
 * compared raw is a character nothing can ever answer for.
 */
export function characterReferenceSetIsSettled(
  assets: Array<{ metadata: unknown }>,
  refusals: readonly CharacterReferenceRefusal[],
  plan: BookPlan
): boolean {
  const stored = [
    ...assets.map((asset) => characterNameFromAssetMetadata(asset.metadata) ?? ""),
    ...refusals.map((refusal) => refusal.name)
  ];
  const answered = new Set(stored.map(characterReferenceNameKey).filter(Boolean));
  return plan.characters.every((character) => answered.has(characterReferenceNameKey(character.name)));
}

export function parseCharacterReferenceRefusals(value: unknown): CharacterReferenceRefusal[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) {
      return [];
    }
    const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason.trim() : "refused";
    return [{ name, reason }];
  });
}

export function characterNameFromAssetMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>).characterName;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
