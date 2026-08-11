import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserPoolStatus,
  closeSharedBrowser,
  isBrowserDisconnectError,
  withRenderPage
} from "./browserPool.js";

type FakeTarget = {
  type: () => string;
  page: () => Promise<FakePage>;
};

type FakePage = {
  closed: boolean;
  closeCalls: number;
  /** When set, `close()` never settles — a wedged renderer. */
  hangOnClose: boolean;
  /** When set, `close()` rejects — the target was already gone. */
  rejectOnClose: boolean;
  close: () => Promise<void>;
  target: () => FakeTarget;
};

/**
 * A render's own slice of the browser. Closing it closes its pages, which is
 * how a real context takes a manuscript's popups with it.
 */
type FakeContext = {
  closed: boolean;
  pages: FakePage[];
  listeners: Array<(target: FakeTarget) => void>;
  newPage: () => Promise<FakePage>;
  on: (event: string, listener: (target: FakeTarget) => void) => void;
  close: () => Promise<void>;
  /** Simulates the rendered document calling `window.open`. */
  openStrayWindow: () => FakePage;
};

type FakeBrowser = {
  id: number;
  closed: boolean;
  /** Set when the pool closed it while a page was still open on it. */
  closedWithOpenPages: boolean;
  contexts: FakeContext[];
  pages: FakePage[];
  listeners: Array<() => void>;
  createBrowserContext: () => Promise<FakeContext>;
  on: (event: string, listener: () => void) => void;
  /**
   * The pool captures this to reclaim a browser whose `close()` wedges. Nothing
   * here wedges one, so there is no process to model — `browserPoolReclaim.test.ts`
   * is where a real Chromium handle is stood in for.
   */
  process: () => null;
  close: () => Promise<void>;
  /** Simulates Chromium dying underneath the pool. */
  crash: () => void;
};

const state = vi.hoisted(() => ({
  browsers: [] as unknown[],
  launchOptions: [] as unknown[],
  launches: 0,
  failNextLaunches: 0,
  contextAcquisition: "resolves" as "resolves" | "rejects" | "wedges",
  pageAcquisition: "resolves" as "resolves" | "rejects" | "wedges",
  hangPageClose: false,
  rejectPageClose: false
}));

vi.mock("puppeteer", () => ({
  default: {
    launch: async (options: unknown) => {
      state.launchOptions.push(options);
      state.launches += 1;
      if (state.failNextLaunches > 0) {
        state.failNextLaunches -= 1;
        throw new Error("Failed to launch the browser process!");
      }
      const browser: FakeBrowser = {
        id: state.launches,
        closed: false,
        closedWithOpenPages: false,
        contexts: [],
        pages: [],
        listeners: [],
        createBrowserContext: async () => {
          if (state.contextAcquisition === "rejects") {
            throw new Error("Protocol error (Target.createBrowserContext): acquisition failed");
          }
          if (state.contextAcquisition === "wedges") {
            await new Promise<void>(() => undefined);
          }
          const context: FakeContext = {
            closed: false,
            pages: [],
            listeners: [],
            newPage: async () => {
              if (state.pageAcquisition === "rejects") {
                throw new Error("Protocol error (Target.createTarget): acquisition failed");
              }
              if (state.pageAcquisition === "wedges") {
                await new Promise<void>(() => undefined);
              }
              return newFakePage(browser, context);
            },
            on: (_event, listener) => {
              context.listeners.push(listener);
            },
            close: async () => {
              // A real `BrowserContext.close()` takes its pages with it, so a
              // page that will not close is a context that will not close.
              await Promise.all(context.pages.map((page) => page.close()));
              context.closed = true;
            },
            openStrayWindow: () => {
              const stray = newFakePage(browser, context);
              for (const listener of context.listeners) {
                listener(stray.target());
              }
              return stray;
            }
          };
          browser.contexts.push(context);
          return context;
        },
        on: (_event, listener) => {
          browser.listeners.push(listener);
        },
        process: () => null,
        close: async () => {
          if (browser.pages.some((page) => !page.closed && !page.hangOnClose)) {
            browser.closedWithOpenPages = true;
          }
          browser.closed = true;
          browser.crash();
        },
        crash: () => {
          for (const listener of browser.listeners.splice(0)) {
            listener();
          }
        }
      };
      state.browsers.push(browser);
      return browser;
    }
  }
}));

