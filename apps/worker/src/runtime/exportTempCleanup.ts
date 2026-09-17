import { sweepTemporaryDirectories } from "@book-maker/storage";
import { sweepStaleExportObjects } from "./exportObjectCleanup.js";
import {
  DEFAULT_EXPORT_TEMP_MIN_AGE_MS,
  EXPORT_TEMP_SWEEP_START,
  sweepStaleExportTempFiles,
  type ExportTempSweepCursor,
  type ExportTempSweepResult
} from "@book-maker/core";

/**
 * Starts, paces and stops cleanup. Each container sweeps its own scoped local
 * scratch; the worker also collects stale S3 publication backups. A heartbeat
 * protects active temporary directories. Cleanup failures remain diagnostic.
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
      await sweepTemporaryDirectories({ minAgeMs: options.minAgeMs ?? DEFAULT_EXPORT_TEMP_MIN_AGE_MS });
      const deletedObjects = await sweepStaleExportObjects({
        minAgeMs: options.minAgeMs ?? DEFAULT_EXPORT_TEMP_MIN_AGE_MS, signal: controller.signal
      });
      if (deletedObjects) log("Abandoned export predecessor objects swept", { deletedObjects });
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
