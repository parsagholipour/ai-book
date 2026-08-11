import {
  DEFAULT_EXPORT_TEMP_MIN_AGE_MS,
  EXPORT_TEMP_SWEEP_START,
  sweepStaleExportTempFiles,
  type ExportTempSweepCursor,
  type ExportTempSweepResult
} from "@book-maker/core";

/**
 * The worker's lifecycle around the scratch-file sweep.
 *
 * The sweep itself is in `@book-maker/core` and knows nothing about processes;
 * this is what starts it, paces it and — the part that matters at shutdown —
 * stops it. A sweep is filesystem work with an open directory handle, so a
 * `clearInterval` alone would leave one running into `prisma.$disconnect()`;
 * `stop()` cancels it through the signal the sweep checks between entries and
 * then waits for it to settle, which is bounded because the check happens
 * before every entry it examines.
 *
 * **The worker is the only process that sweeps.** The API renders inline
 * exports and writes the same scratch names, but both processes share one
 * storage volume, so one collector reaches every orphan and two would spend
 * their scans racing each other to the same `unlink`. Nothing about the sweep
 * needs to run where the file was written: it is age-based, not
 * ownership-based, precisely because the process that wrote an orphan is by
 * definition gone.
 *
 * It runs once at startup and then hourly. The startup pass is not a wipe —
 * there is no "this process just started, so nothing here is live" rule
 * anywhere in it — it is the same age-based pass, run early because a container
 * that OOMs mid-compile is usually restarted immediately and the orphan it left
 * would otherwise wait a full interval.
 */

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type ExportTempCleanupOptions = {
  bookStorageDir: string;
  imageStorageDir: string;
  minAgeMs?: number;
  intervalMs?: number;
  /** Seam for tests; production uses the core sweep. */
  sweep?: typeof sweepStaleExportTempFiles;
  log?: (message: string, detail: Record<string, unknown>) => void;
};

export type ExportTempCleanup = {
  /** Runs a sweep now, resolving when it settles. Never rejects. */
  runNow: () => Promise<void>;
  /** Stops the timer, cancels any sweep in flight and waits for it. */
  stop: () => Promise<void>;
};

function defaultLog(message: string, detail: Record<string, unknown>): void {
  console.log(message, detail);
}

export function startExportTempCleanup(options: ExportTempCleanupOptions): ExportTempCleanup {
  const sweep = options.sweep ?? sweepStaleExportTempFiles;
  const log = options.log ?? defaultLog;
  const controller = new AbortController();
  let cursor: ExportTempSweepCursor = { ...EXPORT_TEMP_SWEEP_START };
  // One sweep at a time. On slow storage a scan can outlast the interval, and
  // two passes over the same directories would only race each other's unlinks.
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const runSweep = async (): Promise<void> => {
    try {
      const result = await sweep({
        bookStorageDir: options.bookStorageDir,
        imageStorageDir: options.imageStorageDir,
        minAgeMs: options.minAgeMs ?? DEFAULT_EXPORT_TEMP_MIN_AGE_MS,
        cursor,
        signal: controller.signal
      });
      cursor = result.nextCursor;
      if (isWorthReporting(result)) {
        log("Abandoned export scratch files swept", {
          event: "export_temp.swept",
          deletedFiles: result.deletedFiles,
          reclaimedBytes: result.reclaimedBytes,
          scannedEntries: result.scannedEntries,
          keptLive: result.keptLive,
          skippedIrregular: result.skippedIrregular,
          errors: result.errors,
          errorsByCode: result.errorsByCode,
          truncated: result.truncated,
          aborted: result.aborted
        });
      }
    } catch (error) {
      // The sweep resolves rather than throws, so this is a bug or an
      // out-of-memory-shaped failure. Either way it is housekeeping: it must
      // not take the worker down.
      console.error("Export scratch file sweep failed", error);
    }
  };

  const runNow = (): Promise<void> => {
    if (inFlight) {
      return inFlight;
    }
    if (stopped) {
      return Promise.resolve();
    }
    const started = runSweep().finally(() => {
      inFlight = null;
    });
    inFlight = started;
    return started;
  };

  const timer = setInterval(() => void runNow(), options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  // Housekeeping never holds the process open on its own.
  timer.unref();

  return {
    runNow,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      controller.abort();
      await inFlight;
    }
  };
}

/**
 * Quiet when there was nothing to do. A sweep that deleted nothing is the
 * normal case — hourly, forever — and logging it would bury the one line that
 * says storage is being reclaimed or a directory cannot be read.
 */
function isWorthReporting(result: ExportTempSweepResult): boolean {
  return result.deletedFiles > 0 || result.errors > 0 || result.skippedIrregular > 0 || result.truncated;
}
