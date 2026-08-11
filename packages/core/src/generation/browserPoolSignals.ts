import { closeSharedBrowser } from "./browserPool.js";

type BrowserPoolShutdownSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

type SignalSource = {
  on(signal: BrowserPoolShutdownSignal, listener: () => void): unknown;
  off(signal: BrowserPoolShutdownSignal, listener: () => void): unknown;
};

export type BrowserPoolSignalHandlerOptions = {
  signalSource?: SignalSource;
  close?: () => Promise<void>;
  exit?: (code: number) => void;
  reportError?: (error: unknown) => void;
};

const SIGNAL_EXIT_CODES: Record<BrowserPoolShutdownSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143
};

/**
 * Gives short-lived renderer CLIs the signal cleanup Puppeteer no longer owns.
 *
 * The pool deliberately launches Chromium with Puppeteer's signal handlers
 * disabled so application shutdown has one owner. A script using the pool must
 * therefore close it itself before reproducing the conventional shell exit code
 * for the signal that stopped it.
 */
export function installSharedBrowserSignalHandlers(options: BrowserPoolSignalHandlerOptions = {}): () => void {
  const signalSource = options.signalSource ?? process;
  const close = options.close ?? closeSharedBrowser;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const reportError = options.reportError ?? ((error: unknown) => console.error("Browser cleanup failed:", error));
  const signals = Object.keys(SIGNAL_EXIT_CODES) as BrowserPoolShutdownSignal[];
  let shuttingDown = false;
  let installed = true;

  const handlers = new Map<BrowserPoolShutdownSignal, () => void>();
  const removeListeners = (): void => {
    if (!installed) {
      return;
    }
    installed = false;
    for (const [signal, handler] of handlers) {
      signalSource.off(signal, handler);
    }
  };

  for (const signal of signals) {
    const handler = (): void => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      void Promise.resolve()
        .then(close)
        .catch(reportError)
        .finally(() => {
          removeListeners();
          exit(SIGNAL_EXIT_CODES[signal]);
        });
    };
    handlers.set(signal, handler);
    signalSource.on(signal, handler);
  }

  // Do not remove the handlers while signal cleanup is in flight. A second
  // signal must not restore Node's default immediate exit and orphan Chromium.
  return () => {
    if (!shuttingDown) {
      removeListeners();
    }
  };
}
