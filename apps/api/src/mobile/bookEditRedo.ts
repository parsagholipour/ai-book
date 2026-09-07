import { parseStructuralApplication } from "@book-maker/core";
import { Prisma } from "@book-maker/db";

import { canUndoBookEdit, hasBookEditUndoRecord, UNDOABLE_EDIT_KINDS } from "./manualEdits.js";
import { previousImageAssetsFromClassifier } from "./imageEditRecords.js";
import { jsonRecord } from "./support.js";

/** Classifier key Undo stamps so Redo can put the after extract back. */
export const STORY_DELTAS_AFTER_KEY = "storyDeltasAfter";

/**
 * Whether Redo would restore *this* edit — the inverse of Undo, and one
 * predicate the same way Undo is.
 *
 * Snapshot-backed only. A structural stamp is enough to undo (the worker
 * recorded the shift) and not enough to redo: the API cannot replay
 * `applyStructuralPageChange`, and the stamp does not keep the after-order or
 * the inserted bodies. Combined structural+text is refused with the structural
 * half; a button that restored the prose and left the pages where Undo put
 * them would be a half-redo under a confirmation that promised the edit back.
 *
 * `redoable: false` is stamped at Undo when the snapshots have no after
 * fields and no picture record to invert. Absent (an undo from before that
 * stamp) still reads as redoable here; the apply path refuses if there is
 * still nothing to write.
 */
export function hasBookEditRedoRecord(operation: {
  classifier?: unknown;
  snapshotCount: number;
  archivedSnapshotCount?: number;
}): boolean {
  if (parseStructuralApplication(operation.classifier) !== null) {
    return false;
  }
  if (jsonRecord(operation.classifier).redoable === false) {
    return false;
  }
  return hasBookEditUndoRecord(operation);
}

/**
 * The one rule the Redo button and the redo itself both have to express: an
 * edit is redoable only when redoing would restore *that* edit.
 *
 * `pickRedoableBookEdit` takes the most recently undone candidate that still
 * has a record and is not blocked by a later not-undone edit, so an APPLIED
 * row without one is not "a redo that does nothing" — it is a redo of
 * whatever undone edit came *after* it, on a button the reader tapped
 * expecting this one.
 */
export function canRedoBookEdit(operation: {
  status: string;
  kind: string;
  classifier?: unknown;
  snapshotCount: number;
  archivedSnapshotCount?: number;
}): boolean {
  if (operation.status !== "APPLIED") {
    return false;
  }
  if (!(UNDOABLE_EDIT_KINDS as readonly string[]).includes(operation.kind)) {
    return false;
  }
  if (!hasBookEditRedoRecord(operation)) {
    return false;
  }
  return typeof jsonRecord(operation.classifier).undoneAt === "string";
}

export type BookEditRedoCandidate = {
  id: string;
  status: string;
  kind: string;
  classifier?: unknown;
  snapshotCount: number;
  archivedSnapshotCount?: number;
  appliedAt?: Date | string | null;
  createdAt: Date | string;
};

/** The fields the picker and the button both read, from either `_count` or included rows. */
export function bookEditRedoCandidate(operation: {
  id: string;
  status: string;
  kind: string;
  classifier?: unknown;
  snapshots?: { length: number } | undefined;
  _count?: { snapshots?: number; archivedSnapshots?: number } | undefined;
  appliedAt?: Date | string | null;
  createdAt: Date | string;
}): BookEditRedoCandidate {
  return {
    id: operation.id,
    status: operation.status,
    kind: operation.kind,
    ...(operation.classifier !== undefined ? { classifier: operation.classifier } : {}),
    snapshotCount: operation._count?.snapshots ?? operation.snapshots?.length ?? 0,
    archivedSnapshotCount: operation._count?.archivedSnapshots ?? 0,
    ...(operation.appliedAt != null ? { appliedAt: operation.appliedAt } : {}),
    createdAt: operation.createdAt
  };
}

/**
 * Which undone edit Redo would actually restore.
 *
 * Not `find(canRedo)` on `createdAt desc`: after Undo B then Undo A that
 * would pick B, and Redo would put B back while A is the one the reader just
 * took off. The later-not-undone filter is why a new edit after Undo turns
 * Redo off — restoring A under B would layer the older after-state over the
 * newer one.
 *
 * Among the remaining, the newest `undoneAt` wins, not `appliedAt`.
 */
