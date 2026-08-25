import type { OptimizedImage } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import {
  PORTRAIT_OPEN_STATUSES,
  recordCharacterImage,
  type RecordedCharacterImage
} from "./characterImageStore.js";
import type { CharacterPhotoReading } from "./characterPhotoVision.js";
import { deleteLibraryCharacterFile } from "./characterStorage.js";
// The traversal, not the answer: `libraryMentionConstraintErrors.ts` owns where a
// driver reports a SQLSTATE, and this file owns which constraint it cares
// about. Nothing that module imports reaches back here, and the one route group
// that calls both already loads them together.
import { constraintErrorText } from "./libraryMentionConstraintErrors.js";

/**
 * Everything `PUT /:id/photo` writes once the reading is back, and the one race
 * all of it shares.
 *
 * Four statements over two tables — the retained version and its bytes, the
 * character's own photo columns, the look the reading filled in, the reference
 * claim — kept together because they are not four decisions. Each is driven by
 * the one `CharacterPhotoReading`, and every one of them lands up to
 * `CHARACTER_PHOTO_VISION_BUDGET_MS` after the row the route read: long enough
 * for the reader to have typed a look of their own on their other device,
 * started a portrait there, or deleted the character outright. The first two
 * windows are why two of these writes are a conditional `updateMany` rather
 * than fields on the write above them; the third is the pair of predicates
 * below, and it is the only one that has an answer to give the reader.
 *
 * The route keeps what only it can do — the rationing, the 404, the prune and
 * the read that serializes. Nothing here claims a *pointer* the way
 * `writeCharacterPointers` does in the group, because an upload decides from
 * the bytes it was handed rather than from a row it read: the photo columns
 * describe the file that just arrived and are true of it whatever the row says.
 */

/**
 * The rows an upload may move the reference on.
 *
 * Adoption is free and instant, so the only things it must never do are
 * overwrite work someone paid for and race the job that is producing it. A
 * failed or absent portrait is fair game — the reader's own artwork beats a
 * generation that did not happen — and so is an earlier adopted one, which is
 * simply the previous upload.
 *
 * This is a `where` rather than a predicate on the row the handler read,
 * because up to `CHARACTER_PHOTO_VISION_BUDGET_MS` passes between that read
 * and this write: a portrait the reader started in the meantime holds the row,
 * and clobbering its QUEUED claim would let the next start charge a second
 * time. It is the same compare-and-set `POST /:id/portrait` makes for the same
 * reason.
 *
 * Losing it is silent. An upload is not a portrait request, so "your photo was
 * stored but is a photograph" is a state the app renders, not an error the
 * upload fails with.
 */
const REFERENCE_CLAIMABLE = {
  portraitStatus: { notIn: [...PORTRAIT_OPEN_STATUSES] },
  NOT: { AND: [{ portraitSource: "GENERATED" as const }, { portraitStatus: "READY" as const }] }
};

/**
 * Whether this upload becomes the character's reference image outright.
 *
 * Only a confident single-subject illustration does. An upload used to be able
 * to *retire* an adopted reference too — an undrawable photo landing on a
 * character whose reference was the photo being replaced — on the grounds that
 * a book would otherwise draw artwork the reader had swapped out. With every
 * version retained that is simply untrue: the artwork is still in the strip,
 * still what the books draw, and one tap from being replaced deliberately. So
 * adding a picture no longer takes a character's look away without saying so.
 */
function adoptsAsReference(reading: CharacterPhotoReading | null): boolean {
  return reading?.canAdoptAsReference === true;
}

/**
 * Writes the look read off the photo into `appearance`, but only onto a
 * character that has none.
 *
 * This is the one thing the upload *applies* rather than offers, and the
 * asymmetry with `suggestedDescription` is deliberate. A description is prose
 * the user wrote about who their character is, so it is theirs and is never
 * overwritten. An appearance is a field they have never had, empty on every
 * existing row — and empty is not a neutral default: it is precisely the state
 * in which the planner invents a look for the character it was told to reuse
 * and writes that invention into every illustration prompt, where it beats the
 * reference image attached beside it. Leaving the fix behind a tap would mean
 * the default path — upload a photo, tap nothing — stays broken, and the
 * default path is the bug.
 *
 * Filling is therefore additive by construction: `appearance` moves only from
 * "nothing recorded" to "what your picture shows", never from one look to
 * another. A reading that lands on a character who already has one is offered
 * on the response instead, exactly as a description is.
 *
 * A compare-and-set rather than a field on the photo write beside it, for the
 * same reason `REFERENCE_CLAIMABLE` is one: up to
 * `CHARACTER_PHOTO_VISION_BUDGET_MS` passes between reading the row and this
 * write, which is long enough for the user to have typed an appearance of their
 * own in the editor.
 */
