import type {
  LibraryCharacterImageModel,
  LibraryCharacterModel,
  LibraryCharacterPhotoKind,
  LibraryCharacterPortraitSource,
  LibraryCharacterPortraitStatus
} from "@book-maker/db";
import type {
  MobileLibraryCharacterDto,
  MobileLibraryCharacterImageDto,
  MobileLibraryCharacterPhotoKind,
  MobileLibraryCharacterPortraitSource,
  MobileLibraryCharacterPortraitStatus
} from "./dto.js";

/**
 * An appearance a photo upload read but did not apply, offered on that
 * upload's own response.
 *
 * It is a parameter rather than a column because there is nowhere to keep it
 * and nowhere it needs to be kept: the offer is only ever made when the
 * character already has an appearance the user owns, it is answerable there and
 * then with the picture still on screen, and re-reading it is one re-upload
 * away. Every other read of a character serializes it as null.
 */
export type OfferedCharacterReading = { suggestedAppearance?: string | undefined };

/**
 * The app-facing shape of a library character. Disk paths and provider details
 * stay out; the photo/portrait travel as authenticated fetch paths under this
 * route group, mirroring how project assets are served.
 */
export function libraryCharacterPortraitUrl(
  character: Pick<LibraryCharacterModel, "id" | "portraitPath" | "portraitStatus">
): string | null {
  // The one condition that decides whether this character reaches a book —
  // `libraryCharacterSnapshotsForBuild` writes `portraitFile` on exactly this.
  // Exported because the cast sheet now serves the same portrait behind the
  // same condition (`voiceCast.ts`), and a second copy of this expression is
  // exactly the drift this comment has always warned about.
  return character.portraitPath !== null && character.portraitStatus === "READY"
    ? `/api/mobile/characters/${encodeURIComponent(character.id)}/portrait`
    : null;
}

export function serializeLibraryCharacter(
  character: LibraryCharacterModel,
  offered: OfferedCharacterReading = {}
): MobileLibraryCharacterDto {
  const id = encodeURIComponent(character.id);
  const portraitUrl = libraryCharacterPortraitUrl(character);
  const hasReference = portraitUrl !== null;
  return {
    id: character.id,
    name: character.name,
    description: character.description,
    fields: fieldsFromJson(character.fields),
    portraitStatus: PORTRAIT_STATUS[character.portraitStatus],
    portraitError: character.portraitStatus === "FAILED" ? character.portraitError : null,
    portraitSource: character.portraitSource ? PORTRAIT_SOURCE[character.portraitSource] : null,
    hasPhoto: character.photoPath !== null,
    photoKind: character.photoKind ? PHOTO_KIND[character.photoKind] : null,
    suggestedDescription: character.suggestedDescription,
    appearance: character.appearance,
    suggestedAppearance: offered.suggestedAppearance ?? null,
    usedInBooks: hasReference,
    photoUrl: character.photoPath ? `/api/mobile/characters/${id}/photo` : null,
    portraitUrl,
    createdAt: character.createdAt.toISOString(),
    updatedAt: character.updatedAt.toISOString()
  };
}

/**
 * One retained version of a character's picture.
 *
 * The two capability flags are the only client-actionable form of the stored
 * `referenceEligible` verdict, which deliberately never reaches the wire — a
 * client that could see the raw flag would be invited to re-derive the rule,
 * and the rule is the one thing standing between a photograph of a real person
 * and "reproduce this face exactly" in every page render.
 */
export function serializeLibraryCharacterImage(
  character: Pick<LibraryCharacterModel, "id" | "photoPath" | "portraitPath" | "portraitStatus">,
  image: LibraryCharacterImageModel
): MobileLibraryCharacterImageDto {
  const characterId = encodeURIComponent(character.id);
  const hasReference = character.portraitPath !== null && character.portraitStatus === "READY";
  const isCurrentReference = hasReference && character.portraitPath === image.fileName;
  const isCurrentPhoto = character.photoPath === image.fileName;
  const isUpload = image.source === "UPLOAD";
  // Main is the reference when there is one, else the photo — the same
  // precedence `displayImageUrl` uses on the client.
  const isMain = hasReference ? isCurrentReference : isCurrentPhoto;
  return {
    id: image.id,
    url: `/api/mobile/characters/${characterId}/images/${encodeURIComponent(image.id)}`,
    source: isUpload ? "upload" : "generated",
    photoKind: image.photoKind ? PHOTO_KIND[image.photoKind] : null,
    isMain,
    isCurrentPhoto,
    isCurrentReference,
    // Moves what books draw from. Only this flag may carry copy that mentions
    // books.
    canBeMain: !isMain && image.referenceEligible,
    // Moves the photo alone, and only while no reference exists — otherwise it
    // would be an action that changes nothing the reader can see, since the
    // reference outranks the photo everywhere.
    canBeShownAsPhoto: !isMain && !isCurrentPhoto && isUpload && !image.referenceEligible && !hasReference,
    width: image.width,
    height: image.height,
    createdAt: image.createdAt.toISOString()
  };
}

const PORTRAIT_STATUS: Record<LibraryCharacterPortraitStatus, MobileLibraryCharacterPortraitStatus> = {
  NONE: "none",
  QUEUED: "queued",
  GENERATING: "generating",
  READY: "ready",
  FAILED: "failed"
};

const PORTRAIT_SOURCE: Record<LibraryCharacterPortraitSource, MobileLibraryCharacterPortraitSource> = {
  GENERATED: "generated",
  ADOPTED_UPLOAD: "adopted_upload"
};

const PHOTO_KIND: Record<LibraryCharacterPhotoKind, MobileLibraryCharacterPhotoKind> = {
  PHOTOGRAPH: "photograph",
  ILLUSTRATION: "illustration",
  UNKNOWN: "unknown"
};

export function fieldsFromJson(value: unknown): Array<{ key: string; value: string }> {
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
