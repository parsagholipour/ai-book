import type { ChildProcess } from "node:child_process";
import puppeteer, {
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Page,
  type Target
} from "puppeteer";
import { terminateBrowserProcess } from "./browserProcess.js";

/**
 * One Chromium, many pages.
 *
 * Every render used to launch and destroy a whole browser — roughly half a
 * second of pure process startup on a job whose useful work is a fraction of
 * that, paid twice over on a book that also draws a cover. Pages are cheap;
 * browsers are not.
 *
 * What that buys in speed it costs in shared fate, so the reset paths below are
 * the substance of this file: a browser that dies now takes every concurrent
 * render with it rather than one job, and a page leaked into a long-lived
 * browser is a renderer process that never exits.
 *
 * A render is therefore leased a whole **browser context**, not a page. The
 * page is not the unit the content is confined to: a renderer can open workers
 * and auxiliary pages, and a regression in the manuscript sanitizer must not
 * let one of them survive into the next book. Every render therefore gets an
 * isolated context that is discarded in full.
 *
 * **Every browser stays tracked until its process is actually gone.** A lease is
 * `live` (handing out contexts), `retired` (draining) or `closing` (a reclaim in
 * flight), and it leaves {@link leases} only when that reclaim settles — never
 * before it starts. Dropping it first is what made a wedged close unrecoverable:
 * `browser.close()` is *not* bounded by puppeteer (the CDP path sends
 * `Browser.close` and then awaits the process's own exit, so a renderer that
 * ignores the request leaves the promise pending for good), and a
 * fire-and-forgotten one took the only handle to that Chromium with it. Neither
 * the idle sweep nor `closeSharedBrowser` could see it afterwards, which in a
 * container means a browser's worth of memory held until the pod is replaced.
 * So the reclaim is bounded at every step and ends in a real SIGKILL, and what
 * survives even that is reported by {@link browserPoolStatus} rather than
 * forgotten.
 */

/**
 * Deliberately below the worker's job concurrency, which is
 * `Math.max(MAX_PARALLEL_PAGE_JOBS, MAX_PARALLEL_IMAGE_JOBS)` — 4 by default and
 * tunable to 32 (`config.ts`) — with no separate lane for compiles. Four large
 * books typesetting inside one Chromium is an out-of-memory kill that takes all
 * four down together, so renders queue here instead. Raising this without
 * raising the container's memory is how that outage comes back.
 */
const RENDER_CONCURRENCY = 2;

/** Renderer processes accumulate state; a fresh browser every so often is cheap insurance. */
const MAX_RENDERS_PER_BROWSER = 50;

/**
 * A live `Browser` holds the event loop open. Without this, `packages/core`'s
 * vitest run never exits and `pnpm covers:preview` hangs after its 50 covers.
 */
const IDLE_CLOSE_MS = 60_000;

/**
 * Covers what has no timeout of its own: our `document.fonts.ready` wait and a
 * wedged renderer. `page.pdf()` already throws `TimeoutError` at 30 s in
 * puppeteer 25, so this is defense in depth rather than the fix for slow
 * exports — the `file://` transport is that.
 */
const RENDER_TIMEOUT_MS = 90_000;

/**
 * How long a browser gets to close politely before its process is signalled.
 *
 * Puppeteer bounds none of this itself: `closeBrowser` sends `Browser.close` and
 * then awaits `hasClosed()`, which resolves off the process's `exit` event — a
 * renderer that never lets go leaves both this process and that one holding on.
 */
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

/**
 * How long a Chromium gets to actually exit — once after answering `close()`,
 * once after being killed. Worst case a reclaim costs the close timeout plus one
 * of these, which is the number a shutdown is budgeted against: the container's
 * own stop grace period (10 s by default) has to fit the whole shutdown, not
 * just the browsers.
 */
const PROCESS_EXIT_TIMEOUT_MS = 2_000;

/**
 * A process that answers neither `close()` nor SIGKILL is a leak, and the record
 * of it is kept for the operator rather than dropped. The cap keeps that record
 * from becoming a leak of its own — a box with this many stranded Chromiums has
 * a worse problem than an under-reported list.
 */
