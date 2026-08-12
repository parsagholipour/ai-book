import {
  canAdoptCharacterPhoto,
  type CharacterPhotoImageKind,
  type CharacterPhotoVisionAdapter,
  type CharacterPhotoVisionResult
} from "@book-maker/core";
import type { LibraryCharacterPhotoKind } from "@book-maker/db";
import { assessCurrentContentRestrictions } from "../contentRestrictions.js";
import { withTimeout } from "../withTimeout.js";
import { LIBRARY_CHARACTER_DESCRIPTION_MAX } from "./characterSchemas.js";

/**
 * The one model call a character-photo upload makes.
 *
 * It is inline rather than a job because its whole product is the upload's own
 * response — a description to offer and a verdict on whether the image can be
 * the character's reference as it stands. It is also entirely optional: every
 * failure mode here (no provider configured, a refusal, a hang, a reply that
 * trips the content preflight) returns null, and the upload stores the photo
 * and answers 200 exactly as it did before this existed.
 *
 * The budget is not optional. The Gemini client is built with no request
 * timeout and Fastify sets none, so without this a wedged call holds the
 * upload open until the app's own three-minute receive timeout.
 */
export const CHARACTER_PHOTO_VISION_BUDGET_MS = 12_000;

export type CharacterPhotoReading = {
  photoKind: LibraryCharacterPhotoKind;
  /** Absent when the model wrote nothing usable, or the text was screened out. */
  suggestedDescription?: string | undefined;
  /** True only for a confident, single-subject illustration. */
  canAdoptAsReference: boolean;
};

const PHOTO_KIND: Record<CharacterPhotoImageKind, LibraryCharacterPhotoKind> = {
  photograph: "PHOTOGRAPH",
  illustration: "ILLUSTRATION",
  unknown: "UNKNOWN"
};

export type ReadCharacterPhotoOptions = {
  vision: ((request: {
    data: Buffer;
    mimeType: string;
    characterName: string;
    language?: string | undefined;
  }) => Promise<CharacterPhotoVisionResult>) | undefined;
  bytes: Buffer;
  mimeType: string;
  characterName: string;
  language?: string | undefined;
  budgetMs?: number | undefined;
};

export async function readCharacterPhoto(
  options: ReadCharacterPhotoOptions
): Promise<CharacterPhotoReading | null> {
  if (!options.vision) {
    return null;
  }
  let result: CharacterPhotoVisionResult;
  try {
    result = await withTimeout(
      options.vision({
        data: options.bytes,
        mimeType: options.mimeType,
        characterName: options.characterName,
        ...(options.language ? { language: options.language } : {})
      }),
      options.budgetMs ?? CHARACTER_PHOTO_VISION_BUDGET_MS,
      "Character photo understanding"
    );
  } catch {
    return null;
  }

  return {
    photoKind: PHOTO_KIND[result.imageKind],
    canAdoptAsReference: canAdoptCharacterPhoto(result),
    ...(await screenedDescription(result.suggestedDescription))
  };
}

/**
 * A photo is user content and its visible text reaches a model, so what comes
 * back is treated like anything else a user typed: it goes through the same
 * preflight the create and update routes run. A suggestion that trips it is
 * dropped rather than failing the upload — the photo itself was fine, and the
 * user is not being told off for something a model wrote.
 */
async function screenedDescription(
  suggestion: string
): Promise<{ suggestedDescription?: string | undefined }> {
  const trimmed = suggestion.trim().slice(0, LIBRARY_CHARACTER_DESCRIPTION_MAX);
  if (!trimmed) {
    return {};
  }
  try {
    const assessment = await assessCurrentContentRestrictions(trimmed);
    return assessment.allowed ? { suggestedDescription: trimmed } : {};
  } catch {
    return {};
  }
}

/** Re-exported so the route's adapter wiring has one import for this concern. */
export type { CharacterPhotoVisionAdapter, CharacterPhotoVisionResult };
