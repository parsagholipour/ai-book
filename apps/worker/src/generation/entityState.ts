import { foldCharacterName, type BookPlan } from "@book-maker/core";
import { degradeRetrievalArm, Prisma, prisma } from "@book-maker/db";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { foldedMentions } from "./entityMentions.js";

/**
 * Per-entity continuity state: the "as of page N" line each character and
 * location carries, folded out of the continuity notes a saved page recorded and
 * read back into the writer context pack.
 *
 * The other half of the continuity memory `semanticRecall.ts` heads is the
 * embedding recall; this half is deterministic and costs no model call.
 */

type EntityState = {
  notes: string[];
  updatedAtPage: number;
};

const ENTITY_STATE_NOTE_LIMIT = 4;
const ENTITY_STATE_LINE_LIMIT = 12;

/**
 * Arm names for {@link degradeRetrievalArm}, and so the keys of its failure
 * census. Neither half of this state is a retrieval arm, but both meet the
 * policy's case exactly: a fault here is almost always one fact about the
 * database, both run once per page job, and both are best-effort — so a line
 * per page job would bury the first one under a book's worth of copies of
 * itself.
 */
const ENTITY_STATE_UPDATE_ARM = "Entity state update";
const ENTITY_STATE_LOAD_ARM = "Entity state load";

export function entityStateRecord(value: unknown): EntityState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const notes = Array.isArray(record.notes) ? record.notes.filter((note): note is string => typeof note === "string") : [];
  const updatedAtPage = typeof record.updatedAtPage === "number" ? record.updatedAtPage : 0;
  return { notes, updatedAtPage };
}

const ENTITY_STATE_CAS_ATTEMPTS = 3;

/**
 * Folds a saved page's continuity notes into per-character/location state so
 * later pages see each entity's latest condition even outside the recency
 * window. Deterministic (no extra model call).
 *
 * Pages generate in parallel waves (up to `MAX_PARALLEL_PAGE_JOBS`), so two
 * pages that both mention the same entity can finish around the same time.
 * A blind read-modify-write would let whichever `update` lands second silently
 * discard the first page's note, so each entity's write is a compare-and-swap
 * on its own `state` column: read, compute, write conditioned on the row still
 * holding the state just read, and retry against the winner's state on a miss.
 */
export async function updateEntityStateFromPage(projectId: string, pageIndex: number, continuityNotes: string[]) {
  if (continuityNotes.length === 0) {
    return;
  }
  try {
    const [characters, locations] = await Promise.all([
      prisma.character.findMany({ where: { projectId } }),
      prisma.location.findMany({ where: { projectId } })
    ]);

    const foldedNotes = continuityNotes.map((note) => foldCharacterName(note));
    const notesNaming = (name: string): string[] => {
      const folded = foldCharacterName(name);
      return continuityNotes.filter((_, index) => foldedMentions(foldedNotes[index] ?? "", folded));
    };

    for (const character of characters) {
      const matches = notesNaming(character.name);
      if (matches.length === 0) {
        continue;
      }
      await casUpdateEntityState({
        read: () => prisma.character.findUnique({ where: { id: character.id }, select: { state: true } }),
        write: (id, expectedState, data) =>
          prisma.character.updateMany({ where: { id, state: { equals: expectedState } }, data }),
        id: character.id,
        initialState: character.state,
        pageIndex,
        matches
      });
    }

    for (const location of locations) {
      const matches = notesNaming(location.name);
      if (matches.length === 0) {
        continue;
      }
      await casUpdateEntityState({
        read: () => prisma.location.findUnique({ where: { id: location.id }, select: { state: true } }),
        write: (id, expectedState, data) =>
          prisma.location.updateMany({ where: { id, state: { equals: expectedState } }, data }),
        id: location.id,
        initialState: location.state,
        pageIndex,
        matches
      });
    }
  } catch (error) {
    degradeRetrievalArm<undefined>({
      arm: ENTITY_STATE_UPDATE_ARM,
      projectId,
      error,
      fallback: undefined,
      // The rethrow this replaced. This runs among a saved page's publishing
      // writes, so swallowing a stop would let the next page start on a run the
      // reader has already ended.
      rethrowIf: isStopRequestedError
    });
  }
}

async function casUpdateEntityState(options: {
  read: () => Promise<{ state: unknown } | null>;
  write: (
    id: string,
    expectedState: Prisma.InputJsonValue,
    data: { state: Prisma.InputJsonValue }
  ) => Promise<{ count: number }>;
  id: string;
  initialState: unknown;
  pageIndex: number;
  matches: string[];
}): Promise<void> {
  let currentState = options.initialState;
  for (let attempt = 0; attempt < ENTITY_STATE_CAS_ATTEMPTS; attempt += 1) {
    const previous = entityStateRecord(currentState);
    const notes = [...(previous?.notes ?? []), ...options.matches].slice(-ENTITY_STATE_NOTE_LIMIT);
    const nextState = { notes, updatedAtPage: options.pageIndex };
    const claimed = await options.write(
      options.id,
      (currentState ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      { state: nextState }
    );
    if (claimed.count === 1) {
      return;
    }
    // Someone else's write landed first; read the winner's state and fold our
    // note onto it instead of losing it.
    const latest = await options.read();
    if (!latest) {
      return;
    }
    currentState = latest.state;
  }
  // Deliberately a bare warn rather than `degradeRetrievalArm`: nothing
  // failed here — every write ran and one of them won — and the line names an
  // entity id, which would be a fresh census key on every entity that ever lost
  // the race, so the ladder could never reach its second rung and the bounded
  // census would churn. It is also rare by construction (three consecutive
  // losses on one row), which is the opposite of the once-per-page-job flood
  // the ladder exists for.
  console.warn(`Entity state update for ${options.id} lost the CAS race ${ENTITY_STATE_CAS_ATTEMPTS} times in a row`);
}

/** Formats the current character/location state for the writer context pack. */
export async function loadEntityStateLines(projectId: string, plan: BookPlan): Promise<string[]> {
  if (plan.characters.length === 0 && plan.locations.length === 0) {
    return [];
  }
  try {
    const [characters, locations] = await Promise.all([
      prisma.character.findMany({ where: { projectId } }),
      prisma.location.findMany({ where: { projectId } })
    ]);
    const lines: string[] = [];
    for (const character of characters) {
      const state = entityStateRecord(character.state);
      if (!state || state.notes.length === 0) {
        continue;
      }
      lines.push(`${character.name} (${character.role}) — as of page ${state.updatedAtPage}: ${state.notes.join(" ")}`);
    }
    for (const location of locations) {
      const state = entityStateRecord(location.state);
      if (!state || state.notes.length === 0) {
        continue;
      }
      lines.push(`${location.name} (location) — as of page ${state.updatedAtPage}: ${state.notes.join(" ")}`);
    }
    return lines.slice(0, ENTITY_STATE_LINE_LIMIT);
  } catch (error) {
    return degradeRetrievalArm<string[]>({
      arm: ENTITY_STATE_LOAD_ARM,
      projectId,
      error,
      fallback: [],
      // The rethrow this replaced: these lines are one arm of the writer
      // context pack, and a page assembled without them is a degraded page, not
      // a stopped one.
      rethrowIf: isStopRequestedError
    });
  }
}
