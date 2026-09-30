import type { FastifyInstance } from "fastify";
import {
  hitAuthenticatedLimit,
  requireMobileAuth,
  sendMobileError,
  sendProjectNotFound,
  sendUnreadableBodyError
} from "../httpErrors.js";
import type { BookNoteDeleteResponseDto, BookNoteListResponseDto, BookNoteResponseDto } from "../bookNoteDto.js";
import {
  BOOK_NOTE_LIMIT,
  bookNoteCreateBodySchema,
  bookNoteCreateOpenApiBody,
  bookNoteParamsSchema,
  bookNoteUpdateBodySchema,
  bookNoteUpdateOpenApiBody,
  createBookNote,
  deleteBookNote,
  isBlankBookNote,
  listBookNotes,
  ownedNoteProject,
  serializeBookNote,
  updateBookNote
} from "../bookNotes.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import type { MobileRouteContext } from "../routeContext.js";

/**
 * Book notes (`.scratch/book-notes/spec.md`, "HTTP API"): a private notebook
 * per book, on every book the caller owns — generated, imported or written —
 * in any status. Free, never screened, never sent to a model.
 *
 * A book the caller does not own is `PROJECT_NOT_FOUND`; a note that is not
 * in that book is `NOTE_NOT_FOUND`. Both are 404, never 403.
 */

const NOTE_NOT_FOUND_MESSAGE = "That note no longer exists.";
const NOTE_CONFLICT_MESSAGE = "This note was changed on another device. Both versions are kept.";
const NOTE_INVALID_MESSAGE = "This note could not be saved as sent.";

export async function registerMobileBookNoteRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { draftLimiter } = context;

  fastify.get(
    "/api/mobile/projects/:id/notes",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const project = await ownedNoteProject(auth.user.id, id);
      if (!project) return sendProjectNotFound(reply);
      const notes = await listBookNotes(project.id);
      // Private text; no cache between the owner and the server may keep it.
      reply.header("Cache-Control", "no-store");
      return { notes: notes.map(serializeBookNote), limit: BOOK_NOTE_LIMIT } satisfies BookNoteListResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/notes",
    {
      attachValidation: true,
      errorHandler: sendUnreadableBodyError,
      schema: {
        tags: ["mobile"],
        body: bookNoteCreateOpenApiBody,
        response: {
          200: {},
          201: {},
          400: mobileAuthError,
          401: mobileAuthError,
          404: mobileAuthError,
          409: mobileAuthError,
          429: mobileAuthError
        }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "book-note-create")) return;
      const { id } = idParamsSchema.parse(request.params);
      const parsed = bookNoteCreateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", NOTE_INVALID_MESSAGE);
      }
      if (isBlankBookNote(parsed.data)) {
        return sendMobileError(reply, 400, "EMPTY_NOTE", "Add a title or some text to save this note.");
      }
      const project = await ownedNoteProject(auth.user.id, id);
      if (!project) return sendProjectNotFound(reply);
      const outcome = await createBookNote(project.id, parsed.data);
      if (outcome.kind === "limit") {
        return sendMobileError(
          reply,
          409,
          "NOTE_LIMIT",
          `A book can hold ${BOOK_NOTE_LIMIT} notes. Delete one to add another.`
        );
      }
      return reply
        .code(outcome.kind === "created" ? 201 : 200)
        .send({ note: serializeBookNote(outcome.note) } satisfies BookNoteResponseDto);
    }
  );

  fastify.patch(
    "/api/mobile/projects/:id/notes/:noteId",
    // Not rate limited, like the Studio's chapter autosave: the editor saves
    // every pause in typing, and a limit sized for creates would refuse a
    // long note mid-sentence. The 409 schema is open because the conflict
    // carries the server's copy inside `error`, which `mobileAuthError` would
    // serialize away.
    {
      attachValidation: true,
      errorHandler: sendUnreadableBodyError,
      schema: {
        tags: ["mobile"],
        body: bookNoteUpdateOpenApiBody,
        response: { 400: mobileAuthError, 401: mobileAuthError, 404: mobileAuthError, 409: {} }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id, noteId } = bookNoteParamsSchema.parse(request.params);
      const parsed = bookNoteUpdateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", NOTE_INVALID_MESSAGE);
      }
      const project = await ownedNoteProject(auth.user.id, id);
      if (!project) return sendProjectNotFound(reply);
      const outcome = await updateBookNote(project.id, noteId, parsed.data);
      if (outcome.kind === "not_found") {
        return sendMobileError(reply, 404, "NOTE_NOT_FOUND", NOTE_NOT_FOUND_MESSAGE);
      }
      if (outcome.kind === "conflict") {
        // The app's `ApiException.details` is the `error` object and nothing
        // else, so the copy it needs to choose a version rides inside it.
        return reply.code(409).send({
          error: { code: "NOTE_CONFLICT", message: NOTE_CONFLICT_MESSAGE, note: serializeBookNote(outcome.note) }
        });
      }
      return { note: serializeBookNote(outcome.note) } satisfies BookNoteResponseDto;
    }
  );

  fastify.delete(
    "/api/mobile/projects/:id/notes/:noteId",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError, 429: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "book-note-delete")) return;
      const { id, noteId } = bookNoteParamsSchema.parse(request.params);
      const project = await ownedNoteProject(auth.user.id, id);
      if (!project) return sendProjectNotFound(reply);
      // A hard delete: the app's Undo re-creates the note under a fresh requestId.
      if (!(await deleteBookNote(project.id, noteId))) {
        return sendMobileError(reply, 404, "NOTE_NOT_FOUND", NOTE_NOT_FOUND_MESSAGE);
      }
      return { ok: true } satisfies BookNoteDeleteResponseDto;
    }
  );
}
