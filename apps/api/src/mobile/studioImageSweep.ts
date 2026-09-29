import type { AppConfig } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { objectKey, objectStore, type StoredObject } from "@book-maker/storage";
import {
  isStudioImageReferenced,
  isSweptStudioImage,
  loadStudioImageReferences,
  type StudioImageSweepDb
} from "./studioImageReferences.js";

/**
 * Reclaims Writing Studio pictures the author has taken out of their book.
 *
 * Only `upload-…`, `cover-upload-…` and `studio-image-…` objects under
 * `images/<projectId>/` are ever candidates (`isSweptStudioImage`). Before
 * this, nothing but deleting the whole book removed one, so every photo an
 * author tried and took back out stayed in the bucket for the life of the
 * book.
 *
 * **What decides a deletion is a re-read of the rows, never an exception.** A
 * picture goes only when all of these hold, and every read that fails keeps
 * everything of that book for the next pass:
 *
 * 1. the object is older than the grace period (its S3 last-modified);
 * 2. the book's working copy has been quiet for the grace period — no
 *    `Manuscript`, `ManuscriptChapter` or `ManuscriptAssist` write;
 * 3. no row of the book names it (`loadStudioImageReferences`: chapters —
 *    soft-deleted ones and conflict copies included — versions, pages, chat
 *    undo snapshots live and archived, image assets, edit classifiers,
 *    inbox assists, moderation evidence);
 * 4. and, immediately before the delete, a second look agrees: the object is
 *    still old (HEAD), no row names it (re-read, narrowed to the candidate
 *    names), and the quiet stamp of (2) is unchanged — read **last**, so a
 *    save that landed during the pass is seen.
 *
 * **Why the grace period is 30 days, and why it is two rules.** The server
 * cannot see the references a device holds. The app debounces a chapter save
 * by ~1.2 s, and it writes every unsaved chapter to a device-local buffer
 * (`studio_local_drafts.dart`) that has **no expiry** — it is replayed the next
 * time *that chapter* is opened, after a crash, a dead battery or a week
 * offline. The editor's own undo stack and clipboard, and a second device's
 * stale buffer, can likewise put back a picture the server copy dropped. None
 * of that is bounded by anything the server knows, so no number is a proof;
 * the number bounds how long an author may be away from a failed save. Rule
 * (1) covers a fresh upload whose chapter never saved; rule (2) covers an
 * old picture removed recently (a removal that small writes no version, so
 * nothing else remembers it). Thirty days rather than fourteen because the
 * trade is lopsided: a kept orphan is one re-encoded picture costing a
 * fraction of a cent a month, a wrong delete is a hole in the author's own
 * book with nothing on the server to restore it from.
 *
 * **The window that remains.** (a) A device buffer, undo stack or pasted URL
 * that reaches the server more than 30 days after the book last changed,
 * naming a picture older than 30 days: the picture is gone and the page shows
 * a broken image. (b) A reference committed between this pass's last stamp
 * read and its S3 delete — milliseconds, one book at a time, and only by a
 * writer that is not the Studio (every Studio write moves the stamp, and every
 * server-side copy — undo, redo, publish, restore, derivation — copies from a
 * row this pass already counted). (c) The re-check narrows its text read to
 * rows containing a candidate's literal name, so a reference written in
 * percent-encoded form *during* the pass is seen only by the stamp.
 *
 * Cross-project references do not keep a picture: the exporters refuse to
 * print another project's image, and deleting a book deletes its prefix anyway.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const STUDIO_IMAGE_GRACE_MS = 30 * DAY_MS;

export type StudioImageSweepMode = "delete" | "dry-run";

/** `STUDIO_IMAGE_SWEEP`; unset means `delete` in production and `dry-run` everywhere else. */
export function studioImageSweepMode(config: Pick<AppConfig, "NODE_ENV" | "STUDIO_IMAGE_SWEEP">): StudioImageSweepMode | "off" {
  return config.STUDIO_IMAGE_SWEEP ?? (config.NODE_ENV === "production" ? "delete" : "dry-run");
}

export type StudioImageSweepLog = {
  info(detail: Record<string, unknown>, message: string): void;
  warn(detail: Record<string, unknown>, message: string): void;
};

