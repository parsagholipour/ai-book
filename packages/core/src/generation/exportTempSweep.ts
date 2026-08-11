import { randomUUID } from "node:crypto";
import type { Dir, Dirent, Stats } from "node:fs";
import { lstat, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * The garbage collector for the scratch files a render and a publication leave
 * behind, and the one rule that keeps it from eating a live book.
 *
 * Three artifact families are written beside their destinations and moved or
 * removed at the end of the work that made them: `.book-<uuid>.{md,pdf,epub}`
 * plus `.book-<uuid>.{pdf,epub}.provenance.json` inside a project directory (a
 * compile rendering beside `book.pdf`, and the API's inline rebuild doing the
 * same), the corresponding `.book-superseded-<uuid>.*` predecessors a
 * publication parks while it moves in, and
 * `.book-render-<uuid>.html` at the root of the image store (the document
 * Chrome reads off disk). Every one of them is removed by a `finally`, which
 * covers a thrown render, a rejected claim and a failed publication — and
 * covers nothing at all when the process does not get to run it. A SIGKILL,
 * an OOM kill, a container evicted mid-compile: the file stays for as long as
 * the volume does, and a stranded 40 MB PDF beside a book nobody is compiling
 * is invisible until storage fills.
 *
 * So there is a sweep, and it is **age-based only**. It is emphatically not a
 * startup wipe: a rolling deploy runs the old worker and the new one at once,
 * `make up` and `pnpm dev` share a storage directory, and the API renders into
 * the same project directories the worker does — so "this process just started,
 * therefore nothing here is live" is false in every deployment this repo has.
 * The only thing that separates an abandoned scratch file from one being
 * written right now is how long it has sat untouched, which is why the minimum
 * age is clamped to a floor no configuration can lower past
 * (`EXPORT_TEMP_MIN_AGE_FLOOR_MS`) and defaults to hours rather than minutes.
 * A render is bounded by the browser pool's 90-second watchdog and a compile by
 * its own job; six hours is not a guess at how long they take, it is a bet that
 * nothing legitimate is quiet for a quarter of a day.
 *
 * What it deletes is named exactly, never globbed: the prefix, the literal
 * token shape `randomUUID()` produces, and the extension the writer used.
 * Anything else in these directories — `book.pdf`, its provenance record, a
 * project's illustrations, an operator's stray file — does not match and is
 * never a candidate. Nor is anything that is not a plain file: the scan reads
 * directory entries without following them, requires a regular file at both the
 * dirent and the `lstat`, and removes it with `unlink`, which resolves no final
 * symlink. A symlink named like a scratch file is skipped rather than followed,
 * so nothing outside these directories can be reached through one.
 *
 * The timestamp is read twice — once to decide, once immediately before the
 * unlink — and a file whose identity or mtime moved in between is put back on
 * the shelf. That does not make the check atomic (nothing available here does),
 * it makes the window a pair of adjacent syscalls rather than the length of a
 * whole directory scan, which is what a slow writer would otherwise be racing.
 * The clock is read once per sweep, so a long scan can only make files look
 * *younger* than they are, and a timestamp in the future (clock skew, a
 * restored volume) is a negative age, which is never stale.
 *
 * Every sweep is bounded: a budget of directory entries, a cap that stops one
 * enormous directory from starving the other, and a cursor so a truncated sweep
 * resumes where it stopped rather than re-scanning the same prefix forever.
 * Directories are streamed with `opendir` rather than materialized with
 * `readdir`, so memory does not scale with the store. Permission and
 * ENOENT-shaped failures are counted, not thrown: a sweep that cannot read one
 * project must still clean the rest, and a file that vanished under it is the
 * other end of the race working as intended.
 */

/** The prefix every scratch artifact in this scheme carries. */
export const EXPORT_TEMP_PREFIX = ".book-";

/** Token prefix for the predecessors a publication parks while it moves in. */
export const SUPERSEDED_EXPORT_TOKEN_PREFIX = "superseded-";

/** Token prefix for the HTML document a PDF render hands to Chrome. */
export const RENDER_DOCUMENT_TOKEN_PREFIX = "render-";

/** The extensions a compile renders beside `book.md`/`book.pdf`/`book.epub`. */
const PENDING_EXPORT_EXTENSIONS = ["md", "pdf", "epub"] as const;

/** Metadata staged and parked through the same publication transaction. */
const PENDING_EXPORT_PROVENANCE_SUFFIXES = ["pdf.provenance.json", "epub.provenance.json"] as const;

const PENDING_EXPORT_SUFFIXES = [...PENDING_EXPORT_EXTENSIONS, ...PENDING_EXPORT_PROVENANCE_SUFFIXES];

export type PendingExportExtension = (typeof PENDING_EXPORT_EXTENSIONS)[number];

/**
 * The shape `randomUUID()` writes, and nothing looser. A name is only ours if
 * it carries one of these where the token goes — which is what keeps the sweep
 * off `book.pdf`, off `.book-keep-this.pdf`, and off anything an operator left
 * in a project directory by hand.
 */
const TEMP_TOKEN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tempNamePattern(tokenPrefix: string, suffixes: readonly string[]): RegExp {
  return new RegExp(
    `^${escapeForPattern(EXPORT_TEMP_PREFIX)}${escapeForPattern(tokenPrefix)}${TEMP_TOKEN}\\.(?:${suffixes
      .map(escapeForPattern)
      .join("|")})$`,
    "i"
  );
}

const PENDING_EXPORT_NAME = tempNamePattern("", PENDING_EXPORT_SUFFIXES);
const SUPERSEDED_EXPORT_NAME = tempNamePattern(SUPERSEDED_EXPORT_TOKEN_PREFIX, PENDING_EXPORT_SUFFIXES);
const RENDER_DOCUMENT_NAME = tempNamePattern(RENDER_DOCUMENT_TOKEN_PREFIX, ["html"]);

/** A scratch export or a parked predecessor inside a project directory. */
export function isPendingExportTempName(name: string): boolean {
  return PENDING_EXPORT_NAME.test(name) || SUPERSEDED_EXPORT_NAME.test(name);
}

/** The HTML document a PDF render writes into the image store. */
export function isRenderDocumentTempName(name: string): boolean {
  return RENDER_DOCUMENT_NAME.test(name);
}

/**
 * Where a PDF render writes the document Chrome opens.
 *
 * Built here rather than at the call site so the sweep's pattern and the
 * writer's name cannot drift apart: a rename on one side fails the other's
 * test rather than silently stranding files nothing recognises.
 */
export function renderDocumentTempPath(imageStorageDir: string, token: string = randomUUID()): string {
  return join(imageStorageDir, `${EXPORT_TEMP_PREFIX}${RENDER_DOCUMENT_TOKEN_PREFIX}${token}.html`);
}

/**
 * Where a compile or an inline rebuild renders one artifact, beside the
 * published name it is going to take.
 *
 * Every writer of these goes through here for the same reason the render
 * document does: there are three of them — the worker's compile, the worker's
 * parked predecessors, the API's inline rebuild — in two apps, and a name built
 * from a local literal is a name this module's patterns can stop matching
 * without anything failing. A file nothing recognises is not a bug that shows
 * up as a test failure; it is disk that is never reclaimed.
 *
 * The token defaults to `randomUUID()` because that is the shape the patterns
 * accept: named per render, since two compiles of one project overlapping is
 * the case the publication protocol exists for, and a shared scratch name would
 * have them writing over each other.
 */
export function pendingExportTempPath(
  projectDir: string,
  extension: PendingExportExtension,
  token: string = randomUUID()
): string {
  return join(projectDir, `${EXPORT_TEMP_PREFIX}${token}.${extension}`);
}

/** The token a publication parks a predecessor under. */
export function supersededExportToken(token: string = randomUUID()): string {
  return `${SUPERSEDED_EXPORT_TOKEN_PREFIX}${token}`;
}

/**
 * How long a scratch file must sit untouched before it is assumed abandoned.
 *
 * Well past any render (bounded by the browser pool watchdog) or compile (final
 * QA, reader chapters, a Chromium render, an EPUB), because the cost of waiting
 * is disk and the cost of being wrong is a book.
 */
export const DEFAULT_EXPORT_TEMP_MIN_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * The floor no configuration may go under. An operator tuning this down to
 * "clean up faster" would otherwise be deleting the compile that is running.
 */
export const EXPORT_TEMP_MIN_AGE_FLOOR_MS = 30 * 60 * 1000;

/** Directory entries one sweep may examine, across every directory it visits. */
const DEFAULT_MAX_ENTRIES = 20_000;

export type ExportTempSweepCursor = {
  /** Offset into the book store's project listing to resume from. */
  bookStorage: number;
  /** Offset into the image store's root listing to resume from. */
  imageStorage: number;
  /**
   * Offset inside the project at `bookStorage`, when that directory itself did
   * not fit in one pass. Optional so cursors persisted by older releases still
   * resume with the original start-of-project behaviour.
   */
  bookProject?: {
    projectName: string;
    entry: number;
  };
};

export const EXPORT_TEMP_SWEEP_START: ExportTempSweepCursor = { bookStorage: 0, imageStorage: 0 };

export type ExportTempSweepResult = {
  scannedEntries: number;
  deletedFiles: number;
  reclaimedBytes: number;
  /** Matched the name but was too young, or moved under the sweep. */
  keptLive: number;
  /** Matched the name but was not a regular file — a symlink, a directory. */
  skippedIrregular: number;
  errors: number;
  errorsByCode: Record<string, number>;
  /** The entry budget ran out; `nextCursor` says where to resume. */
  truncated: boolean;
  aborted: boolean;
  nextCursor: ExportTempSweepCursor;
};

export type ExportTempSweepOptions = {
  bookStorageDir: string;
  imageStorageDir: string;
  /** Clamped up to `EXPORT_TEMP_MIN_AGE_FLOOR_MS`. */
  minAgeMs?: number;
  maxEntries?: number;
  cursor?: ExportTempSweepCursor;
  now?: () => number;
  signal?: AbortSignal;
};

type SweepContext = {
  result: ExportTempSweepResult;
  budget: number;
  minAgeMs: number;
  now: number;
  signal: AbortSignal | undefined;
};

/**
 * Removes abandoned scratch artifacts from both storage roots.
 *
 * Resolves rather than rejects: this is housekeeping running beside real work,
 * and everything it could not do is in the result instead.
 */
export async function sweepStaleExportTempFiles(
  options: ExportTempSweepOptions
): Promise<ExportTempSweepResult> {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const ctx: SweepContext = {
    result: {
      scannedEntries: 0,
      deletedFiles: 0,
      reclaimedBytes: 0,
      keptLive: 0,
      skippedIrregular: 0,
      errors: 0,
      errorsByCode: {},
      truncated: false,
      aborted: false,
      nextCursor: { ...EXPORT_TEMP_SWEEP_START }
    },
    budget: maxEntries,
    minAgeMs: Math.max(options.minAgeMs ?? DEFAULT_EXPORT_TEMP_MIN_AGE_MS, EXPORT_TEMP_MIN_AGE_FLOOR_MS),
    // Once per sweep: a scan that takes minutes may only make files look
    // younger than they are, never older.
    now: (options.now ?? Date.now)(),
    signal: options.signal
  };
  const cursor = options.cursor ?? EXPORT_TEMP_SWEEP_START;

  // The image store first, but capped at half the budget: its root holds one
  // directory per illustrated project, and a store large enough to exhaust the
  // budget there would otherwise starve the project scan for good.
  const imageScan = await scanDirectory(options.imageStorageDir, ctx, {
    cursor: cursor.imageStorage,
    cap: Math.ceil(maxEntries / 2),
    onEntry: async (entry, path) => {
      if (isRenderDocumentTempName(entry.name)) {
        await removeAbandonedTempFile(entry, path, ctx);
      }
    }
  });
  ctx.result.nextCursor.imageStorage = imageScan.cursor;

  // Nothing to spend and nothing to spend it on. Entering the scan anyway would
  // still return the cursor untouched — the skip runs before the budget check —
  // but it would read a whole project listing to get there, which at shutdown is
  // exactly the I/O the abort was raised to stop.
  if (ctx.result.aborted || ctx.budget <= 0) {
    ctx.result.nextCursor.bookStorage = cursor.bookStorage;
    if (cursor.bookProject) {
      ctx.result.nextCursor.bookProject = { ...cursor.bookProject };
    }
    // A budget spent entirely on the image store leaves the project scan for the
    // next pass, which is the truncation this flag reports even though no
    // listing was cut short mid-read.
    ctx.result.truncated = ctx.result.truncated || !ctx.result.aborted;
    return ctx.result;
  }

  let pausedProject:
    | { bookStorage: number; projectName: string; entry: number }
    | undefined;
  let resumedProjectVisited = false;
  const bookScan = await scanDirectory(options.bookStorageDir, ctx, {
    cursor: cursor.bookStorage,
    cap: ctx.budget,
    onEntry: async (entry, path, index) => {
      if (index === cursor.bookStorage) {
        resumedProjectVisited = true;
      }
      // Only a real directory, so a symlink planted at the root of the book
      // store cannot walk the sweep somewhere else entirely.
      if (!entry.isDirectory()) {
        return;
      }
      const projectCursor =
        index === cursor.bookStorage && cursor.bookProject?.projectName === entry.name
          ? cursor.bookProject.entry
          : 0;
      const projectScan = await scanDirectory(path, ctx, {
        cursor: projectCursor,
        cap: ctx.budget,
        onEntry: async (projectEntry, projectPath) => {
          if (isPendingExportTempName(projectEntry.name)) {
            await removeAbandonedTempFile(projectEntry, projectPath, ctx);
          }
        }
      });
      if (!projectScan.complete) {
        pausedProject = {
          bookStorage: index,
          projectName: entry.name,
          entry: projectScan.cursor
        };
      }
    }
  });

  if (pausedProject) {
    ctx.result.nextCursor.bookStorage = pausedProject.bookStorage;
    ctx.result.nextCursor.bookProject = {
      projectName: pausedProject.projectName,
      entry: pausedProject.entry
    };
  } else {
    ctx.result.nextCursor.bookStorage = bookScan.cursor;
    // If shutdown stopped the root scan before it reached the project it was
    // resuming, retain the inner position too. Once that entry was visited (or
    // the listing ended), the nested cursor has either completed or gone stale.
    if (!resumedProjectVisited && !bookScan.complete && cursor.bookProject) {
      ctx.result.nextCursor.bookProject = { ...cursor.bookProject };
    }
  }

  return ctx.result;
}

type DirectoryScan = {
  cursor: number;
  cap: number;
  onEntry: (entry: Dirent, path: string, index: number) => Promise<void>;
};

type DirectoryScanResult = {
  /** Position of the first unexamined entry, or 0 after the listing ends. */
  cursor: number;
  complete: boolean;
};

/**
 * Streams one directory, spending the sweep's budget, and returns where to
 * resume plus whether the listing ran out: the position of the first entry it
 * did not get to, or 0 after a complete listing (so the next sweep starts at
 * the top).
 *
 * A resumed scan skips by position, which is only as stable as the filesystem's
 * own listing order — entries added or removed in between can shift it. That is
 * fine for a collector whose worst case is waiting one more interval: it makes
 * a truncated sweep move forward instead of re-scanning the same prefix, it is
 * not a promise about which entries a given pass sees.
 */
async function scanDirectory(
  dir: string,
  ctx: SweepContext,
  scan: DirectoryScan
): Promise<DirectoryScanResult> {
  const handle = await openDirectory(dir, ctx);
  if (!handle) {
    return { cursor: 0, complete: true };
  }
  let position = 0;
  let examined = 0;
  try {
    for (;;) {
      const entry = await readDirectoryEntry(handle, ctx);
      if (!entry) {
        return { cursor: 0, complete: true };
      }
      const index = position++;
      if (index < scan.cursor) {
        continue;
      }
      if (ctx.signal?.aborted) {
        ctx.result.aborted = true;
        return { cursor: index, complete: false };
      }
      if (ctx.budget <= 0 || examined >= scan.cap) {
        ctx.result.truncated = true;
        return { cursor: index, complete: false };
      }
      examined += 1;
      ctx.budget -= 1;
      ctx.result.scannedEntries += 1;
      // A dirent name can hold no separator, and the patterns above are
      // anchored, so the join below cannot leave `dir`.
      await scan.onEntry(entry, join(dir, entry.name), index);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function openDirectory(dir: string, ctx: SweepContext): Promise<Dir | null> {
  try {
    return await opendir(dir);
  } catch (error) {
    recordError(error, ctx);
    return null;
  }
}

async function readDirectoryEntry(handle: Dir, ctx: SweepContext): Promise<Dirent | null> {
  try {
    return await handle.read();
  } catch (error) {
    // A directory that stopped being readable mid-scan ends this listing rather
    // than the sweep; the next pass starts it again from the top.
    recordError(error, ctx);
    return null;
  }
}

/**
 * Deletes one matched artifact, if it is still a plain file and still cold.
 *
 * The dirent's type is checked before the `lstat` and again after it, because
 * the dirent is what the kernel handed back during the listing and the `lstat`
 * is what is true now — and neither follows a symlink, which is the point.
 */
async function removeAbandonedTempFile(entry: Dirent, path: string, ctx: SweepContext): Promise<void> {
  if (!entry.isFile()) {
    ctx.result.skippedIrregular += 1;
    return;
  }
  const observed = await statTempFile(path, ctx);
  if (!observed) {
    return;
  }
  if (!observed.isFile()) {
    ctx.result.skippedIrregular += 1;
    return;
  }
  if (!isAbandoned(observed, ctx)) {
    ctx.result.keptLive += 1;
    return;
  }
  // Read again immediately before the unlink. A whole directory scan can pass
  // between the decision and the delete; two adjacent syscalls cannot, so a
  // writer that touched the file in between is seen here and left alone.
  const confirmed = await statTempFile(path, ctx);
  if (!confirmed) {
    return;
  }
  if (!confirmed.isFile() || !isSameFile(observed, confirmed) || !isAbandoned(confirmed, ctx)) {
    ctx.result.keptLive += 1;
    return;
  }
  try {
    // `unlink`, never `rm -r`: it removes this name and resolves no symlink at
    // it, so nothing outside this directory is reachable from here.
    await unlink(path);
    ctx.result.deletedFiles += 1;
    ctx.result.reclaimedBytes += confirmed.size;
  } catch (error) {
    recordError(error, ctx);
  }
}

async function statTempFile(path: string, ctx: SweepContext): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    recordError(error, ctx);
    return null;
  }
}

/**
 * Whether nothing has touched this file for the whole retention window.
 *
 * `ctime` counts alongside `mtime`: it moves on every write and on every
 * metadata change, it cannot be backdated by a process that can set `mtime`,
 * and taking the newer of the two can only ever keep a file longer.
 */
function isAbandoned(stats: Stats, ctx: SweepContext): boolean {
  const touchedAt = Math.max(stats.mtimeMs, stats.ctimeMs);
  const age = ctx.now - touchedAt;
  // A future timestamp — clock skew, a restored volume — is a negative age, and
  // NaN fails this too. Both mean "not known to be old", which means keep.
  return Number.isFinite(age) && age >= ctx.minAgeMs;
}

function isSameFile(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.size === after.size
  );
}

function recordError(error: unknown, ctx: SweepContext): void {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") {
    // Someone else's cleanup, or the owning process's own `finally`, got here
    // first. That is the design working, not a failure.
    return;
  }
  ctx.result.errors += 1;
  const key = code ?? "UNKNOWN";
  ctx.result.errorsByCode[key] = (ctx.result.errorsByCode[key] ?? 0) + 1;
}