async function fillAppearanceFromPhoto(
  characterId: string,
  reading: CharacterPhotoReading | null
): Promise<boolean> {
  const appearance = reading?.suggestedAppearance;
  if (!appearance) {
    return false;
  }
  const filled = await prisma.libraryCharacter.updateMany({
    where: { id: characterId, OR: [{ appearance: null }, { appearance: "" }] },
    data: { appearance }
  });
  return filled.count === 1;
}

/**
 * The race these two predicates are both about, and why it is two of them.
 *
 * It is ordinary and nothing on this side prevents it: the upload reads the
 * character, spends up to `CHARACTER_PHOTO_VISION_BUDGET_MS` reading the photo,
 * and only then writes — so the reader deleting that character on their other
 * device in the meantime is a gesture, not an exotic interleaving. It arrives
 * in two shapes, because the statements that can meet it are two different
 * statements, and **each predicate is scoped to the one that asks it**.
 *
 * That scoping is the whole point rather than tidiness. `P2025` is
 * *"the record required was not found"* — a fact about whatever row the
 * statement that raised it required, which is only "the character" when the
 * statement named exactly one `LibraryCharacter` by id. The version insert does
 * not: it writes a `LibraryCharacterImage`, and one predicate answering `true`
 * for any `P2025` read the insert's own missing-record failure as a deleted
 * character. Nothing raises that today — `recordCharacterImage`'s single
 * `delete` swallows its own rejection — and nothing enforced it either, so the
 * first `update`, `delete` or `connect` added inside it would have answered
 * `PUT /:id/photo` with a 404 for a character that is sitting right there,
 * after the version row and its bytes had already landed.
 *
 * Everything else is a genuine failure and stays a 500. That distinction is
 * what the reading is *for*: the caller unlinks the bytes it just wrote on a
 * `true`, and after any other failure those bytes are still named by their own
 * row — in the strip, one tap from being deleted — where unlinking them would
 * turn the recoverable half of `recordCharacterImage`'s rule into the
 * unrecoverable one.
 */

/**
 * The version insert's shape: the retained row's parent went away under it.
 *
 * `LibraryCharacterImage_characterId_fkey` — SQLSTATE `23503`, Prisma `P2003`.
 * That is the **only** foreign key the table has (`userId` is denormalized and
 * carries none), so a `23503` naming it is a character that went away and there
 * is nothing else it can be, which is what lets one test answer for the
 * constraint without asking which. Read out of `constraintErrorText`, which
 * owns the question of which field a driver put a SQLSTATE and a constraint
 * name in — the fact this predicate used to keep its own third copy of.
 */
export function namesOrphanedCharacterImage(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const text = constraintErrorText(error);
  if (/LibraryCharacterImage_[A-Za-z]+_fkey/.test(text)) {
    return true;
  }
  return /\bP2003\b|\b23503\b/.test(text) && /LibraryCharacterImage/.test(text);
}

/**
 * The pointer write's shape: a statement naming one character by id found no
 * row to update.
 *
 * Prisma `P2025`, asked of the error itself because it is a code and nothing
 * else. It means "the character was deleted" only for a caller whose statement
 * names exactly one `LibraryCharacter` by id — which the two pointer writes do
 * (`storeCharacterPhotoUpload`'s `libraryCharacter.update`, and
 * `DELETE /:id/photo`'s) and which nothing else may claim without saying so.
 */
export function namesDeletedCharacter(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2025";
}

/** What the upload stored, for the response the route builds from it. */
export type StoredCharacterPhoto = {
  /** The retained version's file name, which is now the character's `photoPath`. */
  fileName: string;
  /** Whether the look the reading carried became the character's `appearance`. */
  appearanceApplied: boolean;
};

