import type { AuthorPlanCharacter } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { generationDescription, libraryMentionInclude } from "@book-maker/db/libraryMentions";
import type { ManuscriptDb } from "./manuscriptStore.js";

/**
 * The book's cast: library characters the author named in the Studio's story
 * bible (`settings.castCharacterIds`).
 *
 * A library character reaches a book by copy and by name, never by foreign key
 * (root CLAUDE.md, "Characters"), so the settings hold ids and every reader
 * resolves them against the owner's library *now*: a character renamed there
 * is renamed here, one deleted there simply drops out. Only the owner's own
 * rows ever resolve — the ids are JSON a client wrote.
 */

export type CastCharacter = {
  id: string;
  name: string;
  /** Who they are, with `@` mention markers stripped (`generationDescription`). */
  description: string;
  /** How they look, when the author wrote it down. */
  appearance: string | null;
};

export class UnknownCastCharacterError extends Error {
  constructor(readonly missingIds: string[]) {
    super("Some of those characters are not in your library.");
  }
}

/** The cast in the author's order; ids that do not resolve are dropped. */
export async function loadCastCharacters(
  userId: string,
  ids: readonly string[],
  db: ManuscriptDb = prisma
): Promise<CastCharacter[]> {
  if (ids.length === 0) {
    return [];
  }
  const rows = await db.libraryCharacter.findMany({
    where: { id: { in: [...ids] }, userId },
    include: libraryMentionInclude
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        id: row.id,
        name: row.name,
        description: generationDescription(row).trim(),
        appearance: row.appearance?.trim() || null
      }
    ];
  });
}

/** Refuses a cast naming anything but the caller's own library characters. */
export async function assertCastBelongsToUser(userId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const rows = await prisma.libraryCharacter.findMany({
    where: { id: { in: [...ids] }, userId },
    select: { id: true }
  });
  const found = new Set(rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new UnknownCastCharacterError(missing);
  }
}

/**
 * The plan's characters for the cast. `description` carries the look too,
 * because the planner-facing surfaces read it alone; `visualRules` carries the
 * look on its own, the way a library character reaches a voice cast
 * (`libraryVoiceCharacters.ts`), so every illustration of the book is told it.
 */
export function castPlanCharacters(cast: readonly CastCharacter[]): AuthorPlanCharacter[] {
  return cast.map((character) => ({
    name: character.name,
    role: "character",
    description: describeCastCharacter(character) || character.name,
    visualRules: character.appearance ? [character.appearance] : []
  }));
}

/** The cast as the assist runners read it. */
export function castAssistCharacters(cast: readonly CastCharacter[]): Array<{ name: string; description: string }> {
  return cast.map((character) => ({ name: character.name, description: describeCastCharacter(character) }));
}

function describeCastCharacter(character: CastCharacter): string {
  return [character.description, character.appearance ?? ""].filter(Boolean).join(" ").trim();
}
