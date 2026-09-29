import { prisma } from "@book-maker/db";
import { UPLOADED_COVER_PREFIX, UPLOADED_IMAGE_PREFIX } from "./manuscript/manuscriptImages.js";

/**
 * Which Writing Studio pictures a book's rows still name — the read half of
 * the Studio picture sweep (`studioImageSweep.ts`).
 *
 * The sweep may only ever consider three kinds of object under
 * `images/<projectId>/`: an author's upload (`upload-<uuid>`), an uploaded
 * cover (`cover-upload-<uuid>`) and an AI Studio illustration
 * (`studio-image-<assistId>`, written by the worker's Illustrate in
 * `apps/worker/src/generation/writingAssistIllustration.ts`). Every other name
 * in that prefix — `cover.<ext>`, `chat-image-…` markers' `page-…` files,
 * generation images, reference sheets — belongs to machinery with its own
 * lifecycle and is never a candidate, whatever the rows say.
 *
 * A reference is an exact filename inside an `images/<projectId>/<filename>`
 * path of **this** project, both segments URL-decoded — the `/assets/images/…`
 * URL markdown and `ImageAsset.path` carry (bare or behind `PUBLIC_API_URL`),
 * and the `object://images/…` form provider inputs use. Another project's URL
 * is never a reference: the exporters refuse a cross-project picture
 * (`resolveBookImageAsset`), so nothing could print it anyway.
 *
 * Every question here leans the same way. Text that merely *might* name a
 * picture counts (trailing punctuation is also tried stripped), and a status
 * this module does not know is read as still open, because a kept orphan is a
 * few hundred kilobytes of storage while a deleted picture is gone from the
 * author's book for good.
 */

/** The AI Studio illustration's name; the worker spells the same literal. */
export const STUDIO_IMAGE_PREFIX = "studio-image-";

export const SWEPT_STUDIO_IMAGE_PREFIXES = [UPLOADED_IMAGE_PREFIX, UPLOADED_COVER_PREFIX, STUDIO_IMAGE_PREFIX] as const;

/** The filename rule of `GET /assets/images/:projectId/:filename` (`routes/projectAssets.ts`). */
const SERVABLE_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/;

/** Whether an object name under `images/<projectId>/` is one the sweep may consider at all. */
export function isSweptStudioImage(filename: string): boolean {
  return SERVABLE_FILENAME.test(filename) && SWEPT_STUDIO_IMAGE_PREFIXES.some((prefix) => filename.startsWith(prefix));
}

/**
 * `images/<segment>/<segment>`. A segment stops at anything a URL in markdown,
 * HTML or JSON is delimited by, and at `?`/`#`, so a cache-busting `?v=` or a
 * fragment never becomes part of the name.
 */