export function pickRedoableBookEdit<T extends BookEditRedoCandidate>(operations: readonly T[]): T | undefined {
  const redoable = operations.filter((candidate) => canRedoBookEdit(candidate));
  const unblocked = redoable.filter((candidate) => !laterNotUndoneEditBlocks(candidate, operations));
  if (unblocked.length === 0) {
    return undefined;
  }
  return unblocked.reduce((best, candidate) =>
    undoneMillis(candidate) >= undoneMillis(best) ? candidate : best
  );
}

function laterNotUndoneEditBlocks(
  candidate: BookEditRedoCandidate,
  operations: readonly BookEditRedoCandidate[]
): boolean {
  const candidateApplied = appliedMillis(candidate);
  return operations.some(
    (other) =>
      other.id !== candidate.id &&
      canUndoBookEdit(other) &&
      appliedMillis(other) > candidateApplied
  );
}

function appliedMillis(operation: BookEditRedoCandidate): number {
  return timeMillis(operation.appliedAt ?? operation.createdAt);
}

function undoneMillis(operation: BookEditRedoCandidate): number {
  const undoneAt = jsonRecord(operation.classifier).undoneAt;
  return typeof undoneAt === "string" ? timeMillis(undoneAt) : 0;
}

function timeMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

export type BookEditAfterSnapshot = {
  titleAfter?: string | null;
  markdownAfter?: string | null;
  summaryAfter?: string | null;
};

/** True when Undo left an after-state Redo can write back. */
export function snapshotHasAfter(snapshot: BookEditAfterSnapshot): boolean {
  return snapshot.titleAfter != null || snapshot.markdownAfter != null || snapshot.summaryAfter != null;
}

/**
 * What Undo stamps on the classifier so the card does not offer Redo for an
 * edit that has nothing to put back — no after snapshot fields, no picture
 * record to invert, or a structural stamp the API cannot replay.
 */
export function bookEditRedoableMark(
  snapshots: readonly BookEditAfterSnapshot[],
  classifier: unknown
): boolean {
  if (parseStructuralApplication(classifier) !== null) {
    return false;
  }
  if (previousImageAssetsFromClassifier(classifier).length > 0) {
    return true;
  }
  return snapshots.some(snapshotHasAfter);
}

/** After fields or a picture record Redo can invert — the apply-time check. */
export function hasRedoableAfterState(
  snapshots: readonly BookEditAfterSnapshot[],
  classifier: unknown
): boolean {
  return bookEditRedoableMark(snapshots, classifier);
}

/**
 * Drop `undoneAt` / `redoable` / the after-delta stash rather than writing
 * them undefined. A leftover stash is yesterday's after; the next Undo
 * has to restamp from the live pages or Redo would put that extract back
 * over a different book.
 */
export function classifierAfterRedo(classifier: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(jsonRecord(classifier))) {
    if (key === "undoneAt" || key === "redoable" || key === STORY_DELTAS_AFTER_KEY) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

/** SQL NULL when the page had no extract; otherwise the stored JSON. */
export function storyDeltaToRestore(storyDelta: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return storyDelta == null ? Prisma.DbNull : (storyDelta as Prisma.InputJsonValue);
}

/**
 * Live `Page.storyDelta` is the after. Snapshot has no after column, so
 * once Undo writes `storyDeltaBefore` the rebuild folds the undone book
 * and Redo has nothing else that remembers what the edit extracted.
 *
 * JSON `null` for a page with no after extract — never `Prisma.DbNull`,
 * which is not JSON-safe on the classifier.
 */
export function storyDeltasAfterFromPages(
  pages: readonly { id: string; storyDelta?: unknown }[],
  pageIds: readonly string[]
): Record<string, unknown> {
  const byId = new Map(pages.map((page) => [page.id, page.storyDelta]));
  const stash: Record<string, unknown> = {};
  for (const pageId of pageIds) {
    const delta = byId.get(pageId);
    stash[pageId] = delta == null ? null : delta;
  }
  return stash;
}

export function storyDeltasAfterFromClassifier(classifier: unknown): Record<string, unknown> | undefined {
  const raw = jsonRecord(classifier)[STORY_DELTAS_AFTER_KEY];
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as Record<string, unknown>;
}

/**
 * Absent stash is a legacy undo — inventing an after would fold a book
 * Redo never saw. A stored null is a real empty extract, and leaving the
 * undone before standing keeps `Project.storyState` on the wrong fold.
 */
export function storyDeltaAfterToRestore(
  classifier: unknown,
  pageId: string
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  const stash = storyDeltasAfterFromClassifier(classifier);
  if (!stash || !Object.hasOwn(stash, pageId)) {
    return undefined;
  }
  return storyDeltaToRestore(stash[pageId]);
}