const MAX_TRACKED_ABANDONED_PROCESSES = 20;

const LAUNCH_OPTIONS: LaunchOptions = {
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  // Context/page acquisition is CDP work too. The attempt watchdog below is
  // the outer deadline; this keeps an individual protocol request from living
  // beyond that same budget inside Puppeteer's connection callback registry.
  protocolTimeout: RENDER_TIMEOUT_MS,
  // Puppeteer installs its own signal handlers by default, which race the
  // app's own shutdown; `closeSharedBrowser()` is how this process says goodbye.
  //
  // That makes trapping a debt this file hands to its hosts: puppeteer's
  // remaining safety net is an unconditional `process.on("exit")`, which a
  // signal Node does not handle never reaches. Every process that renders must
  // therefore trap **SIGHUP as well as SIGINT/SIGTERM** — a hangup used to kill
  // the API or worker outright and leave Chromium running, reparented to init.
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false
};

/**
 * Where a browser is in its life.
 *
 * `live` is the one new renders are given; `retired` is draining and closes as
 * soon as its last render returns; `closing` has a reclaim in flight. Only
 * `live` is ever handed out and only one reclaim ever runs, which is what lets a
 * release, an idle sweep, a disconnect and a shutdown all arrive at once and
 * collapse onto the same bounded piece of work.
 */
type LeaseState = "live" | "retired" | "closing";

/**
 * One browser and the bookkeeping that decides when it may go.
 *
 * The promise, not the browser: concurrent first callers must await one launch
 * rather than start several.
 */
type BrowserLease = {
  /**
   * Identifies this browser for the whole of its life, so a `disconnected`
   * event or a failed launch belonging to an older one cannot clear a newer one
   * out from under the renders using it.
   */
  generation: number;
  browser: Promise<Browser>;
  /** Pages handed out from it, ever. */
  renders: number;
  /** Pages still open on it. */
  active: number;
  state: LeaseState;
  /**
   * Captured the moment the launch resolves, because it is what a wedged
   * `close()` is reclaimed by — and by then the browser object may be one this
   * process can no longer talk to.
   */
  process?: ChildProcess | null;
  /**
   * The reclaim, memoized. Its presence *is* the "already closing" flag, so the
   * second caller awaits the first one's work instead of starting a second
   * `close()` on a renderer that ignored the first — which would never settle.
   */
  closing?: Promise<void>;
};

/** A Chromium that answered neither `close()` nor SIGKILL. */
export type AbandonedProcess = {
  generation: number;
  pid: number | undefined;
};

/** The browser new renders are given. */
let current: BrowserLease | undefined;
/**
 * Every browser this process is still responsible for — the current one, any
 * still draining, and any whose reclaim has not finished. A lease is only
 * removed once its Chromium is known to be gone.
 */
const leases = new Map<number, BrowserLease>();
let generationCounter = 0;
let activePages = 0;
const abandonedProcesses: AbandonedProcess[] = [];
/**
 * Bumped by {@link closeSharedBrowser}. A render whose browser was taken away
 * deliberately must not answer by launching another one — at shutdown that
 * would hold the event loop open for the whole idle window.
 */
let closeCount = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

let permits = RENDER_CONCURRENCY;
const waiting: Array<() => void> = [];

