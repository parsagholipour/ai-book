import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startExportTempCleanup } from "./exportTempCleanup.js";
import type { ExportTempSweepCursor, ExportTempSweepResult } from "@book-maker/core";

/**
 * The lifecycle around the sweep: what starts it, what stops it, and the two
 * things a timer next to real work must never do — overlap itself, or outlive
 * the shutdown that is about to disconnect everything underneath it.
 */

const EMPTY: ExportTempSweepResult = {
  scannedEntries: 0,
  deletedFiles: 0,
  reclaimedBytes: 0,
  keptLive: 0,
  skippedIrregular: 0,
  errors: 0,
  errorsByCode: {},
  truncated: false,
  aborted: false,
  nextCursor: { bookStorage: 0, imageStorage: 0 }
};

const result = (overrides: Partial<ExportTempSweepResult> = {}): ExportTempSweepResult => ({
  ...EMPTY,
  ...overrides,
  nextCursor: overrides.nextCursor ?? { ...EMPTY.nextCursor }
});

type SweepCall = {
  bookStorageDir: string;
  imageStorageDir: string;
  minAgeMs?: number | undefined;
  cursor?: ExportTempSweepCursor | undefined;
  signal?: AbortSignal | undefined;
};

/** A sweep whose completion the test decides, so overlap is observable. */
function deferredSweep() {
  const calls: SweepCall[] = [];
  const settlers: ((value: ExportTempSweepResult) => void)[] = [];
  const rejecters: ((error: unknown) => void)[] = [];
  const sweep = (options: SweepCall): Promise<ExportTempSweepResult> => {
    calls.push(options);
    return new Promise<ExportTempSweepResult>((resolve, reject) => {
      settlers.push(resolve);
      rejecters.push(reject);
    });
  };
  return {
    calls,
    sweep: sweep as never,
    settle: (value: ExportTempSweepResult = result()) => {
      const resolve = settlers.shift();
      rejecters.shift();
      resolve?.(value);
    },
    fail: (error: unknown) => {
      const reject = rejecters.shift();
      settlers.shift();
      reject?.(error);
    }
  };
}

const options = (overrides: Record<string, unknown> = {}) => ({
  bookStorageDir: "/storage/books",
  imageStorageDir: "/storage/images",
  log: () => undefined,
  ...overrides
});