const IMAGE_PATH = /images\/([^/\s"'()<>[\]\\?#]+)\/([^/\s"'()<>[\]\\?#]+)/g;
/** Prose around a bare URL: "see /assets/images/p/upload-1.jpg." */
const TRAILING_PUNCTUATION = /[.,;:!*_~]+$/;

/** Adds every filename `text` names under this project's `images/<projectId>/`. */
export function addStudioImageReferences(text: string | null | undefined, projectId: string, into: Set<string>): void {
  if (!text || !text.includes("images/")) {
    return;
  }
  for (const match of text.matchAll(IMAGE_PATH)) {
    if (decodeSegment(match[1] ?? "") !== projectId) {
      continue;
    }
    const filename = decodeSegment(match[2] ?? "");
    into.add(filename);
    const trimmed = filename.replace(TRAILING_PUNCTUATION, "");
    if (trimmed && trimmed !== filename) {
      into.add(trimmed);
    }
  }
}

/** A filename that is not valid percent-encoding (`100%.png`) is its own name. */
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export type StudioImageReferences = {
  /** Exact filenames some row of the book names. */
  filenames: Set<string>;
  /** `studio-image-<assistId>` stems whose assist is still queued or drawing — the object may be mid-write. */
  pendingStems: Set<string>;
};

export function isStudioImageReferenced(references: StudioImageReferences, filename: string): boolean {
  if (references.filenames.has(filename)) {
    return true;
  }
  const dot = filename.lastIndexOf(".");
  return references.pendingStems.has(dot > 0 ? filename.slice(0, dot) : filename);
}

/** The Prisma delegates the sweep reads; tests hand it an in-memory stand-in. */
export type StudioImageSweepDb = Pick<
  typeof prisma,
  | "project"
  | "manuscript"
  | "manuscriptChapter"
  | "manuscriptVersion"
  | "manuscriptAssist"
  | "page"
  | "pageEditSnapshot"
  | "archivedPageEditSnapshot"
  | "imageAsset"
  | "bookEditOperation"
  | "moderationReport"
>;

/** Rows per read; a chapter or version row can hold 200k characters, so this is kept small. */
const ROW_BATCH = 50;

/** Assist statuses whose picture is settled either way: refunded or thrown away, never placed. */
const CLOSED_ASSIST_STATUSES = new Set(["DISMISSED", "FAILED"]);

/**
 * Every filename this book's rows name, read source by source.
 *
 * `needles` narrows the *text* columns to rows containing one of them (a SQL
 * `LIKE`, before the exact extractor runs): the full read passes `images/`,
 * which every reference contains, and the sweep's re-check passes the
 * candidate filenames themselves. JSON columns cannot be filtered that way and
 * are always read whole — they are small and per-book.
 *
 * Sources, and why each is one:
 * - `ManuscriptChapter` markdown, conflict copy and notes, **soft-deleted rows
 *   included** (restore brings them back); `Manuscript.settings`.
 * - `ManuscriptVersion` markdown — restoring a version brings its text back.
 * - `Page` markdown — the published book.
 * - `PageEditSnapshot` / `ArchivedPageEditSnapshot` before/after text — chat
 *   Undo and Redo write them back onto the page.
 * - `ImageAsset` path and metadata — an uploaded cover is the COVER row.
 * - `BookEditOperation.classifier` — `previousAssets` / `demotedAssets` hold
 *   the paths an image-edit Undo restores.
 * - `ManuscriptAssist.result` while READY (waiting in the author's inbox), or
 *   APPLIED within `graceMs` (the app placed it and its chapter save may still
 *   be in flight). QUEUED/RUNNING protects `studio-image-<id>` by name, since
 *   the worker may be writing it before any row says so. DISMISSED and FAILED
 *   name nothing.
 * - `ModerationReport.targetSnapshot` — a reported picture is evidence.
 * - `Project.mediaSettings`.
 */
export async function loadStudioImageReferences(
  db: StudioImageSweepDb,
  options: { projectId: string; manuscriptId: string; now: Date; graceMs: number; needles: readonly string[] }
): Promise<StudioImageReferences> {
  const { projectId, manuscriptId } = options;
  const references: StudioImageReferences = { filenames: new Set(), pendingStems: new Set() };
  const add = (value: unknown) => addStudioImageReferences(textOf(value), projectId, references.filenames);
  if (options.needles.length === 0) {
    throw new Error("A reference read needs at least one needle; an empty OR matches no row.");
  }
  const needles = options.needles;

  const settings = await db.manuscript.findUnique({ where: { id: manuscriptId }, select: { settings: true } });
  add(settings?.settings);
  const project = await db.project.findUnique({ where: { id: projectId }, select: { mediaSettings: true } });
  add(project?.mediaSettings);

  await eachBatch((after) =>
    db.manuscriptChapter.findMany({
      where: { manuscriptId, ...idAfter(after), OR: needles.flatMap((needle) => [
          { markdown: { contains: needle } },
          { conflictMarkdown: { contains: needle } },
          { notes: { contains: needle } }
        ]) },
      select: { id: true, markdown: true, conflictMarkdown: true, notes: true },
      orderBy: { id: "asc" },
      take: ROW_BATCH
    }), (row) => {
    add(row.markdown);
    add(row.conflictMarkdown);
    add(row.notes);
  });

  const chapterIds = (
    await db.manuscriptChapter.findMany({ where: { manuscriptId }, select: { id: true } })
  ).map((row) => row.id);
  if (chapterIds.length > 0) {
    await eachBatch((after) =>
      db.manuscriptVersion.findMany({
        where: {
          chapterId: { in: chapterIds },
          ...idAfter(after),
          OR: needles.map((needle) => ({ markdown: { contains: needle } }))
        },
        select: { id: true, markdown: true },
        orderBy: { id: "asc" },
        take: ROW_BATCH
      }), (row) => add(row.markdown));
  }

  await eachBatch((after) =>
    db.page.findMany({
      where: { projectId, ...idAfter(after), OR: needles.map((needle) => ({ markdown: { contains: needle } })) },
      select: { id: true, markdown: true },
      orderBy: { id: "asc" },
      take: ROW_BATCH
    }), (row) => add(row.markdown));

  await eachBatch((after) =>
    db.pageEditSnapshot.findMany({
      where: { projectId, ...idAfter(after), OR: needles.flatMap((needle) => [
          { markdownBefore: { contains: needle } },
          { markdownAfter: { contains: needle } }
        ]) },
      select: { id: true, markdownBefore: true, markdownAfter: true },
      orderBy: { id: "asc" },
      take: ROW_BATCH
    }), (row) => {
    add(row.markdownBefore);
    add(row.markdownAfter);
  });

  await eachBatch((after) =>
    db.archivedPageEditSnapshot.findMany({
      where: { projectId, ...idAfter(after), OR: needles.flatMap((needle) => [
          { markdownBefore: { contains: needle } },
          { markdownAfter: { contains: needle } }
        ]) },
      select: { id: true, markdownBefore: true, markdownAfter: true },
      orderBy: { id: "asc" },
      take: ROW_BATCH
    }), (row) => {
    add(row.markdownBefore);
    add(row.markdownAfter);
  });

  await eachBatch((after) =>
    db.imageAsset.findMany({
      where: { projectId, ...idAfter(after) },
      select: { id: true, path: true, metadata: true },
      orderBy: { id: "asc" },
      take: ROW_BATCH
    }), (row) => {
    add(row.path);
    add(row.metadata);
  });

  await eachBatch((after) =>
    db.bookEditOperation.findMany({
      where: { projectId, ...idAfter(after) },
      select: { id: true, classifier: true },
      orderBy: { id: "asc" },
      take: ROW_BATCH
    }), (row) => add(row.classifier));

  const appliedSince = options.now.getTime() - options.graceMs;
  await eachBatch((after) =>
    db.manuscriptAssist.findMany({
      where: { projectId, ...idAfter(after) },
      select: { id: true, status: true, result: true, updatedAt: true },
      orderBy: { id: "asc" },
      take: ROW_BATCH
    }), (row) => {
    if (CLOSED_ASSIST_STATUSES.has(row.status)) {
      return;
    }
    if (row.status === "APPLIED") {
      if (row.updatedAt.getTime() >= appliedSince) add(row.result);
      return;
    }
    add(row.result);
    if (row.status !== "READY") {
      // QUEUED, RUNNING, or a status this build does not know: still open.
      references.pendingStems.add(`${STUDIO_IMAGE_PREFIX}${row.id}`);
    }
  });

  await eachBatch((after) =>
    db.moderationReport.findMany({
      where: { projectId, ...idAfter(after) },
      select: { id: true, targetSnapshot: true },
      orderBy: { id: "asc" },
      take: ROW_BATCH
    }), (row) => {
    add(row.targetSnapshot);
    // An IMAGE_ASSET report stores the bare filename beside the project id.
    const snapshot = row.targetSnapshot;
    if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
      const filename = (snapshot as Record<string, unknown>).filename;
      if (typeof filename === "string" && filename) references.filenames.add(filename);
    }
  });

  return references;
}

function idAfter(after: string | null): { id?: { gt: string } } {
  return after ? { id: { gt: after } } : {};
}

/** Walks one source in id order, `ROW_BATCH` rows at a time, so no read holds a whole book's history. */
async function eachBatch<Row extends { id: string }>(
  read: (after: string | null) => Promise<Row[]>,
  visit: (row: Row) => void
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const rows = await read(after);
    for (const row of rows) {
      visit(row);
    }
    if (rows.length < ROW_BATCH) {
      return;
    }
    after = rows[rows.length - 1]!.id;
  }
}

function textOf(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}