function acquirePermit(): Promise<void> {
  if (permits > 0) {
    permits -= 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function releasePermit(): void {
  const next = waiting.shift();
  if (next) {
    next();
    return;
  }
  permits += 1;
}

/**
 * The browser went away on its own — it crashed, or it never launched. Stop
 * handing out pages from it; the renders already on it will fail, which is what
 * a dead browser means.
 *
 * A disconnect is still reclaimed rather than merely forgotten. It says the CDP
 * connection dropped, which is *usually* the process dying and occasionally only
 * the pipe — and the second case is a Chromium nobody would ever have closed.
 * The reclaim finds an already-dead process immediately, so paying for it here
 * costs nothing when the usual reading is the right one.
 */
function discardLease(generation: number): void {
  const lease = leases.get(generation);
  if (!lease) {
    return;
  }
  retireLease(lease);
}

/**
 * Takes a browser out of service without closing it under anyone.
 *
 * This is the recycle path, and closing here is what it must *not* do: with the
 * semaphore at 2, a busy worker always has another render in flight, so a
 * close-now rule could only ever fire when the pool happened to be idle — which
 * is exactly when recycling does not matter. Retiring instead means the next
 * render gets a fresh browser immediately and this one closes as soon as its
 * own last page comes back.
 */
function retireLease(lease: BrowserLease): void {
  if (lease.state === "closing") {
    // Its reclaim owns the teardown from here, and it is the one thing that may
    // not be restarted.
    return;
  }
  lease.state = "retired";
  if (current === lease) {
    current = undefined;
  }
  closeLeaseIfDrained(lease);
}

function closeLeaseIfDrained(lease: BrowserLease): void {
  if (lease.state !== "retired" || lease.active > 0) {
    return;
  }
  void beginReclaim(lease);
}

/**
 * Starts — or joins — the one bounded reclaim of this browser.
 *
 * The lease moves to `closing` and stays in {@link leases} for the whole of it.
 * That is the fix this file exists for: dropping it here and then
 * fire-and-forgetting `browser.close()` left a wedged Chromium that neither the
 * idle sweep nor shutdown had a handle on any more.
 */
function beginReclaim(lease: BrowserLease): Promise<void> {
  const started = lease.closing;
  if (started) {
    return started;
  }
  lease.state = "closing";
  if (current === lease) {
    current = undefined;
  }
  const closing = reclaimBrowser(lease);
  lease.closing = closing;
  return closing;
}

/**
 * Ends a browser, bounded at every step, and says so.
 *
 * Politely first: `close()` is what lets Chromium tear its renderers down in
 * order. But it may never answer — puppeteer awaits the process's own exit with
 * no deadline of its own — so it is raced, and what is still running afterwards
 * is killed outright. The lease is only forgotten once the process is gone or
 * has ignored a SIGKILL, which is as far as one process can chase another.
 */
async function reclaimBrowser(lease: BrowserLease): Promise<void> {
  const outcome = await closeBrowserProcess(lease);
  if (outcome === "launching") {
    // There is no browser to close and no process to kill *yet*, and a shutdown
    // may not sit out a launch that is already taking longer than the whole
    // reclaim budget. The `close()` queued behind that launch is what ends a
    // healthy browser; this second pass is what kills one that ignores it. The
    // lease stays in `leases` throughout, which is the property that matters —
    // an untracked Chromium is the bug.
    void lease.browser.then(
      () => reclaimBrowser(lease),
      // The launch failed, so there is nothing left to be responsible for.
      () => {
        leases.delete(lease.generation);
      }
    );
    return;
  }
  leases.delete(lease.generation);
  if (outcome === "abandoned") {
    recordAbandonedProcess(lease);
  }
}

/**
 * How a reclaim ended. `"launching"` is not an ending at all — see
 * {@link reclaimBrowser} — it is the one case where the browser being reclaimed
 * does not exist yet.
 */
type ReclaimOutcome = "closed" | "killed" | "abandoned" | "launching";

async function closeBrowserProcess(lease: BrowserLease): Promise<ReclaimOutcome> {
  const closed = await withDeadline(closeQuietly(lease), BROWSER_CLOSE_TIMEOUT_MS);
  const child = lease.process;
  // `undefined` is the launch not having landed; a browser that landed records
  // its process — `null` included, for one this process did not spawn.
  if (child === undefined && closed === TIMED_OUT) {
    return "launching";
  }
  if (!child || hasExited(child)) {
    return "closed";
  }
  if (closed !== TIMED_OUT && (await waitForExit(child, PROCESS_EXIT_TIMEOUT_MS))) {
    // `close()` answered while the process was still on its way out; Node needs
    // a moment to see the exit, and a browser killed in that moment is a browser
    // killed for finishing normally.
    return "closed";
  }
  const kill = terminateBrowserProcess(child);
  if (kill === "gone") {
    return "closed";
  }
  return (await waitForExit(child, PROCESS_EXIT_TIMEOUT_MS)) ? "killed" : "abandoned";
}

/**
 * `browser.close()` with every failure swallowed. A rejection means the far end
 * was already gone, which the process check after it answers far better than the
 * error does.
 */
function closeQuietly(lease: BrowserLease): Promise<void> {
  return lease.browser.then(
    // A launch that never produced a browser has nothing to close, and its
    // rejection is already reported to the render that asked for it.
    (browser) => browser.close().then(noop, noop),
    noop
  );
}

function noop(): void {
  return undefined;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Resolves `true` when the process is gone, `false` when it outlives the wait —
 * and takes its listener and its timer with it either way. A reclaim that leaked
 * one of those per wedged browser would be its own slow leak.
 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (exited: boolean): void => {
      child.off("exit", onExit);
      if (timer) {
        clearTimeout(timer);
      }
      resolve(exited);
    };
    const onExit = (): void => settle(true);
    child.once("exit", onExit);
    timer = setTimeout(() => settle(false), timeoutMs);
    // A wait for a process that will never exit must not be what keeps this one
    // alive; the process handle itself is what holds the loop open, and killing
    // it is the point.
    timer.unref?.();
  });
}

