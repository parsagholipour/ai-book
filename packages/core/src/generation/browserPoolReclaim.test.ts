import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserPoolStatus, closeSharedBrowser, withRenderPage } from "./browserPool.js";

/**
 * What happens to a browser the pool has decided to end.
 *
 * `browserPool.test.ts` covers the pool as a pool — leasing, recycling, the
 * retry, the context teardown. This file is only about the teardown *after*
 * that: a `close()` that never answers, a Chromium that outlives it, and the
 * shutdown that must not hang on either. Every wait here is a fake timer, so the
 * five- and two-second deadlines are asserted exactly rather than slept through.
 */

/** How a fake `close()` behaves. `"wedges"` is a renderer that ignores CDP. */
type CloseBehavior = "resolves" | "wedges" | "rejects";

type FakeChild = {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  /** Only `once`/`off` for `"exit"` are used, so only those are modelled. */
  once: (event: string, listener: () => void) => void;
  off: (event: string, listener: () => void) => void;
  /** The process really exiting, however it was asked to. */
  exit: (signal?: string) => void;
};

type FakeContext = {
  closed: boolean;
  newPage: () => Promise<FakePage>;
  on: (event: string, listener: (target: unknown) => void) => void;
  close: () => Promise<void>;
};

type FakePage = {
  closed: boolean;
  close: () => Promise<void>;
  target: () => unknown;
};

type FakeBrowser = {
  id: number;
  closed: boolean;
  closeCalls: number;
  contexts: FakeContext[];
  child: FakeChild;
  createBrowserContext: () => Promise<FakeContext>;
  on: (event: string, listener: () => void) => void;
  process: () => FakeChild;
  close: () => Promise<void>;
  /** Chromium going away underneath the pool. */
  crash: () => void;
};

const state = vi.hoisted(() => ({
  browsers: [] as unknown[],
  launches: 0,
  nextPid: 4100,
  /** Applied to every browser launched from now on. */
  browserClose: "resolves" as CloseBehavior,
  contextClose: "resolves" as CloseBehavior,
  /** The launch itself never lands until `releaseLaunch` is called. */
  hangLaunch: false,
  releaseLaunch: undefined as (() => void) | undefined,
  /** A Chromium that ignores SIGKILL — a wedged renderer in uninterruptible I/O. */
  ignoreKill: false,
  /** Pids the pool asked the operating system to kill, in order. */
  kills: [] as number[]
}));

// The one call that reaches past puppeteer to the operating system. A test may
// not send real signals, so this is the seam: `browserProcess.test.ts` proves
// the signalling itself against a real child process.
vi.mock("./browserProcess.js", () => ({
  terminateBrowserProcess: (child: FakeChild) => {
    state.kills.push(child.pid);
    if (child.exitCode !== null || child.signalCode !== null) {
      return "gone";
    }
    if (!state.ignoreKill) {
      child.exit("SIGKILL");
    }
    return "signalled";
  }
}));

