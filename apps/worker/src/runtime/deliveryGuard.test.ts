import { DelayedError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { createDeliveryGuard, DUPLICATE_DELIVERY_DEFER_MS } from "./deliveryGuard.js";

function delivery(generationJobId: string | undefined, bullId = generationJobId) {
  return {
    id: bullId,
    name: "generate-book",
    data: generationJobId ? { generationJobId, projectId: "project-1" } : {},
    moveToDelayed: vi.fn(async () => undefined)
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("createDeliveryGuard", () => {
  it("defers a second concurrent delivery of a running row back to Bull, without running it", async () => {
    const guard = createDeliveryGuard({ now: () => 1_000 });
    const first = deferred();
    const processor = vi.fn(async (job: ReturnType<typeof delivery>) => {
      if (job === original) await first.promise;
    });
    const run = guard.wrap(processor);
    const original = delivery("gj-1");
    const reclaimed = delivery("gj-1");

    const running = run(original, "token-1");
    await expect(run(reclaimed, "token-2")).rejects.toBeInstanceOf(DelayedError);

    // Moved with its own token, so BullMQ records no failure and spends no attempt.
    expect(reclaimed.moveToDelayed).toHaveBeenCalledWith(1_000 + DUPLICATE_DELIVERY_DEFER_MS, "token-2");
    expect(processor).toHaveBeenCalledTimes(1);
    expect(guard.running().has("gj-1")).toBe(true);

    first.release();
    await running;
    expect(guard.running().size).toBe(0);
  });

  it("never refuses the redelivery that comes after the first one ended — success or throw", async () => {
    const guard = createDeliveryGuard();
    let calls = 0;
    const run = guard.wrap(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network");
    });
    await expect(run(delivery("gj-1"), "t1")).rejects.toThrow("network");
    // A BullMQ retry, or the deferred copy coming back from `delayed`.
    const retry = delivery("gj-1");
    await expect(run(retry, "t2")).resolves.toBeUndefined();
    expect(retry.moveToDelayed).not.toHaveBeenCalled();
    expect(calls).toBe(2);
  });

  it("holds the same row across lanes and lets different rows run side by side", async () => {
    const guard = createDeliveryGuard();
    const gate = deferred();
    const run = guard.wrap(async (job: ReturnType<typeof delivery>) => {
      if (job.id === "gj-1") await gate.promise;
    });
    const first = run(delivery("gj-1"), "a");
    // Another row runs at once; a legacy Bull id of the same row (old queue) is held.
    await expect(run(delivery("gj-2"), "b")).resolves.toBeUndefined();
    const legacyCopy = delivery("gj-1", "14");
    await expect(run(legacyCopy, "c")).rejects.toBeInstanceOf(DelayedError);
    gate.release();
    await first;
  });

  it("passes a delivery that names no row straight through", async () => {
    const guard = createDeliveryGuard();
    const processor = vi.fn(async () => undefined);
    const run = guard.wrap(processor);
    await run({ ...delivery(undefined), id: undefined }, "t");
    await run({ ...delivery(undefined), id: undefined }, "t");
    expect(processor).toHaveBeenCalledTimes(2);
  });
});
