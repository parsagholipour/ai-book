import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_TEMP_MIN_AGE_MS,
  EXPORT_TEMP_MIN_AGE_FLOOR_MS,
  isPendingExportTempName,
  isRenderDocumentTempName,
  pendingExportTempPath,
  renderDocumentTempPath,
  supersededExportToken,
  sweepStaleExportTempFiles,
  type ExportTempSweepCursor
} from "./exportTempSweep.js";

const HOUR = 60 * 60 * 1000;

describe("export temp sweep", () => {
  let root: string;
  let books: string;
  let images: string;
  /** The clock the sweep is handed, so a file's age is set rather than waited out. */
  let clock: number;

  const at = (offsetMs: number) => () => clock + offsetMs;

  const sweep = (overrides: Partial<Parameters<typeof sweepStaleExportTempFiles>[0]> = {}) =>
    sweepStaleExportTempFiles({
      bookStorageDir: books,
      imageStorageDir: images,
      now: at(0),
      ...overrides
    });

  const projectDir = (projectId: string) => {
    const dir = join(books, projectId);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const write = (dir: string, name: string, contents = "scratch") => {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  };

  const scratchExport = (dir: string, extension: string, token = randomUUID()) =>
    write(dir, `.book-${token}.${extension}`);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "book-maker-export-temp-"));
    books = join(root, "books");
    images = join(root, "images");
    mkdirSync(books);
    mkdirSync(images);
    clock = Date.now();
  });

  afterEach(() => {
    // A permissions test leaves a directory unreadable; put it back so the tree
    // can be removed.
    for (const entry of ["books/locked"]) {
      const path = join(root, entry);
      if (existsSync(path)) {
        chmodSync(path, 0o700);
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  describe("name matching", () => {
    it("recognises exactly the artifacts this scheme writes", () => {
      const token = randomUUID();
      expect(isPendingExportTempName(`.book-${token}.pdf`)).toBe(true);
      expect(isPendingExportTempName(`.book-${token}.md`)).toBe(true);
      expect(isPendingExportTempName(`.book-${token}.epub`)).toBe(true);
      expect(isPendingExportTempName(`.book-${token}.pdf.provenance.json`)).toBe(true);
      expect(isPendingExportTempName(`.book-${token}.epub.provenance.json`)).toBe(true);
      expect(isPendingExportTempName(`.book-superseded-${token}.pdf`)).toBe(true);
      expect(isPendingExportTempName(`.book-superseded-${token}.pdf.provenance.json`)).toBe(true);
      expect(isPendingExportTempName(`.book-superseded-${token}.epub.provenance.json`)).toBe(true);
      expect(isRenderDocumentTempName(`.book-render-${token}.html`)).toBe(true);
    });

    it("recognises nothing else, so a real book is never a candidate", () => {
      const token = randomUUID();
      for (const name of [
        "book.pdf",
        "book.md",
        "book.epub",
        "book.pdf.provenance.json",
        "book.epub.provenance.json",
        "cover.jpg",
        `book-${token}.pdf`,
        ".book-scratch.pdf",
        `.book-${token}.txt`,
        `.book-${token}`,
        `.book-render-${token}.pdf`,
        `.book-${token}.pdf.bak`,
        `.book-${token}.md.provenance.json`,
        `.book-${token}.pdf.provenance.json.bak`,
        `.book-${token}.pdfXprovenanceXjson`,
        ".book-.pdf"
      ]) {
        expect(isPendingExportTempName(name), name).toBe(false);
        expect(isRenderDocumentTempName(name), name).toBe(false);
      }
    });

    it("names the render document where the sweep will look for it", () => {
      const path = renderDocumentTempPath(images);
      expect(path.startsWith(`${images}/`)).toBe(true);
      expect(isRenderDocumentTempName(path.slice(images.length + 1))).toBe(true);
    });

    it("names every scratch export so its own sweep recognises it", () => {
      // The drift this closes is silent: a writer whose name stops matching
      // strands files nothing collects, and nothing fails.
      for (const extension of ["md", "pdf", "epub"] as const) {
        expect(isPendingExportTempName(basename(pendingExportTempPath("/books/p", extension)))).toBe(true);
        expect(
          isPendingExportTempName(basename(pendingExportTempPath("/books/p", extension, supersededExportToken())))
        ).toBe(true);
      }
    });

    it("sweeps a file written at the path the builders hand out", async () => {
      const dir = projectDir("project-1");
      const pending = pendingExportTempPath(dir, "pdf");
      const parked = pendingExportTempPath(dir, "epub", supersededExportToken());
      const pendingProvenance = `${pending}.provenance.json`;
      const parkedProvenance = `${parked}.provenance.json`;
      writeFileSync(pending, "%PDF-scratch");
      writeFileSync(parked, "epub");
      writeFileSync(pendingProvenance, "{}");
      writeFileSync(parkedProvenance, "{}");

      const result = await sweep({ now: at(7 * HOUR) });

      expect(result.deletedFiles).toBe(4);
      expect(existsSync(pending)).toBe(false);
      expect(existsSync(parked)).toBe(false);
      expect(existsSync(pendingProvenance)).toBe(false);
      expect(existsSync(parkedProvenance)).toBe(false);
    });
  });

  describe("age", () => {
    it("deletes scratch exports and render documents that have sat untouched past the window", async () => {
      const dir = projectDir("project-1");
      const pdf = scratchExport(dir, "pdf", randomUUID());
      const markdown = scratchExport(dir, "md", `superseded-${randomUUID()}`);
      const document = renderDocumentTempPath(images);
      writeFileSync(document, "<html></html>");

      const result = await sweep({ now: at(7 * HOUR) });

      expect(result.deletedFiles).toBe(3);
      expect(result.reclaimedBytes).toBeGreaterThan(0);
      expect(result.errors).toBe(0);
      expect(existsSync(pdf)).toBe(false);
      expect(existsSync(markdown)).toBe(false);
      expect(existsSync(document)).toBe(false);
    });

    it("keeps a render that is still running, and everything that is not scratch at all", async () => {
      const dir = projectDir("project-1");
      const live = scratchExport(dir, "pdf");
      const document = renderDocumentTempPath(images);
      writeFileSync(document, "<html></html>");
      const published = write(dir, "book.pdf", "%PDF-published");
      const provenance = write(dir, "book.pdf.provenance.json", "{}");
      const epubProvenance = write(dir, "book.epub.provenance.json", "{}");
      const imageDir = join(images, "project-1");
      mkdirSync(imageDir);
      const illustration = write(imageDir, "page-1.png", "png");

      const result = await sweep({ now: at(DEFAULT_EXPORT_TEMP_MIN_AGE_MS - 60_000) });

      expect(result.deletedFiles).toBe(0);
      expect(result.keptLive).toBe(2);
      for (const path of [live, document, published, provenance, epubProvenance, illustration]) {
        expect(existsSync(path), path).toBe(true);
      }
    });

    it("cannot be configured below the floor that protects a live compile", async () => {
      const dir = projectDir("project-1");
      const scratch = scratchExport(dir, "pdf");

      const eager = await sweep({ minAgeMs: 0, now: at(EXPORT_TEMP_MIN_AGE_FLOOR_MS - 60_000) });
      expect(eager.deletedFiles).toBe(0);
      expect(existsSync(scratch)).toBe(true);

      const past = await sweep({ minAgeMs: 0, now: at(EXPORT_TEMP_MIN_AGE_FLOOR_MS + 60_000) });
      expect(past.deletedFiles).toBe(1);
      expect(existsSync(scratch)).toBe(false);
    });

    it("keeps a file whose mtime was backdated, because ctime cannot be", async () => {
      const dir = projectDir("project-1");
      const scratch = scratchExport(dir, "pdf");
      const longAgo = new Date(clock - 30 * 24 * HOUR);
      utimesSync(scratch, longAgo, longAgo);
      expect(statSync(scratch).mtimeMs).toBeLessThan(clock - 29 * 24 * HOUR);

      const result = await sweep();

      expect(result.deletedFiles).toBe(0);
      expect(result.keptLive).toBe(1);
      expect(existsSync(scratch)).toBe(true);
    });

    it("keeps a file stamped in the future rather than reading skew as age", async () => {
      const dir = projectDir("project-1");
      const scratch = scratchExport(dir, "pdf");
      const ahead = new Date(clock + 24 * HOUR);
      utimesSync(scratch, ahead, ahead);

      const result = await sweep({ now: at(7 * HOUR) });

      expect(result.deletedFiles).toBe(0);
      expect(existsSync(scratch)).toBe(true);
    });
  });

  describe("path safety", () => {
    it("never follows a symlink wearing a scratch file's name", async () => {
      const secret = write(root, "secret.txt", "provider keys");
      const dir = projectDir("project-1");
      const link = join(dir, `.book-${randomUUID()}.pdf`);
      symlinkSync(secret, link);

      const result = await sweep({ now: at(7 * HOUR) });

      expect(result.deletedFiles).toBe(0);
      expect(result.skippedIrregular).toBe(1);
      expect(existsSync(secret)).toBe(true);
      // The link is left alone too: it is not a file this scheme wrote.
      expect(existsSync(link)).toBe(true);
    });

    it("does not descend through a symlinked project directory", async () => {
      const outside = join(root, "outside");
      mkdirSync(outside);
      const scratch = scratchExport(outside, "pdf");
      symlinkSync(outside, join(books, "project-link"));

      const result = await sweep({ now: at(7 * HOUR) });

      expect(result.deletedFiles).toBe(0);
      expect(existsSync(scratch)).toBe(true);
    });

    it("skips a directory that carries a scratch file's name", async () => {
      const dir = projectDir("project-1");
      const impostor = join(dir, `.book-${randomUUID()}.pdf`);
      mkdirSync(impostor);
      writeFileSync(join(impostor, "inside.txt"), "kept");

      const result = await sweep({ now: at(7 * HOUR) });

      expect(result.deletedFiles).toBe(0);
      expect(result.skippedIrregular).toBe(1);
      expect(existsSync(join(impostor, "inside.txt"))).toBe(true);
    });

    it("leaves scratch names one level too deep alone", async () => {
      const nested = join(books, "project-1", "runs");
      mkdirSync(nested, { recursive: true });
      const scratch = scratchExport(nested, "pdf");

      const result = await sweep({ now: at(7 * HOUR) });

      expect(result.deletedFiles).toBe(0);
      expect(existsSync(scratch)).toBe(true);
    });
  });

  describe("bounds and resumption", () => {
    it("stops at its entry budget and resumes from the cursor next time", async () => {
      const scratch: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        scratch.push(scratchExport(projectDir(`project-${index}`), "pdf"));
      }

      const first = await sweep({ maxEntries: 2, now: at(7 * HOUR) });
      expect(first.truncated).toBe(true);
      expect(first.deletedFiles).toBeLessThan(scratch.length);
      expect(first.nextCursor.bookStorage).toBeGreaterThan(0);

      let cursor: ExportTempSweepCursor = first.nextCursor;
      let deleted = first.deletedFiles;
      // Each pass moves forward; the cursor wraps to 0 once a listing runs out.
      for (let pass = 0; pass < 20 && deleted < scratch.length; pass += 1) {
        const next = await sweep({ maxEntries: 2, cursor, now: at(7 * HOUR) });
        cursor = next.nextCursor;
        deleted += next.deletedFiles;
      }

      expect(deleted).toBe(scratch.length);
      for (const path of scratch) {
        expect(existsSync(path)).toBe(false);
      }
    });

    it("resumes inside a large project directory across low-budget passes", async () => {
      const dir = projectDir("project-large");
      for (let index = 0; index < 16; index += 1) {
        // Sorts before `.book-…` on filesystems that return lexical order, and
        // is created first on filesystems that retain insertion order.
        write(dir, `.aaa-permanent-${index.toString().padStart(2, "0")}.txt`, "keep");
      }

      // Directory order is filesystem-defined, so choose a valid scratch name
      // that actually lands beyond several passes instead of assuming lexical
      // or creation order.
      let scratch: string | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const candidate = scratchExport(dir, "pdf");
        if (readdirSync(dir).indexOf(basename(candidate)) >= 8) {
          scratch = candidate;
          break;
        }
        rmSync(candidate);
      }
      expect(scratch).toBeDefined();
      const target = scratch!;

      // This is the complete cursor shape an older process persisted. It must
      // still be accepted, then gain the nested position after the first pass.
      let cursor: ExportTempSweepCursor = { bookStorage: 0, imageStorage: 0 };
      const nestedPositions: number[] = [];
      for (let pass = 0; pass < 20 && existsSync(target); pass += 1) {
        const result = await sweep({ maxEntries: 2, cursor, now: at(7 * HOUR) });
        cursor = result.nextCursor;
        if (cursor.bookProject) {
          expect(cursor.bookProject.projectName).toBe("project-large");
          nestedPositions.push(cursor.bookProject.entry);
        }
      }

      expect(nestedPositions.some((position) => position > 0)).toBe(true);
      expect(existsSync(target)).toBe(false);
    });

    it("does not let one huge directory starve the other root", async () => {
      for (let index = 0; index < 40; index += 1) {
        writeFileSync(join(images, `filler-${index}.png`), "png");
      }
      const scratch = scratchExport(projectDir("project-1"), "pdf");

      const result = await sweep({ maxEntries: 20, now: at(7 * HOUR) });

      expect(result.truncated).toBe(true);
      expect(existsSync(scratch)).toBe(false);
    });

    it("stops between entries when the signal aborts", async () => {
      const scratch = scratchExport(projectDir("project-1"), "pdf");
      const controller = new AbortController();
      controller.abort();

      const result = await sweep({ signal: controller.signal, now: at(7 * HOUR) });

      expect(result.aborted).toBe(true);
      expect(result.deletedFiles).toBe(0);
      expect(existsSync(scratch)).toBe(true);
    });

    it("keeps the project cursor when a shutdown cancels it in the image store", async () => {
      writeFileSync(join(images, "filler.png"), "png");
      const scratch = scratchExport(projectDir("project-1"), "pdf");
      const controller = new AbortController();
      controller.abort();

      const result = await sweep({
        signal: controller.signal,
        cursor: {
          bookStorage: 5,
          imageStorage: 0,
          bookProject: { projectName: "project-5", entry: 17 }
        },
        now: at(7 * HOUR)
      });

      expect(result.aborted).toBe(true);
      // The project scan never started, so its cursor is where it was — a
      // shutdown must not send the next process back to the top of the store.
      expect(result.nextCursor.bookStorage).toBe(5);
      expect(result.nextCursor.bookProject).toEqual({ projectName: "project-5", entry: 17 });
      expect(existsSync(scratch)).toBe(true);
    });

    it("reports a pass whose whole budget went to the image store", async () => {
      writeFileSync(join(images, "filler.png"), "png");
      const scratch = scratchExport(projectDir("project-1"), "pdf");

      const result = await sweep({ maxEntries: 1, cursor: { bookStorage: 3, imageStorage: 0 }, now: at(7 * HOUR) });

      expect(result.truncated).toBe(true);
      expect(result.nextCursor.bookStorage).toBe(3);
      expect(existsSync(scratch)).toBe(true);
    });
  });

  describe("failures", () => {
    it("treats missing storage directories as nothing to do", async () => {
      const result = await sweepStaleExportTempFiles({
        bookStorageDir: join(root, "no-books"),
        imageStorageDir: join(root, "no-images"),
        now: at(7 * HOUR)
      });

      expect(result).toMatchObject({ deletedFiles: 0, errors: 0, scannedEntries: 0 });
      expect(result.errorsByCode).toEqual({});
    });

    it.skipIf(process.getuid?.() === 0)(
      "counts an unreadable directory and sweeps the rest anyway",
      async () => {
        const locked = projectDir("locked");
        scratchExport(locked, "pdf");
        const reachable = scratchExport(projectDir("project-1"), "pdf");
        chmodSync(locked, 0o000);

        const result = await sweep({ now: at(7 * HOUR) });

        expect(result.errors).toBe(1);
        expect(result.errorsByCode).toEqual({ EACCES: 1 });
        expect(result.deletedFiles).toBe(1);
        expect(existsSync(reachable)).toBe(false);
      }
    );
  });
});