vi.mock("puppeteer", () => ({
  default: {
    launch: async () => {
      state.launches += 1;
      if (state.hangLaunch) {
        await new Promise<void>((resolve) => {
          state.releaseLaunch = resolve;
        });
      }
      const exitListeners = new Set<() => void>();
      const child: FakeChild = {
        pid: (state.nextPid += 1),
        exitCode: null,
        signalCode: null,
        once: (event, listener) => {
          if (event === "exit") {
            exitListeners.add(listener);
          }
        },
        off: (_event, listener) => {
          exitListeners.delete(listener);
        },
        exit: (signal) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            return;
          }
          if (signal) {
            child.signalCode = signal;
          } else {
            child.exitCode = 0;
          }
          // Deleting as we go: `once` fires one time, and the pool's own
          // listener removal has to be visible to this loop.
          for (const listener of exitListeners) {
            exitListeners.delete(listener);
            listener();
          }
        }
      };
      const disconnectListeners: Array<() => void> = [];
      const browserClose = state.browserClose;
      const contextClose = state.contextClose;
      const browser: FakeBrowser = {
        id: state.launches,
        closed: false,
        closeCalls: 0,
        contexts: [],
        child,
        createBrowserContext: async () => {
          if (browser.closed) {
            const error = new Error("Target closed");
            error.name = "TargetCloseError";
            throw error;
          }
          const context: FakeContext = {
            closed: false,
            newPage: async () => {
              const page: FakePage = {
                closed: false,
                close: async () => {
                  page.closed = true;
                },
                target: () => ({})
              };
              return page;
            },
            on: () => undefined,
            close: async () => {
              if (contextClose === "wedges") {
                // A context whose renderer will not let go: the promise never
                // settles, which is exactly what a real one does.
                await new Promise<void>(() => undefined);
              }
              if (contextClose === "rejects") {
                throw new Error("Target closed");
              }
              context.closed = true;
            }
          };
          browser.contexts.push(context);
          return context;
        },
        on: (_event, listener) => {
          disconnectListeners.push(listener);
        },
        process: () => child,
        close: async () => {
          browser.closeCalls += 1;
          if (browserClose === "wedges") {
            // Puppeteer awaits the process's own exit here with no deadline of
            // its own, so a Chromium that never exits is a promise that never
            // settles.
            await new Promise<void>(() => undefined);
          }
          if (browserClose === "rejects") {
            throw new Error("Connection closed");
          }
          browser.closed = true;
          child.exit();
          browser.crash();
        },
        crash: () => {
          for (const listener of disconnectListeners.splice(0)) {
            listener();
          }
        }
      };
      state.browsers.push(browser);
      return browser;
    }
  }
}));

function browsers(): FakeBrowser[] {
  return state.browsers as FakeBrowser[];
}

/**
 * The pool's leak registry, by pid. The pool is module state, so the generation
 * counter keeps climbing across tests in this file; the pid is what identifies a
 * process.
 */
function abandonedPids(): Array<number | undefined> {
  return browserPoolStatus().abandonedProcesses.map((record) => record.pid);
}

