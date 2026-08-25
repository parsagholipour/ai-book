import { creditCostForOperation, CREATION_ATTACHMENT_MAX_BYTES } from "@book-maker/core";
import { prisma, type LibraryCharacterModel } from "@book-maker/db";
import { startGenerationAttempt } from "@book-maker/db/billing";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { contentRestrictedError, enforceContentRestrictions } from "../../contentRestrictions.js";
import { dispatchGenerationJob, enqueueGenerationJob } from "../../queue.js";
import { characterContentText } from "../characterContentScreen.js";
import { readCharacterPhoto } from "../characterPhotoVision.js";
import { namesDeletedCharacter, storeCharacterPhotoUpload } from "../characterPhotoWrites.js";
import {
  characterImageParamsSchema,
  characterPhotoQuerySchema,
  mobileCharacterPortraitBodySchema,
  mobileCharacterPortraitOpenApiBody
} from "../characterSchemas.js";
import {
  characterImageExists,
  loadCharacterImages,
  ownedCharacter,
  ownedCharacterImage,
  portraitClaimIsLive,
  PORTRAIT_OPEN_STATUSES,
  pruneCharacterImages
} from "../characterImageStore.js";
import {
  fieldsFromJson,
  serializeLibraryCharacter,
  serializeLibraryCharacterImage
} from "../characterSerializer.js";
import {
  characterFileContentType,
  deleteLibraryCharacterFile,
  optimizeCharacterPhoto,
  readLibraryCharacterFile,
  resolveCharacterPhotoMimeType
} from "../characterStorage.js";
import { sendCharacterImageChanged, sendPortraitInProgress } from "../characterWriteConflicts.js";
import type {
  MobileLibraryCharacterDto,
  MobileLibraryCharacterImageDto,
  MobileLibraryCharacterImageListDto,
  MobileLibraryCharacterWithImagesDto
} from "../dto.js";
import {
  hitAuthenticatedLimit,
  hitTieredLimit,
  insufficientCreditsError,
  requireMobileAuth,
  sendGenerationAttemptError,
  sendMobileError,
  sendUnreadableBodyError
} from "../httpErrors.js";
import { ownedCharacterWithMentions } from "../libraryMentionGraph.js";
import type { MobileRouteContext } from "../routeContext.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import { fingerprintGenerationRequest } from "../support.js";

/**
 * Every route that moves a character's pictures: the upload that brings one in,
 * the priced job that draws one, the bytes both pointers serve, and the
 * retained history behind them — listing it, promoting a version back to being
 * the character's main image, and deleting one.
 *
 * The seam with `routes/characters.ts` is the two pointer columns. `photoPath`
 * and `portraitPath` are what every route here reads, claims and writes, and
 * they are claimed the same way in all of them — a compare-and-set on the
 * values the handler decided from, with the same escape hatch for a portrait
 * claim that outlived its job (`writeCharacterPointers` inside the group, and
 * `REFERENCE_CLAIMABLE` in `characterPhotoWrites.ts`). Nothing here touches a
 * description, a mention link or a sibling row; nothing there touches a picture
 * beyond deleting the files a deleted character leaves. Both groups register on
 * the same Fastify instance, so they share the one encapsulation context —
 * which is also what gives the upload below its `application/octet-stream`
 * parser.
 *
 * What the upload *writes* is one seam further out, in `characterPhotoWrites.ts`:
 * four statements driven by one vision reading, all of them landing seconds
 * after the row was read, settled together against a character the reader may
 * have deleted in between. The route keeps the rationing, the refusals and the
 * read that answers.
 *
 * `POST /:id/portrait` is the one priced route in the group and the reason the
 * old "everything here is free" line had to go: promoting a drawing the reader
 * already paid for is not a second purchase, but drawing a new one is a
 * purchase, and it closes the reserve/commit/refund loop through
 * `startGenerationAttempt`.
 */

/** Thrown inside the attempt transaction when another start already owns the portrait. */
class PortraitInProgressError extends Error {
  constructor() {
    super("A portrait for this character is already being drawn.");
    this.name = "PortraitInProgressError";
  }
}

