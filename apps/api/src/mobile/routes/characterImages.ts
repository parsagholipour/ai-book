import { prisma } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import { characterImageParamsSchema } from "../characterSchemas.js";
import {
  characterImageExists,
  loadCharacterImages,
  ownedCharacter,
  ownedCharacterImage,
  portraitClaimIsLive,
  PORTRAIT_OPEN_STATUSES
} from "../characterImageStore.js";
import { serializeLibraryCharacter, serializeLibraryCharacterImage } from "../characterSerializer.js";
import {
  characterFileContentType,
  deleteLibraryCharacterFile,
  readLibraryCharacterFile
} from "../characterStorage.js";
import type {
  MobileLibraryCharacterImageListDto,
  MobileLibraryCharacterWithImagesDto
} from "../dto.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError } from "../httpErrors.js";
import type { MobileRouteContext } from "../routeContext.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";

/**
 * A character's retained picture history: listing it, serving one version's
 * bytes, promoting one back to being the character's main image, and deleting
 * one.
 *
 * Split from `routes/characters.ts` for the file-size budget, and registered on
 * the same Fastify instance so both groups share the one encapsulation context.
 * Every route here is free — nothing in this file reserves, commits or refunds
 * a credit — because promoting a drawing the reader already paid for is not a
 * second purchase.
 */

const PORTRAIT_IN_PROGRESS_MESSAGE =
  "This character's illustration is still being drawn. Try again when it finishes.";

export async function registerMobileCharacterImageRoutes(
  fastify: FastifyInstance,
  context: MobileRouteContext
): Promise<void> {
  const { appConfig } = context;

  /**
   * The character plus every retained picture, serialized together.
   *
   * The two are always read as a pair: `isMain`, `canBeMain` and
   * `canBeShownAsPhoto` are all statements about an image *relative to* the
   * character's current pointers, so serializing a picture against a row the
   * caller read a moment earlier would let the strip mark the wrong tile.
   */
  const characterWithImages = async (
    characterId: string,
    userId: string
  ): Promise<MobileLibraryCharacterWithImagesDto | null> => {
    const character = await ownedCharacter(characterId, userId);
    if (!character) {
      return null;
    }
    const images = await loadCharacterImages(character.id, userId);
    return {
      character: serializeLibraryCharacter(character),
      images: images.map((image) => serializeLibraryCharacterImage(character, image))
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
      const payload = await characterWithImages(id, auth.user.id);
      if (!payload) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      return { images: payload.images } satisfies MobileLibraryCharacterImageListDto;
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
        response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError, 422: mobileAuthError }
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
        return sendMobileError(reply, 409, "PORTRAIT_IN_PROGRESS", PORTRAIT_IN_PROGRESS_MESSAGE);
      }
      if (written === "gone") {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      if (written === "moved") {
        // Someone else moved a pointer while this promote was deciding. The
        // app re-renders from the response it gets, so answering with the row
        // as it stands is the whole recovery — a second tap is one gesture.
        return sendMobileError(
          reply,
          409,
          "CHARACTER_IMAGE_CHANGED",
          "This character's pictures just changed. Have another look and try again."
        );
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
        response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError }
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
          return sendMobileError(reply, 409, "PORTRAIT_IN_PROGRESS", PORTRAIT_IN_PROGRESS_MESSAGE);
        }
        if (cleared === "gone") {
          return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
        }
        if (cleared === "moved") {
          // The file is deliberately still on disk: this delete decided which
          // pointer to clear from a row that has since moved, so unlinking now
          // could take the picture a concurrent promote just installed.
          return sendMobileError(
            reply,
            409,
            "CHARACTER_IMAGE_CHANGED",
            "This character's pictures just changed. Have another look and try again."
          );
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
}