function newFakePage(browser: FakeBrowser, context: FakeContext): FakePage {
  const page: FakePage = {
    closed: false,
    closeCalls: 0,
    hangOnClose: state.hangPageClose,
    rejectOnClose: state.rejectPageClose,
    close: async () => {
      page.closeCalls += 1;
      if (page.hangOnClose) {
        await new Promise<void>(() => undefined);
      }
      if (page.rejectOnClose) {
        throw new Error("Target closed");
      }
      page.closed = true;
    },
    target: () => target
  };
  const target: FakeTarget = {
    type: () => "page",
    page: async () => page
  };
  context.pages.push(page);
  browser.pages.push(page);
  return page;
}

function browsers(): FakeBrowser[] {
  return state.browsers as FakeBrowser[];
}

beforeEach(() => {
  state.browsers = [];
  state.launchOptions = [];
  state.launches = 0;
  state.failNextLaunches = 0;
  state.contextAcquisition = "resolves";
  state.pageAcquisition = "resolves";
  state.hangPageClose = false;
  state.rejectPageClose = false;
});

afterEach(async () => {
  state.hangPageClose = false;
  state.rejectPageClose = false;
  await closeSharedBrowser();
});

describe("withRenderPage", () => {
  it("reuses one browser across renders and closes every page", async () => {
    await withRenderPage(async () => "a");
    await withRenderPage(async () => "b");
    await withRenderPage(async () => "c");

    expect(state.launches).toBe(1);
    const [browser] = browsers();
    expect(browser!.pages).toHaveLength(3);
    expect(browser!.pages.every((page) => page.closed)).toBe(true);
  });

  it("closes the page when the render throws", async () => {
    await expect(
      withRenderPage(async () => {
        throw new Error("render blew up");
      })
    ).rejects.toThrow("render blew up");

    // A leaked page in a browser that outlives the job is a renderer process
    // that never exits.
    expect(browsers()[0]!.pages[0]!.closed).toBe(true);
  });

  it("gives every render its own browser context and throws it away after", async () => {
    await withRenderPage(async () => "a");
    await withRenderPage(async () => "b");

    // The page is not the unit a manuscript is confined to — popups, workers and
    // storage all belong to the context, so the context is what gets discarded.
    const [browser] = browsers();
    expect(browser!.contexts).toHaveLength(2);
    expect(browser!.contexts.every((context) => context.closed)).toBe(true);
    expect(browser!.contexts.every((context) => context.pages.every((page) => page.closed))).toBe(true);
  });

  it("closes a window the rendered content opened, without waiting for the render", async () => {
    // PDF rendering disables JavaScript and manuscript markup strips executable
    // attributes. The pool still owns containment for any future renderer or
    // sanitizer regression that manages to open another page.
    let stray: FakePage | undefined;

    await withRenderPage(async () => {
      const context = browsers()[0]!.contexts[0]!;
      stray = context.openStrayWindow();
      // A `setInterval(() => window.open(...))` gets a tab per tick for the whole
      // of the watchdog's 90 seconds, so waiting for the teardown is not enough.
      await Promise.resolve();
      await Promise.resolve();
      return "ok";
    });

    expect(stray!.closed).toBe(true);
  });

  it("does not close the page it leased", async () => {
    // The listener watches the whole context, which is what catches a popup
    // opened by a popup — and is also why it has to recognise its own page.
    const result = await withRenderPage(async (page) => {
      const context = browsers()[0]!.contexts[0]!;
      for (const listener of context.listeners) {
        listener((page as unknown as FakePage).target());
      }
      await Promise.resolve();
      await Promise.resolve();
      expect((page as unknown as FakePage).closed).toBe(false);
      return "still here";
    });

    expect(result).toBe("still here");
  });

  it("launches a fresh browser after the current one disconnects", async () => {
    await withRenderPage(async () => "a");
    browsers()[0]!.crash();

    await withRenderPage(async () => "b");

    expect(state.launches).toBe(2);
  });

  it("does not let a stale disconnect clear a newer browser", async () => {
    await withRenderPage(async () => "a");
    const first = browsers()[0]!;
    first.crash();
    await withRenderPage(async () => "b");
    expect(state.launches).toBe(2);

    // The old browser's handler fires again — from a duplicate event, or a
    // close racing the reset. It must not evict the browser now in use.
    first.crash();
    await withRenderPage(async () => "c");

    expect(state.launches).toBe(2);
  });

  it("does not cache a failed launch", async () => {
    state.failNextLaunches = 1;
    await expect(withRenderPage(async () => "a")).rejects.toThrow(/Failed to launch/);

    // A cached rejected promise would fail every render for the rest of the
    // process lifetime.
    await expect(withRenderPage(async () => "b")).resolves.toBe("b");
    expect(state.launches).toBe(2);
  });

  it("bounds Puppeteer's CDP requests to the render budget", async () => {
    await withRenderPage(async () => "ok");

    expect(state.launchOptions[0]).toMatchObject({ protocolTimeout: 90_000 });
  });

  it.each(["context", "page"] as const)(
    "includes %s acquisition in the watchdog and gives queued work a fresh browser",
    async (stage) => {
      if (stage === "context") {
        state.contextAcquisition = "wedges";
      } else {
        state.pageAcquisition = "wedges";
      }
      let callbackRan = false;

      await expect(
        withRenderPage(
          async () => {
            callbackRan = true;
            return "never";
          },
          { timeoutMs: 20 }
        )
      ).rejects.toThrow(/abandoned/);

      expect(callbackRan).toBe(false);
      expect(browsers()[0]!.closed).toBe(true);
      if (stage === "context") {
        state.contextAcquisition = "resolves";
      } else {
        state.pageAcquisition = "resolves";
      }
      await expect(withRenderPage(async () => "next")).resolves.toBe("next");
      expect(state.launches).toBe(2);
    }
  );

  it.each(["context", "page"] as const)("retires the browser when %s acquisition rejects", async (stage) => {
    if (stage === "context") {
      state.contextAcquisition = "rejects";
    } else {
      state.pageAcquisition = "rejects";
    }

    await expect(withRenderPage(async () => "never")).rejects.toThrow(/acquisition failed/);
    expect(browsers()[0]!.closed).toBe(true);

    if (stage === "context") {
      state.contextAcquisition = "resolves";
    } else {
      state.pageAcquisition = "resolves";
    }
    await expect(withRenderPage(async () => "next")).resolves.toBe("next");
    expect(state.launches).toBe(2);
  });

  it("runs at most two renders at once", async () => {
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

    // Let the first wave claim its permits, then drain.
    while (release.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    while (release.length > 0 || running > 0) {
      release.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    await Promise.all(renders);
    // Four simultaneous large books in one Chromium is an OOM that takes all
    // four down; the queue is the point.
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("cancels a queued render when the pool closes without disabling later reuse", async () => {
    let entered = 0;
    let markTwoEntered: (() => void) | undefined;
    const twoEntered = new Promise<void>((resolve) => {
      markTwoEntered = resolve;
    });
    let releaseHeld: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const holdPermit = () =>
      withRenderPage(async () => {
        entered += 1;
        if (entered === 2) {
          markTwoEntered?.();
        }
        await held;
        return "held";
      });

    const first = holdPermit();
    const second = holdPermit();
    await twoEntered;

    let queuedCallbackRan = false;
    const queued = withRenderPage(async () => {
      queuedCallbackRan = true;
      return "queued";
    });
    // Observe the queue rather than relying on promise scheduling: the
    // regression only exists when this render joined before shutdown.
    while (browserPoolStatus().queuedRenders !== 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const queuedOutcome = queued.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    );

    await closeSharedBrowser();
    releaseHeld?.();
    await expect(Promise.all([first, second])).resolves.toEqual(["held", "held"]);

    const outcome = await queuedOutcome;
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toMatch(/cancelled.*browser.*closed/i);
    expect(queuedCallbackRan).toBe(false);
    expect(state.launches).toBe(1);
    expect(browserPoolStatus()).toMatchObject({
      browsers: [],
      activeRenders: 0,
      queuedRenders: 0,
      availablePermits: 2
    });

    // `closeSharedBrowser` is also used for idle cleanup, so it is a generation
    // boundary rather than a permanent shutdown flag.
    await expect(withRenderPage(async () => "after-close")).resolves.toBe("after-close");
    expect(state.launches).toBe(2);
  });

  it("recycles the browser while the pool stays busy", async () => {
    // The regression this guards: recycling used to close the browser inline,
    // which it could only do when no other render was in flight. With the
    // semaphore at 2 a busy worker always has one, so 60 renders came back on a
    // single Chromium that had been told to recycle after 50.
    const renders = Array.from({ length: 60 }, () =>
      withRenderPage(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return "ok";
      })
    );

    await expect(Promise.all(renders)).resolves.toHaveLength(60);
    // 50 renders on the first browser, 10 on the second.
    expect(state.launches).toBe(2);
    expect(browsers()[0]!.pages).toHaveLength(50);
    expect(browsers()[1]!.pages).toHaveLength(10);
  }, 30_000);

  it("never closes a retired browser out from under a render still using it", async () => {
    const renders = Array.from({ length: 60 }, () =>
      withRenderPage(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return "ok";
      })
    );
    await Promise.all(renders);

    const [retired, live] = browsers();
    // Retiring hands the next render a fresh browser immediately and closes
    // this one only once its own last page comes back.
    expect(retired!.closed).toBe(true);
    expect(retired!.closedWithOpenPages).toBe(false);
    expect(retired!.pages.every((page) => page.closed)).toBe(true);
    // The replacement is still in service.
    expect(live!.closed).toBe(false);
  }, 30_000);

  it("retries a render once when the browser dies underneath it", async () => {
    // Every caller gets this, not just the PDF path. `renderCoverPng` runs
    // outside `generateCover`'s artwork fallback and GENERATE_COVER is not a
    // derivative job, so an unretried disconnect there marks a finished, paid
    // book FAILED because some other job's compile crashed Chromium.
    let attempts = 0;
    const result = await withRenderPage(async () => {
      attempts += 1;
      if (attempts === 1) {
        // What a real disconnect is: Chromium goes away, and the in-flight
        // render finds out by way of a TargetCloseError.
        browsers()[0]!.crash();
        const error = new Error("Target closed");
        error.name = "TargetCloseError";
        throw error;
      }
      return "cover-png";
    });

    expect(result).toBe("cover-png");
    expect(attempts).toBe(2);
    // The dead browser was evicted, so the retry got a fresh one.
    expect(state.launches).toBe(2);
  });

  it("retries only once, then reports the failure", async () => {
    let attempts = 0;
    const disconnect = () => {
      const error = new Error("Session closed");
      error.name = "TargetCloseError";
      return error;
    };

    await expect(
      withRenderPage(async () => {
        attempts += 1;
        throw disconnect();
      })
    ).rejects.toThrow(/Session closed/);
    // One retry is the whole budget: compile-export gets no BullMQ retry either,
    // because that would re-run final QA and re-spend real credits.
    expect(attempts).toBe(2);
  });

  it("does not retry an ordinary render failure", async () => {
    let attempts = 0;

    await expect(
      withRenderPage(async () => {
        attempts += 1;
        throw new Error("the page threw");
      })
    ).rejects.toThrow("the page threw");
    expect(attempts).toBe(1);
  });

  it("does not retry into a new browser when the pool was closed on purpose", async () => {
    // At shutdown the disconnect is deliberate; launching a replacement would
    // hold the event loop open for the whole idle window.
    let attempts = 0;

    await expect(
      withRenderPage(async () => {
        attempts += 1;
        await closeSharedBrowser();
        const error = new Error("Target closed");
        error.name = "TargetCloseError";
        throw error;
      })
    ).rejects.toThrow(/Target closed/);

    expect(attempts).toBe(1);
    expect(state.launches).toBe(1);
  });

  it("retires the browser when a page will not close after a successful render", async () => {
    // A wedged renderer is wedged whether or not the render that opened it
    // worked. Ignoring the close outcome here left the page open in a
    // long-lived Chromium — the pool's own accounting said it was gone — for up
    // to fifty renders, which is a pile of renderer processes the semaphore
    // exists to prevent.
    state.hangPageClose = true;
    await expect(withRenderPage(async () => "ok")).resolves.toBe("ok");

    state.hangPageClose = false;
    await expect(withRenderPage(async () => "next")).resolves.toBe("next");

    // The browser holding the stuck page is out of service and gone, and the
    // replacement is serving.
    expect(state.launches).toBe(2);
    expect(browsers()[0]!.closed).toBe(true);
    expect(browsers()[1]!.closed).toBe(false);
  }, 20_000);

  it("keeps the browser when a page close merely fails", async () => {
    // A rejected close means the target had already gone; there is nothing
    // leaked, and retiring would take a healthy browser away from every render
    // sharing it.
    state.rejectPageClose = true;

    await expect(withRenderPage(async () => "a")).resolves.toBe("a");
    await expect(withRenderPage(async () => "b")).resolves.toBe("b");

    expect(state.launches).toBe(1);
    expect(browsers()[0]!.closed).toBe(false);
  });

  it("abandons a render that overruns its watchdog", async () => {
    const render = withRenderPage(async () => new Promise<string>(() => undefined), { timeoutMs: 20 });

    await expect(render).rejects.toThrow(/exceeded 0s and was abandoned|abandoned/);
    expect(browsers()[0]!.pages[0]!.closeCalls).toBeGreaterThan(0);
  });

  it("destroys the browser when a timed-out page will not close", async () => {
    state.hangPageClose = true;

    await expect(
      withRenderPage(async () => new Promise<string>(() => undefined), { timeoutMs: 20 })
    ).rejects.toThrow(/abandoned/);

    // A page that will not close means a wedged renderer, so the whole browser
    // goes and the pool resets for whoever comes next.
    expect(browsers()[0]!.closed).toBe(true);
    state.hangPageClose = false;
    await withRenderPage(async () => "next");
    expect(state.launches).toBe(2);
  }, 15_000);

  it("does not leave a browser behind after closeSharedBrowser", async () => {
    await withRenderPage(async () => "a");
    await closeSharedBrowser();

    expect(browsers()[0]!.closed).toBe(true);
    await closeSharedBrowser();
    expect(state.launches).toBe(1);
  });
});

/** Puppeteer sets `name` from the constructor, so this is what it throws. */
function puppeteerError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("isBrowserDisconnectError", () => {
  it("recognises the shapes puppeteer reports a dead browser as", () => {
    // Every one of these is a real `TargetCloseError` construction in
    // puppeteer-core 25: the callback registry clearing when the connection
    // drops, a closed session, a closed page.
    for (const message of [
      "Target closed",
      "Protocol error (Page.printToPDF): Session closed. Most likely the page has been closed.",
      "Protocol error (Runtime.callFunctionOn): Session with given id not found.",
      "Page closed!"
    ]) {
      expect(isBrowserDisconnectError(puppeteerError("TargetCloseError", message)), message).toBe(true);
    }
    // And by message alone, for an error that lost its prototype on the way.
    expect(isBrowserDisconnectError(new Error("Target closed while printing"))).toBe(true);
    expect(isBrowserDisconnectError(new Error("Connection closed"))).toBe(true);
  });

  it("does not treat an ordinary protocol failure as a dead browser", () => {
    // `ProtocolError` is the generic CDP failure, and `TargetCloseError`
    // extends it — so matching the parent covered nothing the child did not,
    // and handed a full extra render attempt to errors that fail the same way
    // twice. The timeout is the expensive one: it pays its whole budget again.
    expect(
      isBrowserDisconnectError(puppeteerError("ProtocolError", "Protocol error (Page.printToPDF): Printing failed"))
    ).toBe(false);
    expect(
      isBrowserDisconnectError(
        puppeteerError(
          "ProtocolError",
          "Page.printToPDF timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed."
        )
      )
    ).toBe(false);
    expect(
      isBrowserDisconnectError(puppeteerError("ProtocolError", "Protocol error (Page.navigate): Cannot navigate to invalid URL"))
    ).toBe(false);
  });

  it("does not claim ordinary render failures", () => {
    expect(isBrowserDisconnectError(new Error("Navigation timeout of 30000 ms exceeded"))).toBe(false);
    expect(isBrowserDisconnectError(new Error("ENOENT: no such file"))).toBe(false);
    expect(isBrowserDisconnectError(new Error("Render exceeded 90s and was abandoned."))).toBe(false);
  });
});
