import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundSweeps } from "./backgroundSweeps.js";

const log = () => ({ warn: vi.fn() });

afterEach(() => {
  vi.useRealTimers();
});

describe("background sweeps", () => {
  it("lets the API listen while a sweep's first pass hangs", async () => {
    const hanging = vi.fn(() => new Promise<never>(() => undefined));
    const quick = vi.fn(async () => undefined);
    const sweeps = createBackgroundSweeps(
      [
        { name: "attachments", intervalMs: 60_000, run: hanging },
        { name: "voice_calls", intervalMs: 60_000, run: quick }
      ],
      log()
    );
    const app = Fastify();
    app.get("/api/health", async () => ({ ok: true }));
    try {
      // The boot order server.ts follows: listen, then start the sweeps.
      await app.listen({ host: "127.0.0.1", port: 0 });
      expect(sweeps.start()).toBeUndefined();
      await vi.waitFor(() => expect(hanging).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(quick).toHaveBeenCalledOnce());
      const response = await fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/health`);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      sweeps.stop();
      await app.close();
    }
  });

  it("never awaits a pass from start(), even one that was due at once", () => {
    const run = vi.fn(async () => undefined);
    const sweeps = createBackgroundSweeps([{ name: "renewals", intervalMs: 1_000, run }], log());
    sweeps.start();
    // The first pass is on a later tick, so nothing written after start() can wait on it.
    expect(run).not.toHaveBeenCalled();
    sweeps.stop();
  });

  it("skips a tick while the previous pass is still running, then resumes", async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const sweeps = createBackgroundSweeps([{ name: "deletions", intervalMs: 1_000, run }], log());
    sweeps.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    sweeps.stop();
  });

  it("logs a failing pass under its own name and keeps the schedule", async () => {
    vi.useFakeTimers();
    const logger = log();
    const run = vi.fn(async () => {
      throw new Error("S3 unavailable");
    });
    const sweeps = createBackgroundSweeps([{ name: "storage_deletions", intervalMs: 1_000, run }], logger);
    sweeps.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "storage_deletions_failed", err: expect.any(Error) }),
      expect.any(String)
    );
    sweeps.stop();
  });

  it("waits out an initial delay, and stop() ends the schedule", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const sweeps = createBackgroundSweeps([{ name: "prune", intervalMs: 10_000, initialDelayMs: 5_000, run }], log());
    sweeps.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    sweeps.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs one pass on demand, refusing to double a running one", async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const sweeps = createBackgroundSweeps([{ name: "mail", intervalMs: 60_000, run }], log());
    const first = sweeps.runNow("mail");
    await expect(sweeps.runNow("mail")).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    await expect(sweeps.runNow("missing")).rejects.toThrow("No background sweep named missing");
  });
});
