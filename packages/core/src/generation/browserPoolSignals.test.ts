import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installSharedBrowserSignalHandlers } from "./browserPoolSignals.js";

async function settle(): Promise<void> {
  for (let tick = 0; tick < 6; tick += 1) {
    await Promise.resolve();
  }
}

describe("installSharedBrowserSignalHandlers", () => {
  it.each([
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143]
  ] as const)("closes Chromium before exiting for %s", async (signal, exitCode) => {
    const source = new EventEmitter();
    let finishClose: (() => void) | undefined;
    const close = vi.fn(() => new Promise<void>((resolve) => (finishClose = resolve)));
    const exit = vi.fn();
    const remove = installSharedBrowserSignalHandlers({ signalSource: source, close, exit });

    source.emit(signal);
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();

    // Even an ordinary script finally block cannot remove the handlers while
    // signal cleanup is still reclaiming the browser. A second signal remains
    // trapped rather than restoring Node's default immediate exit.
    remove();
    source.emit("SIGTERM");
    expect(close).toHaveBeenCalledOnce();
    finishClose?.();
    await settle();
    expect(exit).toHaveBeenCalledWith(exitCode);
  });

  it("still exits after reporting a cleanup failure", async () => {
    const source = new EventEmitter();
    const error = new Error("close failed");
    const reportError = vi.fn();
    const exit = vi.fn();
    installSharedBrowserSignalHandlers({
      signalSource: source,
      close: async () => Promise.reject(error),
      exit,
      reportError
    });

    source.emit("SIGINT");
    await settle();
    expect(reportError).toHaveBeenCalledWith(error);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("can be removed after normal script completion", async () => {
    const source = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const remove = installSharedBrowserSignalHandlers({ signalSource: source, close, exit: vi.fn() });

    remove();
    source.emit("SIGHUP");
    await settle();
    expect(close).not.toHaveBeenCalled();
  });
});