export type StudioImageSweepOptions = {
  mode: StudioImageSweepMode;
  /** The last book (project id) an earlier pass finished; null starts from the first. */
  cursor: string | null;
  now?: () => Date;
  graceMs?: number;
  /** Books looked at per pass. */
  maxBooks?: number;
  /** Deletions (or, dry, would-be deletions) per pass. */
  maxDeletes?: number;
  /** Deletions per book per pass — also bounds the re-check's `OR` and the stamp-to-delete window. */
  maxDeletesPerBook?: number;
  /** Wall-clock budget; checked between books. */
  deadlineMs?: number;
  signal?: AbortSignal;
  db?: StudioImageSweepDb;
  log?: StudioImageSweepLog;
};

export type StudioImageSweepResult = {
  mode: StudioImageSweepMode;
  booksScanned: number;
  /** Where the next pass starts; null once the pass reached the last book. */
  nextCursor: string | null;
  /** Deleted — or, dry, the ones a real pass would have deleted. */
  reclaimed: number;
  reclaimedBytes: number;
  kept: {
    /** Younger than the grace period. */
    young: number;
    /** No last-modified time to prove its age. */
    undated: number;
    /** Its book's working copy changed within the grace period. */
    activeBook: number;
    /** A row names it. */
    referenced: number;
    /** A row named it on the re-check. */
    referencedOnRecheck: number;
    /** Rewritten (or gone) since it was listed. */
    rewritten: number;
    /** The book changed between the first read and the delete. */
    changedDuringPass: number;
    /** Left for the next pass by the per-pass or per-book budget. */
    overBudget: number;
    /** The delete itself failed. */
    deleteFailed: number;
  };
  /** Books whose listing or reads failed; everything of theirs was kept. */
  failedBooks: number;
};

type Book = { id: string; projectId: string };
type Candidate = { key: string; filename: string; size: number };
type Kept = StudioImageSweepResult["kept"];

/**
 * One bounded pass. Never throws: a failure inside a book keeps that book's
 * objects and is logged, and a failure listing the books ends the pass with
 * the cursor where it was.
 */
export async function sweepStudioImages(options: StudioImageSweepOptions): Promise<StudioImageSweepResult> {
  const db = options.db ?? prisma;
  const now = (options.now ?? (() => new Date()))();
  const graceMs = options.graceMs ?? STUDIO_IMAGE_GRACE_MS;
  const maxBooks = options.maxBooks ?? 50;
  const maxDeletesPerBook = options.maxDeletesPerBook ?? 100;
  const deadline = Date.now() + (options.deadlineMs ?? 60_000);
  let deletesLeft = options.maxDeletes ?? 500;
  const result: StudioImageSweepResult = {
    mode: options.mode,
    booksScanned: 0,
    nextCursor: options.cursor,
    reclaimed: 0,
    reclaimedBytes: 0,
    kept: {
      young: 0,
      undated: 0,
      activeBook: 0,
      referenced: 0,
      referencedOnRecheck: 0,
      rewritten: 0,
      changedDuringPass: 0,
      overBudget: 0,
      deleteFailed: 0
    },
    failedBooks: 0
  };

  let books: Book[];
  try {
    books = await db.manuscript.findMany({
      where: options.cursor ? { projectId: { gt: options.cursor } } : {},
      select: { id: true, projectId: true },
      orderBy: { projectId: "asc" },
      take: maxBooks
    });
  } catch (error) {
    options.log?.warn({ event: "studio_images.sweep_failed", err: error }, "Studio picture sweep could not list books");
    return result;
  }

  let finishedAll = books.length < maxBooks;
  for (const book of books) {
    if (options.signal?.aborted || Date.now() > deadline || deletesLeft <= 0) {
      finishedAll = false;
      break;
    }
    result.booksScanned += 1;
    let cutShort = false;
    try {
      const budget = Math.min(deletesLeft, maxDeletesPerBook);
      const outcome = await sweepBook(db, book, { mode: options.mode, now, graceMs, budget, kept: result.kept, log: options.log });
      result.reclaimed += outcome.reclaimed;
      result.reclaimedBytes += outcome.reclaimedBytes;
      deletesLeft -= outcome.reclaimed;
      // Holding the cursor is only worth it while it makes progress: a dry
      // run deletes nothing and a delete that keeps failing would pin every
      // later pass to this one book.
      cutShort = outcome.cutShort && options.mode === "delete" && outcome.reclaimed > 0;
    } catch (error) {
      result.failedBooks += 1;
      options.log?.warn(
        { event: "studio_images.sweep_declined", projectId: book.projectId, err: error },
        "Studio picture sweep kept a book's pictures after a failed read"
      );
    }
    if (cutShort) {
      // The next pass starts on this book again, for the pictures the budget left.
      finishedAll = false;
      break;
    }
    result.nextCursor = book.projectId;
  }
  if (finishedAll) {
    result.nextCursor = null;
  }
  return result;
}