describe("export temp cleanup lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sweeps on the interval and hands each pass the previous cursor", async () => {
    const sweeps = deferredSweep();
    const cleanup = startExportTempCleanup(
      options({ sweep: sweeps.sweep, intervalMs: 1_000, minAgeMs: 90 * 60 * 1000 })
    );

    const first = cleanup.runNow();
    expect(sweeps.calls).toHaveLength(1);
    expect(sweeps.calls[0]).toMatchObject({
      bookStorageDir: "/storage/books",
      imageStorageDir: "/storage/images",
      minAgeMs: 90 * 60 * 1000,
      cursor: { bookStorage: 0, imageStorage: 0 }
    });
    sweeps.settle(result({ nextCursor: { bookStorage: 12, imageStorage: 3 } }));
    await first;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweeps.calls).toHaveLength(2);
    // A truncated pass resumes where it stopped instead of re-scanning the same
    // prefix every hour.
    expect(sweeps.calls[1]?.cursor).toEqual({ bookStorage: 12, imageStorage: 3 });

    sweeps.settle();
    await cleanup.stop();
  });

  it("never runs two sweeps at once, however long one takes", async () => {
    const sweeps = deferredSweep();
    const cleanup = startExportTempCleanup(options({ sweep: sweeps.sweep, intervalMs: 1_000 }));

    const first = cleanup.runNow();
    // Three interval ticks pass while the first sweep is still walking the store.
    await vi.advanceTimersByTimeAsync(3_500);
    expect(sweeps.calls).toHaveLength(1);
    // A caller that asks mid-sweep joins the one in flight rather than starting
    // another walk over the same directories.
    expect(cleanup.runNow()).toBe(first);

    sweeps.settle();
    await first;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweeps.calls).toHaveLength(2);

    sweeps.settle();
    await cleanup.stop();
  });

  it("stops the timer, aborts the sweep in flight and waits for it to settle", async () => {
    const sweeps = deferredSweep();
    const cleanup = startExportTempCleanup(options({ sweep: sweeps.sweep, intervalMs: 1_000 }));

    void cleanup.runNow();
    const signal = sweeps.calls[0]?.signal;
    expect(signal?.aborted).toBe(false);

    let settled = false;
    const stopped = cleanup.stop().then(() => {
      settled = true;
    });
    // The signal the sweep checks between entries is raised immediately...
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    // ...but shutdown does not continue until the scan has actually let go of
    // its directory handle, which is what keeps it out of `prisma.$disconnect()`.
    expect(settled).toBe(false);

    sweeps.settle(result({ aborted: true }));
    await stopped;
    expect(settled).toBe(true);

    // The timer is gone with it: no sweep starts against a torn-down process.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sweeps.calls).toHaveLength(1);
  });

  it("declines to start a sweep once stopped", async () => {
    const sweeps = deferredSweep();
    const cleanup = startExportTempCleanup(options({ sweep: sweeps.sweep, intervalMs: 1_000 }));

    await cleanup.stop();
    await cleanup.runNow();

    expect(sweeps.calls).toHaveLength(0);
  });

  it("stops cleanly when no sweep ever ran", async () => {
    const sweeps = deferredSweep();
    const cleanup = startExportTempCleanup(options({ sweep: sweeps.sweep, intervalMs: 1_000 }));

    await expect(cleanup.stop()).resolves.toBeUndefined();
    expect(sweeps.calls).toHaveLength(0);
  });

  it("survives a sweep that rejects, and keeps sweeping after it", async () => {
    const sweeps = deferredSweep();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cleanup = startExportTempCleanup(options({ sweep: sweeps.sweep, intervalMs: 1_000 }));

    const first = cleanup.runNow();
    sweeps.fail(new Error("storage went away"));
    await expect(first).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledOnce();

    // Housekeeping that failed does not stop housekeeping.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweeps.calls).toHaveLength(2);

    sweeps.settle();
    await cleanup.stop();
  });

  it("keeps its cursor when a sweep fails rather than restarting the walk", async () => {
    const sweeps = deferredSweep();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cleanup = startExportTempCleanup(options({ sweep: sweeps.sweep, intervalMs: 1_000 }));

    const first = cleanup.runNow();
    sweeps.settle(result({ nextCursor: { bookStorage: 7, imageStorage: 0 } }));
    await first;

    await vi.advanceTimersByTimeAsync(1_000);
    sweeps.fail(new Error("storage went away"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sweeps.calls[2]?.cursor).toEqual({ bookStorage: 7, imageStorage: 0 });

    sweeps.settle();
    await cleanup.stop();
  });

  describe("reporting", () => {
    const logged = async (value: ExportTempSweepResult) => {
      const sweeps = deferredSweep();
      const log = vi.fn();
      const cleanup = startExportTempCleanup(options({ sweep: sweeps.sweep, log, intervalMs: 1_000 }));
      const run = cleanup.runNow();
      sweeps.settle(value);
      await run;
      await cleanup.stop();
      return log;
    };

    it("says what it reclaimed", async () => {
      const log = await logged(result({ deletedFiles: 2, reclaimedBytes: 4_096, scannedEntries: 9 }));

      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0]?.[1]).toMatchObject({
        event: "export_temp.swept",
        deletedFiles: 2,
        reclaimedBytes: 4_096,
        scannedEntries: 9
      });
    });

    it("reports what it could not read, and what it refused to touch", async () => {
      const log = await logged(result({ errors: 1, errorsByCode: { EACCES: 1 }, skippedIrregular: 1 }));

      expect(log.mock.calls[0]?.[1]).toMatchObject({ errors: 1, errorsByCode: { EACCES: 1 }, skippedIrregular: 1 });
    });

    it("reports a pass that ran out of budget, so a store too large to finish is visible", async () => {
      const log = await logged(result({ truncated: true, scannedEntries: 20_000 }));

      expect(log.mock.calls[0]?.[1]).toMatchObject({ truncated: true });
    });

    it("stays quiet on the ordinary pass that found nothing", async () => {
      const log = await logged(result({ scannedEntries: 40, keptLive: 1 }));

      expect(log).not.toHaveBeenCalled();
    });
  });
});