/**
 * Keeps a stranded Chromium visible until it really is gone.
 *
 * Recording it is the honest end of the reclaim: the pool has done everything a
 * process can do to another, and pretending otherwise is how the original leak
 * stayed invisible. The `exit` listener is what makes the list a statement about
 * *now* rather than a history — a process that finally dies drops off it.
 */
function recordAbandonedProcess(lease: BrowserLease): void {
  const child = lease.process;
  const record: AbandonedProcess = { generation: lease.generation, pid: child?.pid };
  abandonedProcesses.push(record);
  if (abandonedProcesses.length > MAX_TRACKED_ABANDONED_PROCESSES) {
    abandonedProcesses.shift();
  }
  child?.once("exit", () => {
    const at = abandonedProcesses.indexOf(record);
    if (at >= 0) {
      abandonedProcesses.splice(at, 1);
    }
  });
}

/** The loser of a race against {@link withDeadline}. */
const TIMED_OUT = Symbol("timed-out");

/**
 * Races `work` against a deadline and always clears the timer, so a close that
 * answers on time does not leave a pending callback behind it.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
}

/** Whether anything is left for an idle sweep or a shutdown to close. */
function hasReclaimableLease(): boolean {
  for (const lease of leases.values()) {
    if (lease.state !== "closing") {
      return true;
    }
  }
  return false;
}

function scheduleIdleClose(): void {
  clearIdleTimer();
  // A lease that is already being reclaimed is nobody else's to close, and a
  // timer that would only re-await it is a timer for nothing.
  if (activePages > 0 || !hasReclaimableLease()) {
    return;
  }
  idleTimer = setTimeout(() => {
    void closeSharedBrowser();
  }, IDLE_CLOSE_MS);
  // Never a reason to keep a process alive; `unref` on the *timer* only.
  // `browser.process()?.unref()` would orphan Chromium in the container.
  idleTimer.unref?.();
}

/**
 * Claims a page's worth of the current browser, recycling first when that
 * browser has served its quota. Synchronous, so two callers cannot both decide
 * they are the one that gets to retire it.
 */
