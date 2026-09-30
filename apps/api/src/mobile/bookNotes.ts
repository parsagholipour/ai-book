import { prisma, type BookNoteModel } from "@book-maker/db";
import { z } from "zod";
import type { BookNoteDto } from "./bookNoteDto.js";
import { toOpenApiRequestBody } from "./schemas.js";
import { isPrismaUniqueConflict } from "./support.js";

/**
 * Book notes (`.scratch/book-notes/spec.md`): the owner's private notebook for
 * one book, on every kind of book — generated, imported or written.
 *
 * Nothing here screens, prints, exports or prompts with a note. A note never
 * leaves the account, so a refusal would only lose the owner's words — the
 * reason Studio autosave goes unscreened too (`src/mobile/CLAUDE.md`, "Book
 * notes"). Titles and bodies are stored exactly as sent; trimming is only how
 * a create is judged blank.
 */

/** The ceilings the spec names; the app enforces the same ones before it sends. */
export const BOOK_NOTE_TITLE_MAX = 200;
export const BOOK_NOTE_BODY_MAX = 30_000;
/** Notes per book. The list returns every body, so this is also the list's size bound. */
export const BOOK_NOTE_LIMIT = 200;

/**
 * Wider than the shared `requestIdSchema` (64) because the spec gives the app
 * 100; the app mints a UUID, so either fits.
 */
const noteRequestIdSchema = z.string().trim().min(8).max(100);
const noteTitleSchema = z.string().max(BOOK_NOTE_TITLE_MAX);
const noteBodySchema = z.string().max(BOOK_NOTE_BODY_MAX);

export const bookNoteCreateBodySchema = z
  .object({
    requestId: noteRequestIdSchema,
    title: noteTitleSchema.optional(),
    body: noteBodySchema.optional(),
    pinned: z.boolean().optional()
  })
  .strict();
export const bookNoteCreateOpenApiBody = toOpenApiRequestBody(bookNoteCreateBodySchema);

const bookNoteUpdateObjectSchema = z
  .object({
    title: noteTitleSchema.optional(),
    body: noteBodySchema.optional(),
    pinned: z.boolean().optional(),
    baseRevision: z.number().int().min(1).optional()
  })
  .strict();
// Built from the object, not the refined schema: the two cross-field rules
// below have no JSON-schema form, and Ajv never gates these bodies anyway
// (`attachValidation`), so the parse is the one check.
export const bookNoteUpdateOpenApiBody = toOpenApiRequestBody(bookNoteUpdateObjectSchema);
export const bookNoteUpdateBodySchema = bookNoteUpdateObjectSchema.superRefine((body, context) => {
  const writesText = body.title !== undefined || body.body !== undefined;
  if (!writesText && body.pinned === undefined) {
    context.addIssue({ code: "custom", message: "Send a title, a body or pinned." });
  }
  // A text write without the revision it was based on would be a blind
  // overwrite of whatever another device saved since.
  if (writesText && body.baseRevision === undefined) {
    context.addIssue({ code: "custom", path: ["baseRevision"], message: "A title or body change needs its baseRevision." });
  }
});

export const bookNoteParamsSchema = z.object({ id: z.string().min(1), noteId: z.string().min(1) });

export type BookNoteCreateBody = z.infer<typeof bookNoteCreateBodySchema>;
export type BookNoteUpdateBody = z.infer<typeof bookNoteUpdateBodySchema>;

/** A create with nothing to keep. An update may empty a note; only a create is refused for it. */
export function isBlankBookNote(body: { title?: string | undefined; body?: string | undefined }): boolean {
  return (body.title ?? "").trim() === "" && (body.body ?? "").trim() === "";
}

/** Named, not spread: the row also carries its project, request id and update clock. */
export function serializeBookNote(note: BookNoteModel): BookNoteDto {
  return {
    id: note.id,
    title: note.title,
    body: note.body,
    pinned: note.pinned,
    revision: note.revision,
    createdAt: note.createdAt.toISOString(),
    editedAt: note.editedAt.toISOString()
  };
}

/** The caller's own book, or null — another user's book is a miss, never a 403. */
export async function ownedNoteProject(userId: string, projectId: string): Promise<{ id: string } | null> {
  return prisma.project.findFirst({ where: { id: projectId, userId }, select: { id: true } });
}

/** Pinned first, then the most recent title/body change; the last two keys only settle ties. */
export async function listBookNotes(projectId: string): Promise<BookNoteModel[]> {
  return prisma.bookNote.findMany({
    where: { projectId },
    orderBy: [{ pinned: "desc" }, { editedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }]
  });
}

