import { describe, expect, it, vi } from "vitest";
import { degradeRetrievalArm } from "./retrievalArms.ts";

/**
 * `rethrowIf: null` throughout, except where the escape hatch itself is under
 * test. It is required rather than optional precisely so a call site has to say
 * which it means, and what this suite means is the claim `null` makes: these
 * errors are fabricated here, inside no job anyone can stop, so there is no
 * cancellation to carry out. A production caller that wrote `null` here would
 * be wrong — every one of them passes the worker's `isStopRequestedError`.
 */
describe("degradeRetrievalArm", () => {
  it("returns the fallback and reports the failure once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = new Error("an arm fault reported by the helper's own suite");

    const first = degradeRetrievalArm({
      arm: "Test arm",
      projectId: "project-9",
      error,
      fallback: ["kept"],
      rethrowIf: null
    });
    const second = degradeRetrievalArm({
      arm: "Test arm",
      projectId: "project-9",
      error,
      fallback: ["kept"],
      rethrowIf: null
    });

    expect(first).toEqual(["kept"]);
    expect(second).toEqual(["kept"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Test arm failed for project project-9", error);
    warn.mockRestore();
  });

  /**
   * The escape hatch the worker passes `isStopRequestedError` into: a stopped
   * generation has to reach the job runner as a stop, not as a page written
   * from a quietly thinner context.
   */
  it("rethrows what rethrowIf claims instead of swallowing it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stop = new Error("Generation stopped by user");

    expect(() =>
      degradeRetrievalArm({
        arm: "Test arm",
        projectId: "project-9",
        error: stop,
        fallback: [],
        rethrowIf: (error: unknown) => error === stop
      })
    ).toThrow(stop);
    expect(
      degradeRetrievalArm({
        arm: "Test arm",
        projectId: "project-9",
        error: new Error("an ordinary fault the predicate does not claim"),
        fallback: ["kept"],
        rethrowIf: (error: unknown) => error === stop
      })
    ).toEqual(["kept"]);
    warn.mockRestore();
  });

  /**
   * A permanent environment fact and a fault that keeps recurring reach this
   * helper as the same stable message, so the ladder has to serve both. Nine
   * occurrences of one that will never stop still cost a single line — and a
   * fault that keeps going is no longer invisible behind that line, because the
   * 10th and the 100th report again. Each rung carries its own count and the
   * project it actually hit, which is what tells "the same environment fact,
   * still true" from "the same message, now on a second book".
   *
   * Counted, never timed: the assertions below hold at any speed.
   */
  it("reports a repeating failure again at every power of ten", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const message = "connection reset by peer while scoring trigrams";
    // A fresh Error each time: the key is the message, not the object.
    const hit = (projectId: string) =>
      degradeRetrievalArm({
        arm: "Ladder arm",
        projectId,
        error: new Error(message),
        fallback: ["kept"],
        rethrowIf: null
      });

    for (let occurrence = 1; occurrence <= 9; occurrence += 1) {
      expect(hit("project-a")).toEqual(["kept"]);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "Ladder arm failed for project project-a",
      expect.objectContaining({ message })
    );

    hit("project-b");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      2,
      "Ladder arm failed for project project-b (seen 10 times this process)",
      expect.objectContaining({ message })
    );

    for (let occurrence = 11; occurrence <= 100; occurrence += 1) {
      hit("project-b");
    }
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenNthCalledWith(
      3,
      "Ladder arm failed for project project-b (seen 100 times this process)",
      expect.objectContaining({ message })
    );

    // 999 occurrences, three lines: a chronic fault is reported, not narrated.
    for (let occurrence = 101; occurrence <= 999; occurrence += 1) {
      hit("project-b");
    }
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  /**
   * The 64-key cap is the memory bound and nothing else — a message carrying a
   * unique detail must not grow the census for the life of a worker. The only
   * thing it is allowed to do to reporting is make it louder: a count it drops
   * starts its ladder over, so an eviction can never be what silences a fault.
   */
  it("restarts the ladder rather than silencing a message the memory bound evicted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const chronic = "the chronic fault whose count the memory bound drops";
    const hitChronic = () =>
      degradeRetrievalArm({
        arm: "Bounded arm",
        projectId: "project-c",
        error: new Error(chronic),
        fallback: [],
        rethrowIf: null
      });

    hitChronic();
    hitChronic();
    expect(warn).toHaveBeenCalledTimes(1);

    for (let unique = 0; unique < 64; unique += 1) {
      degradeRetrievalArm({
        arm: "Bounded arm",
        projectId: "project-c",
        error: new Error(`a fault carrying a detail nothing repeats: ${unique}`),
        fallback: [],
        rethrowIf: null
      });
    }
    const afterFlood = warn.mock.calls.length;

    hitChronic();

    expect(warn).toHaveBeenCalledTimes(afterFlood + 1);
    // The first-occurrence line, not a rung: the count restarted with the key.
    expect(warn).toHaveBeenNthCalledWith(
      afterFlood + 1,
      "Bounded arm failed for project project-c",
      expect.objectContaining({ message: chronic })
    );
    warn.mockRestore();
  });
});
