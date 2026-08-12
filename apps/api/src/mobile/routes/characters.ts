import { creditCostForOperation, CREATION_ATTACHMENT_MAX_BYTES } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import {
  GenerationAttemptConflictError,
  InsufficientCreditsError,
  startGenerationAttempt
} from "@book-maker/db/billing";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { enforceContentRestrictions } from "../../contentRestrictions.js";
import { dispatchGenerationJob, enqueueGenerationJob } from "../../queue.js";
import {
  characterPhotoQuerySchema,
  LIBRARY_CHARACTER_LIMIT_PER_USER,
  mobileCharacterCreateBodySchema,
  mobileCharacterCreateOpenApiBody,
  mobileCharacterPortraitBodySchema,
  mobileCharacterPortraitOpenApiBody,
  mobileCharacterUpdateBodySchema,
  mobileCharacterUpdateOpenApiBody
} from "../characterSchemas.js";
import { readCharacterPhoto, type CharacterPhotoReading } from "../characterPhotoVision.js";
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
import {
  loadCharacterImages,
  ownedCharacter,
  portraitClaimIsLive,
  PORTRAIT_OPEN_STATUSES,
  pruneCharacterImages,
  recordCharacterImage
} from "../characterImageStore.js";
import type { MobileLibraryCharacterDto, MobileLibraryCharacterListDto } from "../dto.js";
import {
  hitAuthenticatedLimit,
  hitTieredLimit,
  requireMobileAuth,
  sendInsufficientCredits,
  sendMobileError
} from "../httpErrors.js";
import type { MobileRouteContext } from "../routeContext.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import { fingerprintGenerationRequest } from "../support.js";

/**
 * The account-wide character library ("consistent characters").
 *
 * CRUD is free; only `POST /:id/portrait` is priced. Characters belong to the
 * user, not to any project — books snapshot them at build time and never hold
 * a foreign key back, so deleting one here cannot break a book.
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
 * A compare-and-set rather than a field on the write above, for the same reason
 * `REFERENCE_CLAIMABLE` is one: up to `CHARACTER_PHOTO_VISION_BUDGET_MS` passes
 * between reading the row and this write, which is long enough for the user to
 * have typed an appearance of their own in the editor.
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

/** Thrown inside the attempt transaction when another start already owns the portrait. */
class PortraitInProgressError extends Error {
  constructor() {
    super("A portrait for this character is already being drawn.");
    this.name = "PortraitInProgressError";
  }
}

