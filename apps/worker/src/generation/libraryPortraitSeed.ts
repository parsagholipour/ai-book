import {
  libraryCharacterObjectKey,
  type LibraryCharacterPortraitSource,
  type LibraryCharacterSnapshot
} from "@book-maker/core";
import { objectReference, objectStore } from "@book-maker/storage";

/**
 * Which saved artwork a render may read for a library character. Split out of
 * `characterReferences.ts` so the sheet pass's seeding and the cover's and
 * pages' attachment (`characterReferenceSelection.ts`) share one ownership rule.
 */

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

/**
 * The security-relevant ownership trio — owner-prefix check,
 * `libraryCharacterObjectKey`, object HEAD — lives here and only here; every path
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
  const path = libraryCharacterObjectKey(match.portraitFile);
  if (!path) {
    return { seeded: false, reason: "portrait_path_rejected", ...matched };
  }
  if (!(await objectStore().head(path))) {
    return { seeded: false, reason: "portrait_file_missing", ...matched };
  }
  return { seeded: true, seed: { id: match.id, path: objectReference(path), source: match.portraitSource ?? "generated" } };
}