export type BookNoteCreateOutcome =
  | { kind: "created"; note: BookNoteModel }
  | { kind: "replayed"; note: BookNoteModel }
  | { kind: "limit" };

/**
 * Makes the note once per `(projectId, requestId)`.
 *
 * A replay answers the note as it is now, even at the limit — the retry is
 * for a note that already counts. Two creates racing on one `requestId` meet
 * the unique index, and the loser re-reads the winner's row. The limit is a
 * count before the insert, so two *different* creates racing at 199 can land
 * 201: it is a ceiling on a runaway client, and nothing reads the count as a
 * guarantee. Serializing it would mean a lock per create for no reader.
 */
export async function createBookNote(projectId: string, body: BookNoteCreateBody): Promise<BookNoteCreateOutcome> {
  const replayed = await findByRequestId(projectId, body.requestId);
  if (replayed) {
    return { kind: "replayed", note: replayed };
  }
  const count = await prisma.bookNote.count({ where: { projectId } });
  if (count >= BOOK_NOTE_LIMIT) {
    return { kind: "limit" };
  }
  try {
    const note = await prisma.bookNote.create({
      data: {
        projectId,
        requestId: body.requestId,
        title: body.title ?? "",
        body: body.body ?? "",
        pinned: body.pinned ?? false
      }
    });
    return { kind: "created", note };
  } catch (error) {
    if (!isPrismaUniqueConflict(error)) throw error;
    const winner = await findByRequestId(projectId, body.requestId);
    if (!winner) throw error;
    return { kind: "replayed", note: winner };
  }
}

function findByRequestId(projectId: string, requestId: string): Promise<BookNoteModel | null> {
  return prisma.bookNote.findUnique({ where: { projectId_requestId: { projectId, requestId } } });
}

export type BookNoteUpdateOutcome =
  | { kind: "saved"; note: BookNoteModel }
  | { kind: "conflict"; note: BookNoteModel }
  | { kind: "not_found" };

/**
 * Applies a PATCH under its `baseRevision`.
 *
 * The revision is a precondition of the write itself (`updateMany` with the
 * revision in its `where`), so a save that lost a race to another device
 * moves nothing and answers the winner's copy. A text change bumps
 * `revision` and `editedAt`; values identical to the row write nothing; a pin
 * toggle moves neither clock, so pinning on one device never turns another
 * device's open editor into a conflict. A `baseRevision` sent with a pin-only
 * write is still honoured — it is the client's stated precondition.
 */
export async function updateBookNote(projectId: string, noteId: string, body: BookNoteUpdateBody): Promise<BookNoteUpdateOutcome> {
  const current = await findNote(projectId, noteId);
  if (!current) {
    return { kind: "not_found" };
  }
  if (body.baseRevision !== undefined && body.baseRevision !== current.revision) {
    return { kind: "conflict", note: current };
  }
  // Read against `current`, which is safe for text: every text write carries
  // `baseRevision`, and the `where` below refuses the write if any other text
  // write has bumped the revision since this read.
  const titleChanged = body.title !== undefined && body.title !== current.title;
  const bodyChanged = body.body !== undefined && body.body !== current.body;
  const textChanged = titleChanged || bodyChanged;
  const pinChanged = body.pinned !== undefined && body.pinned !== current.pinned;
  if (!textChanged && !pinChanged) {
    return { kind: "saved", note: current };
  }
  const { count } = await prisma.bookNote.updateMany({
    where: { id: noteId, projectId, ...(body.baseRevision !== undefined ? { revision: body.baseRevision } : {}) },
    data: {
      ...(titleChanged && body.title !== undefined ? { title: body.title } : {}),
      ...(bodyChanged && body.body !== undefined ? { body: body.body } : {}),
      ...(pinChanged && body.pinned !== undefined ? { pinned: body.pinned } : {}),
      ...(textChanged ? { revision: { increment: 1 }, editedAt: new Date() } : {})
    }
  });
  const after = await findNote(projectId, noteId);
  if (!after) {
    return { kind: "not_found" };
  }
  return count === 0 ? { kind: "conflict", note: after } : { kind: "saved", note: after };
}

/** One statement, so a delete racing another delete answers exactly one of them. */
export async function deleteBookNote(projectId: string, noteId: string): Promise<boolean> {
  const { count } = await prisma.bookNote.deleteMany({ where: { id: noteId, projectId } });
  return count > 0;
}

function findNote(projectId: string, noteId: string): Promise<BookNoteModel | null> {
  return prisma.bookNote.findFirst({ where: { id: noteId, projectId } });
}