export async function registerMobileCharacterRoutes(
  fastify: FastifyInstance,
  context: MobileRouteContext
): Promise<void> {
  const { appConfig } = context;

  const characterContentText = (input: {
    name: string;
    description: string;
    // Screened with the rest — it is user text like any other. The photo
    // path's own reading never comes through here: `readCharacterPhoto`
    // screens it there, so that one bad half can be dropped without
    // failing an upload the reader did nothing wrong in.
    appearance?: string | null | undefined;
    fields: Array<{ key: string; value: string }>;
  }) =>
    [
      input.name,
      input.description,
      input.appearance ?? "",
      ...input.fields.map((field) => `${field.key}: ${field.value}`)
    ]
      .filter(Boolean)
      .join("\n");

  fastify.get(
    "/api/mobile/characters",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const characters = await prisma.libraryCharacter.findMany({
        where: { userId: auth.user.id },
        orderBy: { createdAt: "asc" }
      });
      return {
        characters: characters.map((character) => serializeLibraryCharacter(character)),
        portraitCredits: creditCostForOperation("CHARACTER_PORTRAIT_GENERATION")
      } satisfies MobileLibraryCharacterListDto;
    }
  );

  fastify.post(
    "/api/mobile/characters",
    {
      schema: {
        tags: ["mobile"],
        body: mobileCharacterCreateOpenApiBody,
        response: { 201: {}, 401: mobileAuthError, 403: mobileAuthError, 409: mobileAuthError, 422: mobileAuthError }
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
      const body = mobileCharacterCreateBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Give the character a name.");
      }
      if (!(await enforceContentRestrictions(reply, characterContentText(body.data)))) {
        return;
      }
      const count = await prisma.libraryCharacter.count({ where: { userId: auth.user.id } });
      if (count >= LIBRARY_CHARACTER_LIMIT_PER_USER) {
        return sendMobileError(
          reply,
          403,
          "CHARACTER_LIMIT_REACHED",
          `Your library holds up to ${LIBRARY_CHARACTER_LIMIT_PER_USER} characters. Delete one to add another.`
        );
      }
      try {
        const character = await prisma.libraryCharacter.create({
          data: {
            userId: auth.user.id,
            name: body.data.name,
            description: body.data.description,
            // Null rather than "": "no appearance recorded" is a state the
            // planner prompt branches on, so it gets one representation.
            appearance: body.data.appearance || null,
            fields: body.data.fields
          }
        });
        return reply.code(201).send({ character: serializeLibraryCharacter(character) satisfies MobileLibraryCharacterDto });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return sendMobileError(reply, 409, "CHARACTER_NAME_TAKEN", "You already have a character with that name.");
        }
        throw error;
      }
    }
  );

  fastify.patch(
    "/api/mobile/characters/:id",
    {
      schema: {
        tags: ["mobile"],
        body: mobileCharacterUpdateOpenApiBody,
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
      const { id } = idParamsSchema.parse(request.params);
      const body = mobileCharacterUpdateBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send at least one change.");
      }
      const character = await ownedCharacter(id, auth.user.id);
      if (!character) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      const next = {
        name: body.data.name ?? character.name,
        description: body.data.description ?? character.description,
        appearance: body.data.appearance ?? character.appearance,
        fields: body.data.fields ?? fieldsFromJson(character.fields)
      };
      if (!(await enforceContentRestrictions(reply, characterContentText(next)))) {
        return;
      }
      try {
        // Accepting the suggestion, rewriting it, and turning it down all
        // retire it: it describes a description the user has now settled, and
        // an offer that survives being taken is offered forever.
        const clearsSuggestion = body.data.description !== undefined || body.data.dismissSuggestion === true;
        const updated = await prisma.libraryCharacter.update({
          where: { id: character.id },
          data: {
            ...(body.data.name !== undefined ? { name: body.data.name } : {}),
            ...(body.data.description !== undefined ? { description: body.data.description } : {}),
            // Sent-and-empty is a deliberate clear, which is why the write is
            // keyed on the key being present rather than on the value.
            ...(body.data.appearance !== undefined ? { appearance: body.data.appearance || null } : {}),
            ...(body.data.fields !== undefined ? { fields: body.data.fields } : {}),
            ...(clearsSuggestion ? { suggestedDescription: null } : {})
          }
        });
        return { character: serializeLibraryCharacter(updated) satisfies MobileLibraryCharacterDto };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return sendMobileError(reply, 409, "CHARACTER_NAME_TAKEN", "You already have a character with that name.");
        }
        throw error;
      }
    }
  );

  fastify.delete(
    "/api/mobile/characters/:id",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
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
      // Read the history filenames before the row goes: the cascade takes the
      // image rows with it, and nothing sweeps this tree, so a name not
      // collected here is a file nothing can ever reach again.
      const historyFiles = (await loadCharacterImages(character.id, auth.user.id)).map(
        (image) => image.fileName
      );
      // The conditional delete is the real guard; the worker owns the row
      // while a portrait is in flight and must find it when it finishes.
      const deleted = await prisma.libraryCharacter.deleteMany({
        where: { id: character.id, portraitStatus: { notIn: [...PORTRAIT_OPEN_STATUSES] } }
      });
      if (deleted.count !== 1) {
        // A claim can outlive its job: a worker killed hard never runs its
        // failure path, and nothing else resets an account-level row. When the
        // backing job is no longer open the claim is stale, and delete is the
        // user's escape hatch rather than a wedge.
        if (await portraitClaimIsLive(character)) {
          return sendMobileError(
            reply,
            409,
            "PORTRAIT_IN_PROGRESS",
            "This character's portrait is still being drawn. Try again when it finishes."
          );
        }
        const forced = await prisma.libraryCharacter.deleteMany({ where: { id: character.id } });
        if (forced.count !== 1) {
          return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
        }
      }
      for (const fileName of historyFiles) {
        await deleteLibraryCharacterFile(appConfig.IMAGE_STORAGE_DIR, auth.user.id, fileName);
      }
      // Belt and braces: a pointer can name a file whose row was lost to a
      // crash between the two writes, and the cascade has already taken the
      // rows that would otherwise have named it.
      await deleteLibraryCharacterFile(appConfig.IMAGE_STORAGE_DIR, auth.user.id, character.photoPath);
      await deleteLibraryCharacterFile(appConfig.IMAGE_STORAGE_DIR, auth.user.id, character.portraitPath);
      return { deleted: true };
    }
  );

  fastify.put(
    "/api/mobile/characters/:id/photo",
    {
      bodyLimit: CREATION_ATTACHMENT_MAX_BYTES + 64 * 1024,
      schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError, 422: mobileAuthError } }
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

      const { fileName } = await recordCharacterImage({
        imageStorageDir: appConfig.IMAGE_STORAGE_DIR,
        userId: auth.user.id,
        characterId: character.id,
        source: "UPLOAD",
        kind: "photo",
        optimized,
        photoKind: reading?.photoKind,
        // Frozen at ingest and never re-derived. Promote reads only this.
        referenceEligible: reading?.canAdoptAsReference ?? false
      });

      // The photo columns describe the upload itself and are always true of
      // it, so they are written unconditionally. A re-upload replaces the
      // verdict and the suggestion wholesale; stale ones would describe an
      // image that is no longer there. The superseded photo is not deleted —
      // it is a retained version now, one promote away.
      await prisma.libraryCharacter.update({
        where: { id: character.id },
        data: {
          photoPath: fileName,
          photoKind: reading?.photoKind ?? null,
          suggestedDescription: reading?.suggestedDescription ?? null
        }
      });

      const appearanceApplied = await fillAppearanceFromPhoto(character.id, reading);

      if (adoptsAsReference(reading)) {
        // Adoption points *both* columns at the one uploaded file. The second
        // copy existed so the two columns could be deleted independently;
        // `DELETE /:id/photo` no longer unlinks anything, so a shared file is
        // safe — and a duplicate would show up as a duplicate tile in the strip.
        await prisma.libraryCharacter.updateMany({
          where: { id: character.id, ...REFERENCE_CLAIMABLE },
          data: {
            portraitPath: fileName,
            portraitSource: "ADOPTED_UPLOAD" as const,
            portraitStatus: "READY" as const,
            portraitError: null
          }
        });
        // No rollback and no rm: the bytes were on disk before the claim, so a
        // won claim can never name a missing file, and a superseded reference
        // is a version the reader can put back.
      }

      await pruneCharacterImages(appConfig.IMAGE_STORAGE_DIR, auth.user.id, character.id);
      const current = (await ownedCharacter(id, auth.user.id)) ?? character;
      const images = await loadCharacterImages(character.id, auth.user.id);
      return {
        character: serializeLibraryCharacter(
          current,
          // Applied, it is the appearance and there is nothing to offer.
          // Refused, the character already has a look the user owns and this
          // is the alternative the new picture shows.
          appearanceApplied || !reading?.suggestedAppearance
            ? {}
            : { suggestedAppearance: reading.suggestedAppearance }
        ) satisfies MobileLibraryCharacterDto,
        images: images.map((image) => serializeLibraryCharacterImage(current, image))
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
      const character = await ownedCharacter(id, auth.user.id);
      if (!character) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      // Now a pointer clear and nothing else. It used to unlink the file and
      // drop an adopted reference with it, on the grounds that the reader had
      // swapped the picture out — which stopped being true the moment the
      // picture was retained. The app calls the per-image delete instead; this
      // stays for clients already in the wild.
      const updated = await prisma.libraryCharacter.update({
        where: { id: character.id },
        data: { photoPath: null, photoKind: null, suggestedDescription: null }
      });
      return { character: serializeLibraryCharacter(updated) satisfies MobileLibraryCharacterDto };
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
      schema: {
        tags: ["mobile"],
        body: mobileCharacterPortraitOpenApiBody,
        response: {
          202: {},
          401: mobileAuthError,
          402: mobileAuthError,
          404: mobileAuthError,
          409: mobileAuthError,
          422: mobileAuthError
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
      const character = await ownedCharacter(id, auth.user.id);
      if (!character) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
      }
      if (PORTRAIT_OPEN_STATUSES.includes(character.portraitStatus as (typeof PORTRAIT_OPEN_STATUSES)[number])) {
        return sendMobileError(
          reply,
          409,
          "PORTRAIT_IN_PROGRESS",
          "This character's portrait is already being drawn."
        );
      }
      const contentText = characterContentText({
        name: character.name,
        description: character.description,
        fields: fieldsFromJson(character.fields)
      });
      if (!(await enforceContentRestrictions(reply, contentText))) {
        return;
      }

      const cost = creditCostForOperation("CHARACTER_PORTRAIT_GENERATION");
      const hasPhoto = character.photoPath !== null;
      let started;
      try {
        started = await startGenerationAttempt({
          userId: auth.user.id,
          commandKey: body.data.requestId
            ? `mobile:character-portrait:${id}:${body.data.requestId}`
            : `mobile:character-portrait:${id}:${randomUUID()}`,
          requestFingerprint: fingerprintGenerationRequest({
            characterId: id,
            name: character.name,
            description: character.description,
            fields: character.fields,
            hasPhoto
          }),
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
        if (error instanceof InsufficientCreditsError) {
          return sendInsufficientCredits(reply, error);
        }
        if (error instanceof PortraitInProgressError) {
          return sendMobileError(reply, 409, "PORTRAIT_IN_PROGRESS", "This character's portrait is already being drawn.");
        }
        if (error instanceof GenerationAttemptConflictError) {
          return sendMobileError(reply, 409, error.code, error.message);
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

      const current = await ownedCharacter(id, auth.user.id);
      return reply.code(202).send({
        character: serializeLibraryCharacter(current ?? character) satisfies MobileLibraryCharacterDto,
        creditsCharged: started.attempt.quotedCredits
      });
    }
  );
}