function acquireLease(): BrowserLease {
  // Everything that takes a browser out of service also clears `current`; this
  // is the standing guarantee rather than a repair, and the one invariant a
  // caller would be poisoned by. A retiring or closing browser must never be
  // leased again — its pages would be closed under the render mid-flight.
  if (current && current.state !== "live") {
    current = undefined;
  }
  if (current && current.renders >= MAX_RENDERS_PER_BROWSER) {
    retireLease(current);
  }
  if (!current) {
    const generation = (generationCounter += 1);
    const browser = puppeteer
      .launch(LAUNCH_OPTIONS)
      .then((instance) => {
        instance.on("disconnected", () => discardLease(generation));
        // The lease is still here: a reclaim waits on this very promise, so
        // nothing can have removed it before the launch settled.
        const lease = leases.get(generation);
        if (lease) {
          // Bookkeeping is never allowed to fail a launch. A pid this pool could
          // not write down costs it a kill it may never need; a throw here would
          // reject the browser every render is waiting on.
          try {
            lease.process = instance.process();
          } catch {
            lease.process = null;
          }
        }
        return instance;
      })
      .catch((error: unknown) => {
        // A rejected promise must not be left as the current browser, or every
        // later render fails with the first transient launch error.
        discardLease(generation);
        throw error;
      });
    current = { generation, browser, renders: 0, active: 0, state: "live" };
    leases.set(generation, current);
  }
  current.renders += 1;
  current.active += 1;
  return current;
}

/**
 * Closes every browser this process holds — the current one, any still draining,
 * and any already being reclaimed. Idempotent, and safe to call while renders
 * are in flight: they will fail, which is what a shutdown means.
 *
 * It is also *bounded*, which it has to be to be worth awaiting in a signal
 * handler: each browser costs at most the close deadline plus one exit wait, in
 * parallel, and a Chromium that ignores both is killed rather than waited on.
 * Awaiting a bare `browser.close()` here meant one wedged renderer hung the
 * shutdown it was supposed to be released by, until the supervisor's own SIGKILL
 * ended the process and left that Chromium reparented to init.
 */
export async function closeSharedBrowser(): Promise<void> {
  clearIdleTimer();
  closeCount += 1;
  current = undefined;
  await Promise.all([...leases.values()].map((lease) => beginReclaim(lease)));
}

/** One browser, as the pool currently understands it. */
export type BrowserPoolBrowserStatus = {
  generation: number;
  state: LeaseState;
  /** Renders still holding a context on it. */
  activeRenders: number;
  /** Contexts handed out from it, ever. */
  renders: number;
  pid: number | undefined;
};

export type BrowserPoolStatus = {
  browsers: BrowserPoolBrowserStatus[];
  /** Renders in flight, across every browser. */
  activeRenders: number;
  /** Renders waiting for a permit. */
  queuedRenders: number;
  availablePermits: number;
  /**
   * Chromium processes that answered neither `close()` nor SIGKILL, and are
   * therefore still out there. Anything in here is a leak an operator has to
   * know about; entries leave it if the process eventually dies.
   */
  abandonedProcesses: AbandonedProcess[];
};

/**
 * What the pool is holding right now.
 *
 * Reclaiming a wedged browser is only half the job — the other half is being
 * able to say that it happened. A stranded Chromium used to be invisible from
 * inside the process that stranded it, so it could only ever be found by looking
 * at the container's memory. Both entry points log
 * {@link BrowserPoolStatus.abandonedProcesses} after shutdown for that reason.
 */
export function browserPoolStatus(): BrowserPoolStatus {
  return {
    browsers: [...leases.values()].map((lease) => ({
      generation: lease.generation,
      state: lease.state,
      activeRenders: lease.active,
      renders: lease.renders,
      pid: lease.process?.pid
    })),
    activeRenders: activePages,
    queuedRenders: waiting.length,
    availablePermits: permits,
    abandonedProcesses: abandonedProcesses.map((record) => ({ ...record }))
  };
}

/**
 * Runs `render` on a fresh page of the shared browser, once, retrying once if
 * the browser goes away underneath it.
 *
 * The retry lives here rather than in either caller because the shared browser
 * is what created the need for it: with one browser per render, a crash could
 * only ever fail the job that owned it, and now it fails every render in flight.
 * The cover path is the one that made this non-negotiable — `renderCoverPng` is
 * called *outside* `generateCover`'s artwork fallback, and `GENERATE_COVER` is
 * not a derivative job, so an unretried disconnect there marks a finished, fully
 * paid book FAILED and refunds `FULL_BOOK_GENERATION` because some other job's
 * compile crashed Chromium.
 *
 * One retry is the whole budget: `compile-export` deliberately gets no
 * BullMQ-level retry, which would re-run final QA and re-spend real credits. A
 * watchdog timeout is not disconnect-shaped and is never retried — doubling a
 * 90-second hang helps nobody. `render` must therefore be safe to run twice;
 * both callers only produce bytes.
 */