/**
 * The upload's writes in the order the retained history needs them, settled
 * against a character that may no longer be there.
 *
 * The order is not negotiable — the version row and its bytes first
 * (`recordCharacterImage` argues why the row leads the file), then the pointer
 * that names it, then the two conditional writes the reading earns. The
 * settlement is what was missing. All of this used to be issued bare, so a
 * delete landing in that window came back as an unhandled `P2003` or `P2025` —
 * a 500 from a route that declares no such status, for a gesture the reader
 * made deliberately, with the optimized JPEG left on a volume nothing sweeps.
 *
 * Each shape is answered where it can still be answered cheaply. The insert is
 * answered by returning, because it is the first write and nothing has reached
 * disk — a file a failing `writeFile` truncated into existence is unlinked by
 * `recordCharacterImage` itself. The pointer write is answered by unlinking,
 * because by then the bytes are on disk and the row that named them went with
 * the character: `DELETE /characters/:id` collects its file list *before* it
 * deletes, so a version recorded after that read is a file no route, no prune
 * and no sweep can ever reach again.
 *
 * The two conditional writes cannot raise it. An `updateMany` matching nothing
 * is a count of zero, which is already how they answer a look the reader typed
 * and a portrait they started — a character that went away is one more row
 * their `where` does not match.
 */
export async function storeCharacterPhotoUpload(options: {
  imageStorageDir: string;
  userId: string;
  characterId: string;
  optimized: OptimizedImage;
  reading: CharacterPhotoReading | null;
}): Promise<StoredCharacterPhoto | "character-gone"> {
  const { imageStorageDir, userId, characterId, optimized, reading } = options;
  let recorded: RecordedCharacterImage;
  try {
    recorded = await recordCharacterImage({
      imageStorageDir,
      userId,
      characterId,
      source: "UPLOAD",
      kind: "photo",
      optimized,
      photoKind: reading?.photoKind,
      // Frozen at ingest and never re-derived. Promote reads only this.
      referenceEligible: reading?.canAdoptAsReference ?? false
    });
  } catch (error) {
    // The insert's shape only. A `P2025` out of this call is a record *this*
    // statement required and did not find, which is not the character unless
    // the statement said so — see the note above the two predicates.
    if (!namesOrphanedCharacterImage(error)) {
      throw error;
    }
    return "character-gone";
  }

  try {
    // The photo columns describe the upload itself and are always true of it,
    // so they are written unconditionally. A re-upload replaces the verdict and
    // the suggestion wholesale; stale ones would describe an image that is no
    // longer there. The superseded photo is not deleted — it is a retained
    // version now, one promote away.
    await prisma.libraryCharacter.update({
      where: { id: characterId },
      data: {
        photoPath: recorded.fileName,
        photoKind: reading?.photoKind ?? null,
        suggestedDescription: reading?.suggestedDescription ?? null
      }
    });
  } catch (error) {
    if (!namesDeletedCharacter(error)) {
      throw error;
    }
    // The row is already gone — it cascaded with the character — so the file is
    // the only half left to take, and taking it is the whole point of catching
    // this rather than letting it fall through as a 500.
    await deleteLibraryCharacterFile(imageStorageDir, userId, recorded.fileName);
    return "character-gone";
  }

  const appearanceApplied = await fillAppearanceFromPhoto(characterId, reading);

  if (adoptsAsReference(reading)) {
    // Adoption points *both* columns at the one uploaded file. The second copy
    // existed so the two columns could be deleted independently;
    // `DELETE /:id/photo` no longer unlinks anything, so a shared file is safe
    // — and a duplicate would show up as a duplicate tile in the strip.
    await prisma.libraryCharacter.updateMany({
      where: { id: characterId, ...REFERENCE_CLAIMABLE },
      data: {
        portraitPath: recorded.fileName,
        portraitSource: "ADOPTED_UPLOAD" as const,
        portraitStatus: "READY" as const,
        portraitError: null
      }
    });
    // No rollback and no rm: the bytes were on disk before the claim, so a won
    // claim can never name a missing file, and a superseded reference is a
    // version the reader can put back.
  }

  return { fileName: recorded.fileName, appearanceApplied };
}
