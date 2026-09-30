/**
 * Wire shapes of book notes (`.scratch/book-notes/spec.md`, "HTTP API"): the
 * owner's private notebook for one book. Types only. The Dart mirrors in
 * `apps/mobile/lib/features/notes/` are written against this file, so a key
 * renamed here is a broken app.
 *
 * No key may contain "model" — the mobile leak guard rejects it (see
 * `src/mobile/CLAUDE.md`, "Serializers are the API contract").
 */

export type BookNoteDto = {
  id: string;
  /** "" when untitled. */
  title: string;
  /** Plain text, exactly as the owner wrote it. */
  body: string;
  pinned: boolean;
  /** Bumps on every title/body change; a pin toggle leaves it alone. */
  revision: number;
  createdAt: string;
  /** The last title/body change, which the list sorts by. A pin toggle leaves it alone. */
  editedAt: string;
};

/** `GET /projects/:id/notes`: pinned first, then most recently edited. */
export type BookNoteListResponseDto = {
  notes: BookNoteDto[];
  /** How many notes one book may hold. */
  limit: number;
};

/** `POST /projects/:id/notes` and `PATCH /projects/:id/notes/:noteId`. */
export type BookNoteResponseDto = {
  note: BookNoteDto;
};

/** `DELETE /projects/:id/notes/:noteId`. */
export type BookNoteDeleteResponseDto = {
  ok: true;
};