/** Lets every already-resolvable continuation run without moving the clock. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
}

const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const PROCESS_EXIT_TIMEOUT_MS = 2_000;

beforeEach(() => {
  vi.useFakeTimers();
  state.browsers = [];
  state.launches = 0;
  state.browserClose = "resolves";
  state.contextClose = "resolves";
  state.hangLaunch = false;
  state.releaseLaunch = undefined;
  state.ignoreKill = false;
  state.kills = [];
});

afterEach(async () => {
  // Whatever a test left behind is reclaimed on the same bounded path
  // production uses, so a leak shows up as a failing assertion here rather than
  // as a hung suite.
  state.hangLaunch = false;
  state.ignoreKill = false;
  state.releaseLaunch?.();
  const closing = closeSharedBrowser();
  await vi.advanceTimersByTimeAsync(30_000);
  await closing;
  vi.useRealTimers();
});

describe("reclaiming a browser whose close() wedges", () => {
  it("keeps it tracked, kills its Chromium, and only then forgets it", async () => {
    // Both halves wedge — the page will not let the context go, and the browser
    // will not let the process go. This is the case that used to leave Chromium
    // untracked: the lease was dropped before an unbounded `close()` was fired
    // and forgotten, so nothing left in the process had a handle on it.
    state.contextClose = "wedges";
    state.browserClose = "wedges";

    const render = withRenderPage(async () => "ok");
    await vi.advanceTimersByTimeAsync(CONTEXT_CLOSE_TIMEOUT_MS);
    await expect(render).resolves.toBe("ok");

    const child = browsers()[0]!.child;
    const closing = browserPoolStatus();
    expect(closing.browsers).toHaveLength(1);
    expect(closing.browsers[0]!.state).toBe("closing");
    expect(closing.browsers[0]!.pid).toBe(child.pid);
    expect(closing.activeRenders).toBe(0);
    expect(state.kills).toEqual([]);

    // Still nothing at one tick short of the deadline: a browser gets its full
    // chance to close politely.
    await vi.advanceTimersByTimeAsync(BROWSER_CLOSE_TIMEOUT_MS - 1);
    expect(state.kills).toEqual([]);
    expect(browserPoolStatus().browsers).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(state.kills).toEqual([child.pid]);
    expect(child.signalCode).toBe("SIGKILL");
    // Reclaimed, so the pool is done being responsible for it.
    expect(browserPoolStatus().browsers).toEqual([]);
    expect(browserPoolStatus().abandonedProcesses).toEqual([]);
  });

  it("does not hang a shutdown on it", async () => {
    state.browserClose = "wedges";
    await withRenderPage(async () => "ok");

    let done = false;
    const shutdown = closeSharedBrowser().then(() => {
      done = true;
    });

    await settle();
    // Awaiting a bare `browser.close()` here is what hung a signal handler until
    // the supervisor's own SIGKILL — which left that Chromium reparented to init.
    expect(done).toBe(false);
    expect(browserPoolStatus().browsers[0]!.state).toBe("closing");

    await vi.advanceTimersByTimeAsync(BROWSER_CLOSE_TIMEOUT_MS);
    await shutdown;
    expect(done).toBe(true);
    expect(state.kills).toEqual([browsers()[0]!.child.pid]);
    expect(browserPoolStatus().browsers).toEqual([]);
  });

  it("reports a Chromium that survives SIGKILL, and forgets it when it finally dies", async () => {
    state.browserClose = "wedges";
    state.ignoreKill = true;
    await withRenderPage(async () => "ok");

    const closing = closeSharedBrowser();
    await vi.advanceTimersByTimeAsync(BROWSER_CLOSE_TIMEOUT_MS + PROCESS_EXIT_TIMEOUT_MS);
    await closing;

    const child = browsers()[0]!.child;
    expect(state.kills).toEqual([child.pid]);
    // Everything one process can do to another has been done. Saying so is the
    // whole of what is left, and it is what the entry points log.
    expect(abandonedPids()).toEqual([child.pid]);
    expect(browserPoolStatus().browsers).toEqual([]);

    // The registry is a statement about now, so a process that eventually dies
    // drops off it rather than accusing the pool forever.
    child.exit();
    await settle();
    expect(abandonedPids()).toEqual([]);
    // And nothing is left ticking on its behalf.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("kills a process that outlives a close() which answered", async () => {
    // `close()` resolving means the CDP request was accepted, not that Chromium
    // is gone. A process still up after that is one nobody else will reclaim.
    state.browserClose = "rejects";
    await withRenderPage(async () => "ok");
    const child = browsers()[0]!.child;

    const closing = closeSharedBrowser();
    await settle();
    // The grace after a settled close is the short one — Node needs a moment to
    // see an exit, and a browser killed in that moment is killed for finishing
    // normally.
    expect(state.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(PROCESS_EXIT_TIMEOUT_MS);
    await closing;

    expect(state.kills).toEqual([child.pid]);
    expect(browserPoolStatus().browsers).toEqual([]);
  });

  it("leaves a browser that closes normally alone", async () => {
    await withRenderPage(async () => "ok");
    const closing = closeSharedBrowser();
    await vi.advanceTimersByTimeAsync(BROWSER_CLOSE_TIMEOUT_MS);
    await closing;

    expect(state.kills).toEqual([]);
    expect(browsers()[0]!.closed).toBe(true);
    expect(browserPoolStatus().browsers).toEqual([]);
    expect(abandonedPids()).toEqual([]);
  });
});

describe("the pool while a reclaim is in flight", () => {
  it("closes and kills exactly once when release, disconnect, idle sweep and shutdown all land", async () => {
    state.browserClose = "wedges";

    // A render is still on the browser when it dies underneath everything else.
    const release: Array<() => void> = [];
    const inFlight = withRenderPage(async () => {
      await new Promise<void>((resolve) => release.push(resolve));
      return "ok";
    });
    while (release.length === 0) {
      await vi.advanceTimersByTimeAsync(1);
    }

    const browser = browsers()[0]!;
    browser.crash(); // disconnect
    browser.crash(); // and the duplicate event that follows it
    release[0]!();
    await settle();
    const sweep = closeSharedBrowser();
    const secondShutdown = closeSharedBrowser();
    await vi.advanceTimersByTimeAsync(BROWSER_CLOSE_TIMEOUT_MS);
    await Promise.all([inFlight, sweep, secondShutdown]);

    // One reclaim, however many paths asked for it. A second `close()` on a
    // renderer that ignored the first never settles.
    expect(browser.closeCalls).toBe(1);
    expect(state.kills).toEqual([browser.child.pid]);
    expect(browserPoolStatus().browsers).toEqual([]);
  });

  it("never leases a browser that is being reclaimed", async () => {
    state.contextClose = "wedges";
    state.browserClose = "wedges";

    const wedged = withRenderPage(async () => "first");
    await vi.advanceTimersByTimeAsync(CONTEXT_CLOSE_TIMEOUT_MS);
    await expect(wedged).resolves.toBe("first");
    expect(browserPoolStatus().browsers[0]!.state).toBe("closing");

    state.contextClose = "resolves";
    state.browserClose = "resolves";
    await expect(withRenderPage(async () => "second")).resolves.toBe("second");

    // The second render went to a browser of its own; a closing one would have
    // had its pages taken out from under it mid-render.
    expect(state.launches).toBe(2);
    expect(browsers()[0]!.contexts).toHaveLength(1);
    expect(browsers()[1]!.contexts).toHaveLength(1);
  });

  it("still runs at most two renders at once", async () => {
    // Four large books typesetting in one Chromium is the OOM this exists to
    // prevent, and a reclaim in flight must not buy anyone an extra slot.
    state.browserClose = "wedges";
    await withRenderPage(async () => "warm");
    browsers()[0]!.crash();
    await settle();
    expect(browserPoolStatus().browsers[0]!.state).toBe("closing");

    let running = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const renders = Array.from({ length: 5 }, () =>
      withRenderPage(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => release.push(resolve));
        running -= 1;
        return "done";
      })
    );

    while (release.length < 2) {
      await vi.advanceTimersByTimeAsync(1);
    }
    while (release.length > 0 || running > 0) {
      release.shift()?.();
      await vi.advanceTimersByTimeAsync(1);
    }
    await expect(Promise.all(renders)).resolves.toHaveLength(5);

    expect(peak).toBeLessThanOrEqual(2);
    expect(browserPoolStatus().availablePermits).toBe(2);
    expect(browserPoolStatus().queuedRenders).toBe(0);
  });

  it("finishes reclaiming a browser whose launch had not landed at shutdown", async () => {
    // Nothing exists to close or to kill yet, and a shutdown may not sit out a
    // launch already taking longer than the whole reclaim budget — but the lease
    // may not be dropped either, or the browser it is about to become is the
    // leak all over again.
    state.hangLaunch = true;
    const render = withRenderPage(async () => "never runs");
    await settle();

    const closing = closeSharedBrowser();
    await vi.advanceTimersByTimeAsync(BROWSER_CLOSE_TIMEOUT_MS);
    await closing;

    const tracked = browserPoolStatus().browsers;
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.state).toBe("closing");
    expect(tracked[0]!.pid).toBeUndefined();

    state.releaseLaunch?.();
    await vi.advanceTimersByTimeAsync(BROWSER_CLOSE_TIMEOUT_MS);
    // Whether the render got its context in before the close landed is a race
    // it is allowed to lose either way; a render in flight at shutdown fails,
    // which is what a shutdown means.
    await render.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(BROWSER_CLOSE_TIMEOUT_MS);

    // The browser that finally arrived was closed and let go of.
    expect(browsers()[0]!.closed).toBe(true);
    expect(browserPoolStatus().browsers).toEqual([]);
    expect(abandonedPids()).toEqual([]);
  });
});