export async function withRenderPage<T>(
  render: (page: Page) => Promise<T>,
  options: { timeoutMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
  // Capture this before joining the semaphore queue. A shutdown may happen
  // while this call is waiting; once a permit reaches it, that queued render
  // must drain without launching a replacement browser. A later, genuinely new
  // render observes the new count and may reuse the pool normally.
  const closesBefore = closeCount;
  await acquirePermit();
  if (closeCount !== closesBefore) {
    releasePermit();
    throw new Error("Render was cancelled because the shared browser was closed.");
  }
  activePages += 1;
  clearIdleTimer();
  try {
    try {
      return await renderOnce(render, timeoutMs);
    } catch (error) {
      // Not a retry when the pool was closed on purpose: at shutdown that would
      // launch a replacement browser and hold the process open.
      if (!isBrowserDisconnectError(error) || closeCount !== closesBefore) {
        throw error;
      }
      return await renderOnce(render, timeoutMs);
    }
  } finally {
    activePages -= 1;
    releasePermit();
    scheduleIdleClose();
  }
}

/**
 * One attempt.
 *
 * The context is closed exactly once, on every path — anything left in a
 * browser that outlives its render is a renderer process that never exits, and
 * the semaphore's whole job is to keep the number of those small. Closing the
 * *context* rather than the page is what makes that true of the whole render
 * and not just of the tab we handed out: a context takes its popups, its
 * workers and its storage with it, so nothing a manuscript opened can be
 * waiting in the browser the next book is rendered in. One bounded attempt
 * rather than two is also what keeps the wedged case from hanging here: a
 * second `close()` on a renderer that ignored the first never settles.
 */
async function renderOnce<T>(render: (page: Page) => Promise<T>, timeoutMs: number): Promise<T> {
  const lease = acquireLease();
  let context: BrowserContext | undefined;
  let contextClose: Promise<ContextCloseOutcome> | undefined;
  let acquisitionComplete = false;
  let deadlineExpired = false;

  const closeContext = (): Promise<ContextCloseOutcome> => {
    if (!context) {
      return Promise.resolve("closed");
    }
    contextClose ??= closeRenderContext(context);
    return contextClose;
  };

  const work = (async (): Promise<T> => {
    try {
      const browser = await lease.browser;
      if (deadlineExpired) {
        throw renderTimeoutError(timeoutMs);
      }
      context = await browser.createBrowserContext();
      if (deadlineExpired) {
        throw renderTimeoutError(timeoutMs);
      }
      const page = await context.newPage();
      if (deadlineExpired) {
        throw renderTimeoutError(timeoutMs);
      }
      acquisitionComplete = true;
      discardStrayTargets(context, page);
      return render(page);
    } finally {
      // Acquisition can finish after its watchdog has already won. In that
      // race the outer cleanup saw no context yet, so the late continuation is
      // responsible for closing what it just acquired.
      if (deadlineExpired) {
        const closed = await closeContext();
        if (closed === "timeout") {
          retireLease(lease);
        }
      }
    }
  })();
  // A timed-out CDP request may reject after the caller has already received
  // the watchdog error. Observe that loser so it cannot become an unhandled
  // rejection.
  work.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = Symbol("render-timeout");
    const outcome = await Promise.race([
      work,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
        timer.unref?.();
      })
    ]);
    if (outcome === timedOut) {
      deadlineExpired = true;
      // Acquisition failures are evidence that the shared CDP connection is
      // suspect. Remove it from service before releasing the semaphore permit,
      // so queued renders cannot all repeat the same 90-second failure.
      if (!acquisitionComplete) {
        retireLease(lease);
      }
      throw renderTimeoutError(timeoutMs);
    }
    return outcome as T;
  } catch (error) {
    if (!acquisitionComplete) {
      retireLease(lease);
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    const closed = await closeContext();
    lease.active -= 1;
    if (closed === "timeout") {
      // Something is still out there holding a renderer, and it does not matter
      // whether the render that opened it succeeded — a wedged renderer is
      // wedged. Retiring takes the browser out of service so it closes as soon
      // as its remaining renders come back, which reclaims the leak without
      // failing every render currently sharing it.
      retireLease(lease);
    } else {
      closeLeaseIfDrained(lease);
    }
  }
}