async function sweepBook(
  db: StudioImageSweepDb,
  book: Book,
  context: {
    mode: StudioImageSweepMode;
    now: Date;
    graceMs: number;
    budget: number;
    kept: Kept;
    log: StudioImageSweepLog | undefined;
  }
): Promise<{ reclaimed: number; reclaimedBytes: number; cutShort: boolean }> {
  const { projectId } = book;
  const { kept } = context;
  const cutoff = context.now.getTime() - context.graceMs;
  const nothing = { reclaimed: 0, reclaimedBytes: 0, cutShort: false };

  const prefix = `${objectKey("images", projectId)}/`;
  const aged: Candidate[] = [];
  for (const object of await objectStore().list(prefix)) {
    const filename = object.key.slice(prefix.length);
    if (filename.includes("/") || !isSweptStudioImage(filename)) {
      continue;
    }
    const age = ageOf(object, cutoff);
    if (age === "undated") kept.undated += 1;
    else if (age === "young") kept.young += 1;
    else aged.push({ key: object.key, filename, size: object.size });
  }
  if (aged.length === 0) {
    return nothing;
  }

  const stamp = await quietStamp(db, book);
  if (!stamp) {
    // The book went away under the pass; deleting it removes its prefix.
    return nothing;
  }
  if (stamp.lastActivity >= cutoff) {
    kept.activeBook += aged.length;
    return nothing;
  }

  const readReferences = (needles: readonly string[]) =>
    loadStudioImageReferences(db, { projectId, manuscriptId: book.id, now: context.now, graceMs: context.graceMs, needles });
  const references = await readReferences(["images/"]);
  const unreferenced = aged.filter((candidate) => !isStudioImageReferenced(references, candidate.filename));
  kept.referenced += aged.length - unreferenced.length;
  if (unreferenced.length === 0) {
    return nothing;
  }
  const batch = unreferenced.slice(0, Math.max(0, context.budget));
  kept.overBudget += unreferenced.length - batch.length;
  const cutShort = batch.length < unreferenced.length;

  // The second look, cheapest first and the stamp last.
  const stillOld: Candidate[] = [];
  for (const candidate of batch) {
    const head = await objectStore().head(candidate.key);
    if (head && ageOf(head, cutoff) === "aged") stillOld.push({ ...candidate, size: head.size });
    else kept.rewritten += 1;
  }
  if (stillOld.length === 0) {
    return { ...nothing, cutShort };
  }
  const again = await readReferences(stillOld.map((candidate) => candidate.filename));
  const doomed = stillOld.filter((candidate) => !isStudioImageReferenced(again, candidate.filename));
  kept.referencedOnRecheck += stillOld.length - doomed.length;
  if (doomed.length === 0) {
    return { ...nothing, cutShort };
  }
  const restamp = await quietStamp(db, book);
  if (!restamp || restamp.signature !== stamp.signature) {
    kept.changedDuringPass += doomed.length;
    context.log?.info(
      { event: "studio_images.kept", projectId, reason: "book_changed_during_pass", count: doomed.length },
      "Studio picture sweep kept pictures of a book that changed under it"
    );
    return { ...nothing, cutShort };
  }

  let reclaimed = 0;
  let reclaimedBytes = 0;
  const reclaimedNames: string[] = [];
  for (const candidate of doomed) {
    if (context.mode === "delete") {
      try {
        await objectStore().delete(candidate.key);
      } catch (error) {
        kept.deleteFailed += 1;
        context.log?.warn(
          { event: "studio_images.delete_failed", projectId, filename: candidate.filename, err: error },
          "Studio picture sweep could not delete a picture"
        );
        continue;
      }
    }
    reclaimed += 1;
    reclaimedBytes += candidate.size;
    reclaimedNames.push(candidate.filename);
  }
  if (reclaimed > 0) {
    context.log?.info(
      {
        event: context.mode === "delete" ? "studio_images.reclaimed" : "studio_images.would_reclaim",
        projectId,
        filenames: reclaimedNames,
        bytes: reclaimedBytes
      },
      context.mode === "delete"
        ? "Studio pictures no row names any more were deleted"
        : "Studio pictures no row names any more would be deleted (dry run)"
    );
  }
  return { reclaimed, reclaimedBytes, cutShort };
}

