/**
 * The API's periodic housekeeping: attachment retention, voice-call
 * settlement, account deletions, Play renewals, queue reconciliation, the mail
 * check, storage re-deletion, table pruning and re-screening shared books
 * whose text changed.
 *
 * **None of it runs before the API listens.** `server.ts` used to await the
 * first pass of each one at boot, and several reach S3 or Google: one slow
 * dependency during a deploy kept the new API from listening until the
 * deploy's 240 s health wait gave up — after the old release had already been
 * stopped (launch review, 2026-10-13). So `start()` is called after `listen`,
 * returns at once, and runs each first pass on a later tick; a sweep that
 * hangs holds up only itself.
 *
 * Each sweep is single-flight in this process (a tick that finds the last
 * pass still running is skipped, never queued), and anything it throws is
 * caught and logged under its own name, never left to reject unhandled.
 */

export type BackgroundSweep = {
  /** Names the sweep in the log (`<name>_failed`). */
  name: string;
  intervalMs: number;
  /** When the first pass runs, counted from `start()`. Defaults to the next tick. */
  initialDelayMs?: number;
  run(): Promise<unknown>;
};

type SweepLogger = { warn(object: Record<string, unknown>, message: string): void };

export type BackgroundSweeps = {
  /** Schedules every sweep and returns at once; never awaits a pass. Calling it twice does nothing. */
  start(): void;
  /** Clears every timer. A pass already running is not awaited: it may be waiting on a dead dependency. */
  stop(): void;
  /** Runs one pass of a sweep now, unless a pass is already running (then false). For tests and operators. */
  runNow(name: string): Promise<boolean>;
};

export function createBackgroundSweeps(sweeps: readonly BackgroundSweep[], log: SweepLogger): BackgroundSweeps {
  const running = new Set<string>();
  const timers: NodeJS.Timeout[] = [];
  let started = false;
  let stopped = false;

  const pass = async (sweep: BackgroundSweep): Promise<boolean> => {
    if (running.has(sweep.name)) return false;
    running.add(sweep.name);
    try {
      await sweep.run();
    } catch (error) {
      log.warn({ event: `${sweep.name}_failed`, err: error }, `Background sweep ${sweep.name} failed`);
    } finally {
      running.delete(sweep.name);
    }
    return true;
  };

  const schedule = (callback: () => void, ms: number, repeat: boolean) => {
    const timer = repeat ? setInterval(callback, ms) : setTimeout(callback, ms);
    timer.unref();
    timers.push(timer);
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      for (const sweep of sweeps) {
        const tick = () => {
          if (!stopped) void pass(sweep);
        };
        schedule(tick, Math.max(0, sweep.initialDelayMs ?? 0), false);
        schedule(tick, sweep.intervalMs, true);
      }
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
    },
    runNow(name) {
      const sweep = sweeps.find((candidate) => candidate.name === name);
      if (!sweep) return Promise.reject(new Error(`No background sweep named ${name}`));
      return pass(sweep);
    }
  };
}
