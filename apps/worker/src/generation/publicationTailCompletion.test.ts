import { describe, expect, it, vi } from "vitest";
import {
  completeOrWaitPublicationTailLease,
  publicationTailCompletion,
  type PublicationTail
} from "./publicationTailCompletion.js";

function tail(overrides: Partial<PublicationTail> = {}) {
  const events: string[] = [];
  const assertHeld = vi.fn(async () => {
    events.push("assert");
  });
  const adapter: PublicationTail = {
    startHeartbeat: vi.fn(() => {
      events.push("start");
      return {
        assertHeld,
        stop: vi.fn(async () => {
          events.push("stop");
        })
      };
    }),
    run: vi.fn(async (assertLease) => {
      events.push("run");
      await assertLease();
    }),
    completeLease: vi.fn(async () => {
      events.push("complete");
    }),
    invalidateExports: vi.fn(async () => {
      events.push("invalidate");
    }),
    releaseLease: vi.fn(async () => {
      events.push("release");
      return true;
    }),
    abandonExportBarrier: vi.fn(async () => {
      events.push("abandon");
    }),
    reportFailure: vi.fn((phase) => {
      events.push(`report:${phase}`);
    }),
    ...overrides
  };
  return { adapter, assertHeld, events };
}

describe("publicationTailCompletion", () => {
  it("builds committed metadata and completes the lease after the tail", async () => {
    const fixture = tail();
    const completion = publicationTailCompletion(fixture.adapter);

    await expect(completion.afterJobCompleted?.()).resolves.toBeUndefined();

    expect(completion).toMatchObject({
      durableCompletionCommitted: true,
      lifecycleCompletionCommitted: true,
      retryFollowUpOnRedelivery: true
    });
    expect(fixture.events).toEqual(["start", "run", "assert", "complete", "stop"]);
    expect(fixture.adapter.run).toHaveBeenCalledWith(fixture.assertHeld);
  });

  it("can leave durable completion to the worker lifecycle", () => {
    const completion = publicationTailCompletion(tail().adapter, {
      durableCompletionCommitted: false
    });

    expect(completion).not.toHaveProperty("durableCompletionCommitted");
    expect(completion).not.toHaveProperty("lifecycleCompletionCommitted");
    expect(completion.retryFollowUpOnRedelivery).toBe(true);
  });

  it("invalidates, releases and abandons in order before rethrowing", async () => {
    const failure = new Error("tail failed");
    const fixture = tail({
      run: vi.fn(async () => {
        fixture.events.push("run");
        throw failure;
      })
    });

    await expect(publicationTailCompletion(fixture.adapter).afterJobCompleted?.()).rejects.toBe(
      failure
    );

    expect(fixture.events).toEqual([
      "start",
      "run",
      "report:follow-up",
      "invalidate",
      "release",
      "abandon",
      "stop"
    ]);
  });

  it("does not abandon the barrier when the exact lease was not released", async () => {
    const failure = new Error("tail failed");
    const fixture = tail({
      run: vi.fn(async () => {
        fixture.events.push("run");
        throw failure;
      }),
      releaseLease: vi.fn(async () => {
        fixture.events.push("release");
        return false;
      })
    });

    await expect(publicationTailCompletion(fixture.adapter).afterJobCompleted?.()).rejects.toBe(
      failure
    );

    expect(fixture.adapter.abandonExportBarrier).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([
      "start",
      "run",
      "report:follow-up",
      "invalidate",
      "release",
      "stop"
    ]);
  });

  it("keeps the original failure when invalidation and abandonment cleanup fail", async () => {
    const failure = new Error("tail failed");
    const fixture = tail({
      run: vi.fn(async () => {
        throw failure;
      }),
      invalidateExports: vi.fn(async () => {
        throw new Error("invalidation failed");
      }),
      abandonExportBarrier: vi.fn(async () => {
        throw new Error("abandon failed");
      })
    });

    await expect(publicationTailCompletion(fixture.adapter).afterJobCompleted?.()).rejects.toBe(
      failure
    );

    expect(fixture.adapter.abandonExportBarrier).toHaveBeenCalledOnce();
    expect(fixture.events.at(-1)).toBe("stop");
  });

  it("treats a failed release as unproven ownership and still stops the heartbeat", async () => {
    const failure = new Error("tail failed");
    const releaseFailure = new Error("release failed");
    const fixture = tail({
      run: vi.fn(async () => {
        throw failure;
      }),
      releaseLease: vi.fn(async () => {
        throw releaseFailure;
      })
    });

    await expect(publicationTailCompletion(fixture.adapter).afterJobCompleted?.()).rejects.toBe(
      failure
    );

    expect(fixture.adapter.reportFailure).toHaveBeenCalledWith("release", releaseFailure);
    expect(fixture.adapter.abandonExportBarrier).not.toHaveBeenCalled();
    expect(fixture.events.at(-1)).toBe("stop");
  });
});

describe("completeOrWaitPublicationTailLease", () => {
  it("returns without waiting when this delivery's compare-and-set matches", async () => {
    const wait = vi.fn(async (): Promise<"completed"> => "completed");

    await expect(
      completeOrWaitPublicationTailLease({
        complete: async () => true,
        wait,
        unowned: new Error("unowned")
      })
    ).resolves.toBeUndefined();

    expect(wait).not.toHaveBeenCalled();
  });

  it("treats a completed wait after a compare-and-set miss as ownership, not an error", async () => {
    await expect(
      completeOrWaitPublicationTailLease({
        complete: async () => false,
        wait: async () => "completed",
        unowned: new Error("unowned")
      })
    ).resolves.toBeUndefined();
  });

  it("throws the unowned error only when the wait is abandoned", async () => {
    const unowned = new Error("unowned");

    await expect(
      completeOrWaitPublicationTailLease({
        complete: async () => false,
        wait: async () => "abandoned",
        unowned
      })
    ).rejects.toBe(unowned);
  });

  it("lets a thrown complete travel instead of waiting or reporting success", async () => {
    const failure = new Error("lease write unavailable");
    const wait = vi.fn(async (): Promise<"abandoned"> => "abandoned");

    await expect(
      completeOrWaitPublicationTailLease({
        complete: async () => {
          throw failure;
        },
        wait,
        unowned: new Error("unowned")
      })
    ).rejects.toBe(failure);

    expect(wait).not.toHaveBeenCalled();
  });
});
