/**
 * Response shapes for the account-level character library ("consistent
 * characters") — everything under `/api/mobile/characters`.
 *
 * Split out of `dto.ts` rather than parked there: the library is its own
 * surface, with its own schemas (`characterSchemas.ts`), serializer
 * (`characterSerializer.ts`), storage (`characterStorage.ts`,
 * `characterImageStore.ts`) and routes, and it is the only DTO group in that
 * file with nothing else depending on it. `dto.ts` re-exports this module, so
 * every existing `from "./dto.js"` import keeps working — these names are part
 * of one contract whichever file they live in.
 */

export type MobileLibraryCharacterPortraitStatus = "none" | "queued" | "generating" | "ready" | "failed";

/** What the uploaded image turned out to be. Null on rows never read. */
export type MobileLibraryCharacterPhotoKind = "photograph" | "illustration" | "unknown";

/** Whether the reference image was drawn for a fee or is the user's own art. */
export type MobileLibraryCharacterPortraitSource = "generated" | "adopted_upload";

/** An account-level library character ("consistent characters"). */
export type MobileLibraryCharacterDto = {
  id: string;
  name: string;
  description: string;
  fields: Array<{ key: string; value: string }>;
  portraitStatus: MobileLibraryCharacterPortraitStatus;
  portraitError: string | null;
  portraitSource: MobileLibraryCharacterPortraitSource | null;
  hasPhoto: boolean;
  photoKind: MobileLibraryCharacterPhotoKind | null;
  /**
   * A description read off the photo, offered to the user. Never applied on
   * their behalf, and cleared as soon as they accept, edit, or dismiss it.
   */
  suggestedDescription: string | null;
  /**
   * What the character looks like, in words. Separate from `description`, which
   * is who they are and routinely says nothing about the look — the look
   * otherwise exists only in the portrait's pixels, which no text model in the
   * pipeline can see, so the planner invented one and the invented one won.
   */
  appearance: string | null;
  /**
   * An appearance read off the picture, offered the same way
   * `suggestedDescription` is: never applied on the user's behalf.
   */
  suggestedAppearance: string | null;
  /**
   * Whether this character's look actually reaches an illustrated book. It is
   * exactly the condition the build snapshot uses, so the app can never promise
   * more than the pipeline delivers — a stored photo alone does not count.
   */
  usedInBooks: boolean;
  /** Authenticated fetch paths under /api/mobile/characters/:id/…, or null. */
  photoUrl: string | null;
  portraitUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MobileLibraryCharacterListDto = {
  characters: MobileLibraryCharacterDto[];
  /** What one portrait generation costs right now, for the editor's badge. */
  portraitCredits: number;
};

/** Where the bytes of one retained picture came from. */
export type MobileLibraryCharacterImageSource = "upload" | "generated";

/**
 * One retained version of a character's picture — every upload and every
 * drawing, newest first on the wire.
 */
export type MobileLibraryCharacterImageDto = {
  id: string;
  /**
   * Authenticated fetch path. Immutable: one id is one set of bytes forever,
   * so it carries no cache-busting query and must never be given one.
   */
  url: string;
  source: MobileLibraryCharacterImageSource;
  photoKind: MobileLibraryCharacterPhotoKind | null;
  /** The picture every surface shows: the reference if there is one, else the photo. */
  isMain: boolean;
  isCurrentPhoto: boolean;
  isCurrentReference: boolean;
  /**
   * Whether making this the main picture would move the **book reference**.
   * The server's own adoption verdict, not a client rule — and the only flag a
   * surface may pair with copy that mentions books.
   */
  canBeMain: boolean;
  /**
   * Whether this upload can become the character's photo without touching what
   * books draw from. Only offered while there is no reference at all, since a
   * reference outranks the photo on every surface and the action would
   * otherwise change nothing the reader can see.
   */
  canBeShownAsPhoto: boolean;
  width: number | null;
  height: number | null;
  createdAt: string;
};

export type MobileLibraryCharacterImageListDto = {
  images: MobileLibraryCharacterImageDto[];
};

/** What every write that can move a pointer answers with: one call re-renders every surface. */
export type MobileLibraryCharacterWithImagesDto = {
  character: MobileLibraryCharacterDto;
  images: MobileLibraryCharacterImageDto[];
};
