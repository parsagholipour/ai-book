import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepStaleExportTempFiles } from "./exportTempSweep.js";

/**
 * What happens when a scratch file moves under the sweep.
 *
 * The sweep decides from one `lstat` and then reads the file again immediately
 * before the `unlink`, because the decision and the delete are two syscalls with
 * a gap between them and the thing in that gap is another process: the worker
 * writing this file right now, the API's inline rebuild, a second worker's
 * sweep. None of that is reproducible by waiting, so the gap is opened
 * deliberately here — a hook on `lstat` that runs between the two reads — and
 * every one of these cases is a real sequence of syscalls against a real
 * directory, not a simulation of one.
 *
 * The mock is why this lives beside `exportTempSweep.test.ts` rather than in it:
 * it replaces `lstat` for the whole file, and the rest of the suite wants the
 * real one.
 */

const hook = vi.hoisted(() => ({
  /** Called after each `lstat` resolves, with the path and 1-based call count. */
  afterLstat: null as ((path: string, call: number) => void | Promise<void>) | null,
  calls: 0
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      const stats = await actual.lstat(path);
      hook.calls += 1;
      await hook.afterLstat?.(String(path), hook.calls);
      return stats;
    }
  };
});

const HOUR = 60 * 60 * 1000;

describe("export temp sweep under concurrent writers", () => {
  let root: string;
  let books: string;
  let images: string;
  let clock: number;

  const sweep = (overrides: Partial<Parameters<typeof sweepStaleExportTempFiles>[0]> = {}) =>
    sweepStaleExportTempFiles({
      bookStorageDir: books,
      imageStorageDir: images,
      now: () => clock + 7 * HOUR,
      ...overrides
    });

  const scratch = (projectId: string) => {
    const dir = join(books, projectId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `.book-${randomUUID()}.pdf`);
    writeFileSync(path, "%PDF-scratch");
    return path;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "book-maker-temp-race-"));
    books = join(root, "books");
    images = join(root, "images");
    mkdirSync(books);
    mkdirSync(images);
    clock = Date.now();
    hook.afterLstat = null;
    hook.calls = 0;
  });

  afterEach(() => {
    hook.afterLstat = null;
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a file a writer touched between the decision and the unlink", async () => {
    const path = scratch("project-1");
    hook.afterLstat = (touched, call) => {
      // Exactly the window the second read exists for: the sweep has already
      // decided this file is abandoned, and the process that owns it is not
      // gone after all.
      if (call === 1) {
        const now = new Date(clock + 7 * HOUR);
        utimesSync(touched, now, now);
      }
    };

    const result = await sweep();

    expect(hook.calls).toBe(2);
    expect(result.deletedFiles).toBe(0);
    expect(result.keptLive).toBe(1);
    expect(result.errors).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("keeps a file replaced by a newer one wearing the same name", async () => {
    const path = scratch("project-1");
    const old = new Date(clock - 30 * HOUR);
    utimesSync(path, old, old);
    hook.afterLstat = (replaced, call) => {
      if (call === 1) {
        // A different file at the same path: same name, same age, different
        // inode. Deleting it would take a render that started a moment ago.
        unlinkSync(replaced);
        writeFileSync(replaced, "%PDF-newer");
        utimesSync(replaced, old, old);
      }
    };

    const result = await sweep();

    expect(result.deletedFiles).toBe(0);
    expect(result.keptLive).toBe(1);
    expect(existsSync(path)).toBe(true);
  });

  it("counts nothing when another process's cleanup gets there first", async () => {
    scratch("project-1");
    hook.afterLstat = (removed, call) => {
      // The owning process's own `finally`, or a second worker's sweep. The
      // file is gone before the confirming read.
      if (call === 1) {
        unlinkSync(removed);
      }
    };

    const result = await sweep();

    expect(result.deletedFiles).toBe(0);
    expect(result.keptLive).toBe(0);
    // ENOENT is this design working — the file is gone, which is the outcome.
    expect(result.errors).toBe(0);
    expect(result.errorsByCode).toEqual({});
  });

  it("tolerates the file vanishing at the unlink itself", async () => {
    const path = scratch("project-1");
    hook.afterLstat = (removed, call) => {
      // Past both reads: the sweep is committed and the syscall still loses.
      if (call === 2) {
        unlinkSync(removed);
      }
    };

    const result = await sweep();

    expect(result.deletedFiles).toBe(0);
    expect(result.errors).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("lets two sweeps run over one storage volume without either failing", async () => {
    const paths = ["project-1", "project-2", "project-3"].map(scratch);
    // Every read yields, so the two passes really interleave rather than one
    // running to completion first.
    hook.afterLstat = () => new Promise<void>((resolve) => setImmediate(resolve));

    const [first, second] = await Promise.all([sweep(), sweep()]);

    // Each file is deleted once; the loser of each race sees ENOENT, which is
    // not an error and is not a second deletion.
    expect(first.deletedFiles + second.deletedFiles).toBe(paths.length);
    expect(first.errors + second.errors).toBe(0);
    for (const path of paths) {
      expect(existsSync(path)).toBe(false);
    }
  });
});