function ageOf(object: Pick<StoredObject, "lastModified">, cutoff: number): "aged" | "young" | "undated" {
  if (!object.lastModified) return "undated";
  return object.lastModified.getTime() < cutoff ? "aged" : "young";
}

/**
 * When the working copy last changed, and a signature that moves with any
 * write to it. `Manuscript.revision` bumps on every chapter write, add,
 * delete, reorder and settings change; the chapter and assist clocks cover
 * the writes that bump no revision (a conflict recorded by derivation, an
 * assist applied).
 */
async function quietStamp(db: StudioImageSweepDb, book: Book): Promise<{ lastActivity: number; signature: string } | null> {
  const manuscript = await db.manuscript.findUnique({
    where: { id: book.id },
    select: { revision: true, updatedAt: true }
  });
  if (!manuscript) {
    return null;
  }
  const chapter = await db.manuscriptChapter.findFirst({
    where: { manuscriptId: book.id },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true }
  });
  const assist = await db.manuscriptAssist.findFirst({
    where: { projectId: book.projectId },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true }
  });
  const clocks = [manuscript.updatedAt, chapter?.updatedAt ?? null, assist?.updatedAt ?? null].map(
    (value) => value?.getTime() ?? 0
  );
  return { lastActivity: Math.max(...clocks), signature: [manuscript.revision, ...clocks].join(":") };
}

export type StudioImageSweeper = {
  /** Runs one pass now (or joins the one in flight). Never rejects. */
  runNow: () => Promise<StudioImageSweepResult | null>;
  /** Stops the timers, aborts the pass in flight between books and waits for it. */
  stop: () => Promise<void>;
};

/**
 * Paces the sweep in the API process, beside the chat-attachment retention
 * sweep it resembles. One pass at a time; the cursor lives in memory, so a
 * restart only starts the walk over.
 */
export function startStudioImageSweep(options: {
  mode: StudioImageSweepMode | "off";
  log: StudioImageSweepLog;
  intervalMs?: number;
  firstRunDelayMs?: number;
  /** Seam for tests; production runs the pass above. */
  sweep?: typeof sweepStudioImages;
}): StudioImageSweeper {
  const mode = options.mode;
  const sweep = options.sweep ?? sweepStudioImages;
  if (mode === "off") {
    return { runNow: async () => null, stop: async () => undefined };
  }
  const controller = new AbortController();
  let cursor: string | null = null;
  let inFlight: Promise<StudioImageSweepResult | null> | null = null;

  const pass = async (): Promise<StudioImageSweepResult | null> => {
    try {
      const result = await sweep({ mode, cursor, signal: controller.signal, log: options.log });
      cursor = result.nextCursor;
      const kept = result.kept;
      if (result.reclaimed > 0 || result.failedBooks > 0 || kept.changedDuringPass > 0 || kept.deleteFailed > 0) {
        options.log.info({ event: "studio_images.swept", ...result }, "Studio picture sweep pass finished");
      }
      return result;
    } catch (error) {
      options.log.warn({ event: "studio_images.sweep_failed", err: error }, "Studio picture sweep pass failed");
      return null;
    }
  };
  const runNow = (): Promise<StudioImageSweepResult | null> => {
    if (controller.signal.aborted) return Promise.resolve(null);
    inFlight ??= pass().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const first = setTimeout(() => void runNow(), options.firstRunDelayMs ?? 5 * 60 * 1000);
  first.unref();
  const timer = setInterval(() => void runNow(), options.intervalMs ?? 60 * 60 * 1000);
  timer.unref();

  return {
    runNow,
    stop: async () => {
      clearTimeout(first);
      clearInterval(timer);
      controller.abort();
      await inFlight;
    }
  };
}