export async function registerMobileCharacterImageRoutes(
  fastify: FastifyInstance,
  context: MobileRouteContext
): Promise<void> {
  const { appConfig } = context;

  /**
   * The retained strip, serialized against the row it was read beside.
   *
   * The two are always read as a pair: `isMain`, `canBeMain` and
   * `canBeShownAsPhoto` are all statements about an image *relative to* the
   * character's current pointers, so serializing a picture against a row the
   * caller read a moment earlier would let the strip mark the wrong tile.
   *
   * Those four columns are the whole of what it asks for, which is what lets
   * `GET /:id/images` — the request the picture grid makes — answer from the
   * row alone. That route used to build the pair and return only this half,
   * so the mention join and its nested `targetCharacter` select were paid for
   * on every grid load and thrown away with the serialized character.
   */
  const characterImageStrip = async (
    character: Pick<LibraryCharacterModel, "id" | "photoPath" | "portraitPath" | "portraitStatus">,
    userId: string
  ): Promise<MobileLibraryCharacterImageDto[]> => {
    const images = await loadCharacterImages(character.id, userId);
    return images.map((image) => serializeLibraryCharacterImage(character, image));
  };

  /** The character *and* its strip, for the two routes that answer with both. */
  const characterWithImages = async (
    characterId: string,
    userId: string
  ): Promise<MobileLibraryCharacterWithImagesDto | null> => {
    // The mention-loading read, because this helper serializes a character:
    // every other read in this file claims or compares pointers, feeds a
    // prompt, or answers with the strip, and none of those reaches the wire.
    const character = await ownedCharacterWithMentions(characterId, userId);
    if (!character) {
      return null;
    }
    return {
      character: serializeLibraryCharacter(character),
      images: await characterImageStrip(character, userId)
    };
  };

  /**
   * The guarded pointer write shared by promote and delete, with the same
   * escape hatch `DELETE /:id` has always carried.
   *
   * A portrait job owns the row's status while it draws, and moving a pointer
   * under it would let the next start charge a second time — so the write is a
   * compare-and-set. But a claim can outlive its job: a worker killed hard
   * never runs its failure path, and nothing else resets an account-level row.
   * Refusing on the guard alone would wedge both routes forever, leaving
   * "delete the whole character" — and its whole history — as the only way out.
   */
  const writeCharacterPointers = async (
    character: { id: string; photoPath: string | null; portraitPath: string | null },
    userId: string,
    data: Record<string, unknown>
  ): Promise<"written" | "in-progress" | "gone" | "moved"> => {
    // The pointers the caller decided from are part of the claim, not just the
    // status. Both routes read the row, then think — `characterImageExists`
    // stats the disk, the delete route hunts a successor — and a promote or an
    // upload landing in that window would otherwise be silently overwritten by
    // a decision made about a row that no longer exists.
    const expected = { photoPath: character.photoPath, portraitPath: character.portraitPath };
    const claimed = await prisma.libraryCharacter.updateMany({
      where: { id: character.id, userId, ...expected, portraitStatus: { notIn: [...PORTRAIT_OPEN_STATUSES] } },
      data
    });
    if (claimed.count === 1) {
      return "written";
    }
    const current = await ownedCharacter(character.id, userId);
    if (!current) {
      return "gone";
    }
    if (await portraitClaimIsLive(current)) {
      return "in-progress";
    }
    if (current.photoPath !== expected.photoPath || current.portraitPath !== expected.portraitPath) {
      return "moved";
    }
    // The claim was lost to a status a dead job left behind, and nothing else
    // resets an account-level row — so re-issue without that guard rather than
    // wedging both routes forever.
    const forced = await prisma.libraryCharacter.updateMany({
      where: { id: character.id, userId, ...expected },
      data
    });
    return forced.count === 1 ? "written" : "moved";
  };

  /**
   * The picture that takes over when the current reference is deleted: newest
   * first, skipping any whose bytes are no longer on disk.
   */
  const newestUsableReference = async (characterId: string, userId: string, excludedImageId: string) => {
    const candidates = await prisma.libraryCharacterImage.findMany({
      where: { characterId, userId, referenceEligible: true, id: { not: excludedImageId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
    for (const candidate of candidates) {
      if (await characterImageExists(appConfig.IMAGE_STORAGE_DIR, userId, candidate.fileName)) {
        return candidate;
      }
    }
    return null;
  };

  fastify.get(
    "/api/mobile/characters/:id/images",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const character = await ownedCharacter(id, auth.user.id);
      if (!character) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      const images = await characterImageStrip(character, auth.user.id);
      return { images } satisfies MobileLibraryCharacterImageListDto;
    }
  );

  fastify.get(
    "/api/mobile/characters/:id/images/:imageId",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const params = characterImageParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendMobileError(reply, 404, "CHARACTER_IMAGE_NOT_FOUND", "That picture is no longer there.");
      }
      const image = await ownedCharacterImage(params.data.id, params.data.imageId, auth.user.id);
      if (!image) {
        return sendMobileError(reply, 404, "CHARACTER_IMAGE_NOT_FOUND", "That picture is no longer there.");
      }
      // The user segment comes from the bearer token, never from `image.userId`
      // — the stored column is a third ownership predicate on the lookup above,
      // not a source of truth about where the bytes live.
      const bytes = await readLibraryCharacterFile(appConfig.IMAGE_STORAGE_DIR, auth.user.id, image.fileName);
      if (!bytes) {
        return sendMobileError(reply, 404, "CHARACTER_IMAGE_NOT_FOUND", "That picture is no longer there.");
      }
      // One id is one set of bytes for good, so this may be held forever —
      // `private` is not optional, though: without it a shared proxy would
      // cache one reader's child's face.
      reply.header("Cache-Control", "private, max-age=31536000, immutable");
      reply.header("Content-Type", characterFileContentType(image.fileName));
      return reply.send(bytes);
    }
  );

  fastify.post(
    "/api/mobile/characters/:id/images/:imageId/promote",
    {
      schema: {
        tags: ["mobile"],
        response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError, 422: mobileAuthError, 429: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(context.draftLimiter, request, reply, auth.user.id, "character-write")) {
        return;
      }
      const params = characterImageParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      const character = await ownedCharacter(params.data.id, auth.user.id);
      if (!character) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      const image = await ownedCharacterImage(character.id, params.data.imageId, auth.user.id);
      if (!image) {
        return sendMobileError(reply, 404, "CHARACTER_IMAGE_NOT_FOUND", "That picture is no longer there.");
      }

      const hasReference = character.portraitPath !== null && character.portraitStatus === "READY";
      // `referenceEligible` is the frozen ingest verdict and the *only* thing
      // consulted here. Re-deriving it from `photoKind` would be a one-tap
      // route from a photograph of a real person to an adopted reference, which
      // tells the renderer to reproduce that face exactly.
      const movesReference = image.referenceEligible;
      // A photograph may become the stored photo, but only while nothing is
      // being drawn from anything — with a reference in place the change would
      // be invisible, since the reference outranks the photo everywhere.
      const movesPhoto = image.source === "UPLOAD" && (movesReference || !hasReference);
      if (!movesReference && !movesPhoto) {
        return sendMobileError(
          reply,
          422,
          "CHARACTER_IMAGE_NOT_PROMOTABLE",
          "Books can't draw from a photo. Make an illustrated version of it first."
        );
      }
      if (!(await characterImageExists(appConfig.IMAGE_STORAGE_DIR, auth.user.id, image.fileName))) {
        return sendMobileError(reply, 404, "CHARACTER_IMAGE_NOT_FOUND", "That picture is no longer there.");
      }

      // The four reference columns move together — `portraitPath` alone would
      // leave `usedInBooks` false while every surface drew the new face.
      const written = await writeCharacterPointers(character, auth.user.id, {
        ...(movesPhoto
          ? { photoPath: image.fileName, photoKind: image.photoKind, suggestedDescription: null }
          : {}),
        ...(movesReference
          ? {
              portraitPath: image.fileName,
              // Copied from the row, never guessed: it picks the seeding
              // prompt and rides the build snapshot.
              portraitSource:
                image.source === "GENERATED" ? ("GENERATED" as const) : ("ADOPTED_UPLOAD" as const),
              portraitStatus: "READY" as const,
              portraitError: null
            }
          : {})
      });
      if (written === "in-progress") {
        return sendPortraitInProgress(reply);
      }
      if (written === "gone") {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      if (written === "moved") {
        // Someone else moved a pointer while this promote was deciding. The
        // app re-renders from the response it gets, so answering with the row
        // as it stands is the whole recovery — a second tap is one gesture.
        return sendCharacterImageChanged(reply);
      }

      const payload = await characterWithImages(character.id, auth.user.id);
      if (!payload) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      return payload;
    }
  );

  fastify.delete(
    "/api/mobile/characters/:id/images/:imageId",
    {
      schema: {
        tags: ["mobile"],
        response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError, 429: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(context.draftLimiter, request, reply, auth.user.id, "character-write")) {
        return;
      }
      const params = characterImageParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      const character = await ownedCharacter(params.data.id, auth.user.id);
      if (!character) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      const image = await ownedCharacterImage(character.id, params.data.imageId, auth.user.id);
      if (!image) {
        return sendMobileError(reply, 404, "CHARACTER_IMAGE_NOT_FOUND", "That picture is no longer there.");
      }

      const holdsPhoto = character.photoPath === image.fileName;
      const holdsReference = character.portraitPath === image.fileName;
      if (holdsPhoto || holdsReference) {
        // Clearing the pointer and authorising the unlink are one statement,
        // guarded exactly the way promote is. Deleting an older picture that
        // holds neither pointer is not guarded at all — a minute-long redraw
        // must not block housekeeping.
        // Newest eligible picture whose bytes are actually there. The stat is
        // the same one promote makes, and for the same reason: a READY row
        // naming a file that is gone tells every surface — and every book
        // build, permanently, via the plan snapshot — that this character
        // reaches a book.
        const successor = holdsReference
          ? await newestUsableReference(character.id, auth.user.id, image.id)
          : null;
        const cleared = await writeCharacterPointers(character, auth.user.id, {
          ...(holdsPhoto ? { photoPath: null, photoKind: null, suggestedDescription: null } : {}),
          ...(holdsReference
            ? successor
              ? {
                  // Deleting the main picture puts the previous illustration
                  // back rather than leaving the character with none. This is
                  // what a retained history is *for*, and it is what the
                  // confirmation copy promises.
                  portraitPath: successor.fileName,
                  portraitSource:
                    successor.source === "GENERATED"
                      ? ("GENERATED" as const)
                      : ("ADOPTED_UPLOAD" as const),
                  portraitStatus: "READY" as const,
                  portraitError: null
                }
              : {
                  portraitPath: null,
                  portraitSource: null,
                  portraitStatus: "NONE" as const,
                  portraitError: null
                }
            : {})
        });
        if (cleared === "in-progress") {
          return sendPortraitInProgress(reply);
        }
        if (cleared === "gone") {
          return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
        }
        if (cleared === "moved") {
          // The file is deliberately still on disk: this delete decided which
          // pointer to clear from a row that has since moved, so unlinking now
          // could take the picture a concurrent promote just installed.
          return sendCharacterImageChanged(reply);
        }
      }

      // File first, row second: a row with no file draws a broken tile the
      // reader can delete, while a file with no row is unreachable forever.
      await deleteLibraryCharacterFile(appConfig.IMAGE_STORAGE_DIR, auth.user.id, image.fileName);
      await prisma.libraryCharacterImage.deleteMany({ where: { id: image.id, userId: auth.user.id } });

      const payload = await characterWithImages(character.id, auth.user.id);
      if (!payload) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      return payload;
    }
  );

  fastify.put(
    "/api/mobile/characters/:id/photo",
    {
      bodyLimit: CREATION_ATTACHMENT_MAX_BYTES + 64 * 1024,
      // This upload documents no body — the bytes arrive raw — but it accepts
      // whatever content-type the client sends, so `application/json` with
      // something unreadable is parsed and refused before the handler runs, in
      // a shape the 400 named below cannot serialize. See
      // `sendUnreadableBodyError`.
      errorHandler: sendUnreadableBodyError,
      schema: { tags: ["mobile"], response: { 400: mobileAuthError, 401: mobileAuthError, 404: mobileAuthError, 422: mobileAuthError, 429: mobileAuthError } }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(context.attachmentLimiter, request, reply, auth.user.id, "character-photo-upload")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const query = characterPhotoQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the photo with a filename.");
      }
      const data = request.body;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the photo as the request body.");
      }
      const mimeType = resolveCharacterPhotoMimeType(query.data.mimeType, query.data.filename);
      if (!mimeType) {
        return sendMobileError(reply, 422, "PHOTO_UNSUPPORTED", "Use a JPEG, PNG, or WebP photo.");
      }
      // A name for the vision prompt and an id for the writes below, and that
      // is the whole of it — this read serializes nothing, and it sits in
      // front of a call that can take `CHARACTER_PHOTO_VISION_BUDGET_MS`, so
      // the mention join would be a `LibraryMention` scan the upload path
      // waits on and then discards. The serializing read is the one after the
      // writes, which is also the only copy that describes them.
      const character = await ownedCharacter(id, auth.user.id);
      if (!character) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      let optimized;
      try {
        optimized = await optimizeCharacterPhoto(data, mimeType);
      } catch {
        return sendMobileError(reply, 422, "PHOTO_UNREADABLE", "That photo could not be read. Try a different one.");
      }
      // Read before anything is written, so the retained row carries its
      // verdict from birth. The optimized buffer, never the raw body: it is a
      // few hundred KB rather than up to the body limit, and EXIF/GPS are
      // already gone. A failed or absent reading still answers 200 — storing
      // the photo regardless is the contract, and reordering does not change it.
      const reading = await readCharacterPhoto({
        vision: context.characterPhotoVision,
        bytes: optimized.bytes,
        mimeType: optimized.mimeType,
        characterName: character.name,
        budgetMs: context.options.characterPhotoVisionBudgetMs
      });

      // Everything this upload writes, and the delete that can land in the
      // middle of it. A reader who uploads a photo and then deletes the
      // character on their other device used to get a 500 out of whichever
      // statement met the row first — a status this route does not declare —
      // with the optimized bytes left on a volume nothing sweeps. The 404 the
      // schema already carries is the truth, and it is the same one the read
      // below gives for the same event a moment later.
      const stored = await storeCharacterPhotoUpload({
        imageStorageDir: appConfig.IMAGE_STORAGE_DIR,
        userId: auth.user.id,
        characterId: character.id,
        optimized,
        reading
      });
      if (stored === "character-gone") {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }

      await pruneCharacterImages(appConfig.IMAGE_STORAGE_DIR, auth.user.id, character.id);
      // Read again, with the graph, because everything above wrote: the photo
      // columns, the appearance fill and the reference claim are all invisible
      // to the copy this handler started with. That copy used to stand in when
      // this read came back empty, which is a row the reader deleted mid-upload
      // answered as `hasPhoto: false` for the picture just stored — a character
      // that no longer exists, described as it was before the upload. A 404 is
      // the truth and the schema already carries it.
      const current = await ownedCharacterWithMentions(id, auth.user.id);
      if (!current) {
        // The same unlink the write settlement makes, for the same reason: the
        // version row cascaded away with the character, and `DELETE
        // /characters/:id` reads the file names it is going to remove *before*
        // it removes the row — so a picture recorded after that read is bytes
        // nothing can name. "Its own delete has already taken its files" was
        // true only of the files that existed when it looked.
        await deleteLibraryCharacterFile(appConfig.IMAGE_STORAGE_DIR, auth.user.id, stored.fileName);
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      return {
        character: serializeLibraryCharacter(
          current,
          // Applied, it is the appearance and there is nothing to offer.
          // Refused, the character already has a look the user owns and this
          // is the alternative the new picture shows.
          stored.appearanceApplied || !reading?.suggestedAppearance
            ? {}
            : { suggestedAppearance: reading.suggestedAppearance }
        ) satisfies MobileLibraryCharacterDto,
        images: await characterImageStrip(current, auth.user.id)
      };
    }
  );

  fastify.delete(
    "/api/mobile/characters/:id/photo",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const character = await ownedCharacterWithMentions(id, auth.user.id);
      if (!character) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      // Now a pointer clear and nothing else. It used to unlink the file and
      // drop an adopted reference with it, on the grounds that the reader had
      // swapped the picture out — which stopped being true the moment the
      // picture was retained. The app calls the per-image delete instead; this
      // stays for clients already in the wild.
      //
      // The window between the read and the write is short and it is not zero:
      // the same reader tapping Delete character on their other device makes
      // this `update` a `P2025`, and the answer to a character that is not
      // there is the 404 one line up, not a stack trace this route declares no
      // status for. `namesDeletedCharacter` is the whole test — anything else
      // is a genuine failure and still throws.
      const updated = await prisma.libraryCharacter
        .update({
          where: { id: character.id },
          data: { photoPath: null, photoKind: null, suggestedDescription: null }
        })
        .catch((error: unknown) => {
          if (!namesDeletedCharacter(error)) {
            throw error;
          }
          return null;
        });
      if (!updated) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      return {
        character: serializeLibraryCharacter({
          ...updated,
          outgoingMentions: character.outgoingMentions
        }) satisfies MobileLibraryCharacterDto
      };
    }
  );

  for (const kind of ["photo", "portrait"] as const) {
    fastify.get(
      `/api/mobile/characters/:id/${kind}`,
      { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
      async (request, reply) => {
        const auth = await requireMobileAuth(request, reply);
        if (!auth) {
          return;
        }
        const { id } = idParamsSchema.parse(request.params);
        const character = await ownedCharacter(id, auth.user.id);
        const fileName = kind === "photo" ? character?.photoPath : character?.portraitPath;
        if (!character || !fileName) {
          return sendMobileError(reply, 404, "CHARACTER_FILE_NOT_FOUND", `This character has no ${kind}.`);
        }
        const bytes = await readLibraryCharacterFile(appConfig.IMAGE_STORAGE_DIR, auth.user.id, fileName);
        if (!bytes) {
          return sendMobileError(reply, 404, "CHARACTER_FILE_NOT_FOUND", `This character has no ${kind}.`);
        }
        reply.header("Cache-Control", "private, max-age=300");
        reply.header("Content-Type", characterFileContentType(fileName));
        return reply.send(bytes);
      }
    );
  }

  fastify.post(
    "/api/mobile/characters/:id/portrait",
    {
      // The parse below is this body's only gate, as on every other mobile
      // route that documents one — ajv rejecting first answers in Fastify's
      // shape, which the 400 named under it cannot serialize at all. The
      // `errorHandler` is the same 400 arriving from one step earlier: a body
      // the JSON parser cannot read reaches no handler to attach anything to,
      // so `attachValidation` never sees it. See `sendUnreadableBodyError`.
      attachValidation: true,
      errorHandler: sendUnreadableBodyError,
      schema: {
        tags: ["mobile"],
        body: mobileCharacterPortraitOpenApiBody,
        response: {
          202: {},
          400: mobileAuthError,
          401: mobileAuthError,
          402: insufficientCreditsError,
          404: mobileAuthError,
          409: mobileAuthError,
          422: contentRestrictedError,
          429: mobileAuthError
        }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!(await hitTieredLimit(context.generationLimiter, request, reply, auth.user.id, "character-portrait"))) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const body = mobileCharacterPortraitBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Invalid portrait request.");
      }
      // The prompt's own inputs — a name, prose, the recorded look, fields and
      // whether there is a photo to draw from — and the status this start has
      // to move. None of it is serialized here, so this read takes no graph
      // either; the 202 below is answered from a second read that has to happen
      // anyway, because the claim moves the very status the app is waiting on.
      const character = await ownedCharacter(id, auth.user.id);
      if (!character) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      if (PORTRAIT_OPEN_STATUSES.includes(character.portraitStatus as (typeof PORTRAIT_OPEN_STATUSES)[number])) {
        return sendPortraitInProgress(reply);
      }
      // The same rule the two character writes hold — the text a character
      // write screens is the text it stores — read from the other end: the text
      // this route screens is the text it is about to pay a provider to render.
      // `buildLibraryCharacterPortraitPrompt` emits `Appearance (match
      // exactly): …` verbatim, and `appearance` was the one field left out of
      // this string, so the one route in the group that reaches a provider on a
      // charged job assessed everything the prompt says except the sentence it
      // is told to draw exactly. Nothing upstream covers it: the write-time
      // screens ran against whatever the operator flag said *then*, and
      // `fillAppearanceFromPhoto` writes a look off a photo onto a character
      // that has none — screened at upload, under that upload's flag, and never
      // again.
      const contentText = characterContentText({
        name: character.name,
        description: character.description,
        appearance: character.appearance,
        fields: fieldsFromJson(character.fields)
      });
      if (!(await enforceContentRestrictions(reply, contentText))) {
        return;
      }

      const cost = creditCostForOperation("CHARACTER_PORTRAIT_GENERATION");
      const hasPhoto = character.photoPath !== null;
      // Every input the prompt renders, because that is what a replayed
      // `requestId` is being asserted to be the same request as. `appearance`
      // belongs in it for the same reason it belongs in the screen above:
      // `buildLibraryCharacterPortraitPrompt` prints it verbatim, so a start
      // that would render a different look is a different request and must not
      // be answered by replaying the old one.
      const requestFingerprint = fingerprintGenerationRequest({
        characterId: id,
        name: character.name,
        description: character.description,
        appearance: character.appearance,
        fields: character.fields,
        hasPhoto
      });
      // And it is part of the command's *identity* rather than a test the
      // identity is refused on, which is the difference between a redraw and a
      // dead button. `startGenerationAttempt` replays a known `commandKey` and
      // throws `GenerationAttemptConflictError` the moment the stored
      // fingerprint or quote differs — a 409 the app cannot act on, because
      // `character_profile_screen.dart` clears `_portraitRequestId` only after
      // a start it *saw* succeed. So a tap whose 202 never arrived leaves the
      // id retained, and anything that moved a prompt input afterwards wedged
      // Redraw for the life of the screen. The reader need not have touched
      // anything for that to happen: `fillAppearanceFromPhoto` writes a look
      // off an uploaded photo, moving `appearance` and `hasPhoto` together on a
      // character that had neither, and every attempt stored before
      // `appearance` joined this fingerprint carries one computed without it.
      // Folded into the key, a moved input is a new command instead: the same
      // request still replays and still charges once, and a changed one starts
      // the drawing the reader is asking for. It cannot pay twice for one
      // drawing — a start whose job is still in flight is refused by the
      // portrait-status guard above, and one that settled was either delivered
      // or refunded. The quote rides along for the same reason: prices are
      // operator-editable and re-read every 15s, and it is the other value
      // `assertMatchingCommand` refuses on.
      const requestId = body.data.requestId ?? randomUUID();
      let started;
      try {
        started = await startGenerationAttempt({
          userId: auth.user.id,
          commandKey: `mobile:character-portrait:${id}:${requestId}:${requestFingerprint}:${cost}`,
          requestFingerprint,
          operation: "CHARACTER_PORTRAIT_GENERATION",
          quotedCredits: cost,
          description: "Character portrait",
          metadata: { libraryCharacterId: id, hasPhoto },
          create: async (tx, { attemptId, ledgerEntry }) => {
            // Race-safe twin of the 409 above: only one start may move the row
            // out of a settled portrait status.
            const claimed = await tx.libraryCharacter.updateMany({
              where: { id, portraitStatus: { notIn: [...PORTRAIT_OPEN_STATUSES] } },
              data: { portraitStatus: "QUEUED", portraitError: null }
            });
            if (claimed.count !== 1) {
              throw new PortraitInProgressError();
            }
            const job = await enqueueGenerationJob({
              projectId: null,
              type: "GENERATE_CHARACTER_PORTRAIT",
              dedupeKey: `character-portrait:${id}:${attemptId}`,
              transaction: tx,
              dispatch: false,
              attemptId,
              payload: {
                libraryCharacterId: id,
                userId: auth.user.id,
                ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {})
              }
            });
            await tx.libraryCharacter.update({ where: { id }, data: { portraitJobId: job.id } });
            return { projectId: null, primaryJobId: job.id };
          }
        });
      } catch (error) {
        if (error instanceof PortraitInProgressError) {
          return sendPortraitInProgress(reply);
        }
        if (sendGenerationAttemptError(reply, error)) {
          return;
        }
        throw error;
      }
      if (started.replayed && ["FAILED", "CANCELED"].includes(started.attempt.status)) {
        // A replayed requestId whose attempt already settled was refunded;
        // answering 202 with creditsCharged would assert a charge that was
        // handed back and imply work is coming when nothing is.
        return sendMobileError(
          reply,
          409,
          "PORTRAIT_ATTEMPT_SETTLED",
          "That portrait attempt failed and was refunded. Start a new one."
        );
      }
      if (!started.attempt.primaryJobId) {
        throw new Error("Character portrait attempt has no primary job.");
      }
      await dispatchGenerationJob(started.attempt.primaryJobId);

      const current = await ownedCharacterWithMentions(id, auth.user.id);
      if (!current) {
        // Only reachable by a delete that beat the claim — and one that did
        // would have failed the claim, so this is the terminal case rather
        // than a live one. The pre-claim copy is not a stand-in for it: it
        // still carries the settled status this start just moved, so a 202
        // built from it would tell the app no portrait is being drawn. The
        // charge is not stranded either — the handler throws on a character
        // that is gone, and a failed attempt is refunded.
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      return reply.code(202).send({
        character: serializeLibraryCharacter(current) satisfies MobileLibraryCharacterDto,
        creditsCharged: started.attempt.quotedCredits
      });
    }
  );
}