function renderTimeoutError(timeoutMs: number): Error {
  return new Error(`Render exceeded ${Math.round(timeoutMs / 1000)}s and was abandoned.`);
}

/**
 * Closes anything the rendered document opens for itself, as soon as it appears.
 *
 * The context teardown below is what guarantees none of it outlives the render,
 * but that is minutes away, and a `setInterval(() => window.open(...))` in
 * chapter one opens a tab every tick for the whole of the watchdog's 90 seconds
 * — hundreds of renderer processes inside a pool whose entire purpose is to cap
 * them at two. Closing on sight bounds the browser to the handful in flight at
 * any moment, and stops a popup that got as far as loading from going on to run
 * anything.
 *
 * Watching the *context* rather than the leased page is what catches a popup
 * opened by a popup. PDF rendering also disables JavaScript before navigation,
 * and PDF/EPUB markup is stripped of executable attributes; this remains a
 * defense-in-depth containment boundary for future renderers and regressions.
 */
function discardStrayTargets(context: BrowserContext, leased: Page): void {
  const leasedTarget = leased.target();
  context.on("targetcreated", (target: Target) => {
    if (target === leasedTarget) {
      return;
    }
    void target
      .page()
      .then((page) => page?.close())
      .catch(() => undefined);
  });
}

const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * How a render's teardown ended.
 *
 * `"failed"` and `"timeout"` are deliberately not the same answer. A rejected
 * close means the target is already gone — there is nothing left to reclaim, and
 * treating it as a wedged renderer would take a healthy browser out of service
 * over a page that had closed itself. Only a close that never settles is a
 * renderer still holding on.
 */
type ContextCloseOutcome = "closed" | "failed" | "timeout";

/**
 * Closes a render's context without ever hanging on it. A wedged renderer's
 * `close()` does not settle, so every close in this file is bounded.
 */
async function closeRenderContext(context: BrowserContext): Promise<ContextCloseOutcome> {
  const outcome = await withDeadline(
    context.close().then<ContextCloseOutcome, ContextCloseOutcome>(
      () => "closed",
      () => "failed"
    ),
    CONTEXT_CLOSE_TIMEOUT_MS
  );
  return outcome === TIMED_OUT ? "timeout" : outcome;
}

/**
 * Whether an error means the shared browser went away underneath a render.
 *
 * With a browser per render this could only ever affect the one job that owned
 * it. Pooled, one crash fails every concurrent render, which is why the PDF path
 * retries once on exactly these.
 */
export function isBrowserDisconnectError(error: unknown): boolean {
  // `TargetCloseError` is the only shape that means it. Puppeteer throws it from
  // every path where the far end went away — the callback registry being cleared
  // when the connection drops, a closed CDP session, a closed page — and its
  // message is sometimes phrased as a protocol error ("Protocol error (X):
  // Session closed."), which is why the class is what to look at.
  //
  // Its parent `ProtocolError` must *not* be matched. That is the generic CDP
  // failure — `Protocol error (Page.printToPDF): <whatever Chrome said>` — and,
  // worse, the protocol *timeout*. Retrying those buys nothing: they fail the
  // same way twice, and a timeout pays its whole budget again before saying so.
  if (error instanceof Error && error.name === "TargetCloseError") {
    return true;
  }
  // The message is the fallback for an error that lost its prototype crossing a
  // boundary. These strings are puppeteer's own; a bare "Protocol error" is
  // deliberately not among them.
  const message = error instanceof Error ? error.message : String(error);
  return /Target closed|Session closed|Connection closed/i.test(message);
}
