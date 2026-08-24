import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StopRequestedError } from "../runtime/jobTypes.js";
import { bestEffortPass } from "./bestEffortPass.js";

/**
 * The wrapper's own contract, asserted away from any of its callers. Its three
 * call sites in `bookState.ts` each check what *their* pass degrades to; what
 * only this file can check is the part none of them may restate — that a stop
 * escapes, and that nothing reachable from a failing pass has a way out.
 */
describe("bestEffortPass", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("answers the pass and says nothing when it succeeds", async () => {
    const answer = await bestEffortPass({
      attempt: async () => "critiqued",
      fallback: "as briefed",
      warning: "Pass skipped"
    });

    expect(answer).toBe("critiqued");
    expect(warn).not.toHaveBeenCalled();
  });

  // Two of the three passes are pure merges; only the model calls are async.
  it("takes a synchronous pass", async () => {
    expect(await bestEffortPass({ attempt: () => 7, fallback: 0, warning: "Pass skipped" })).toBe(7);
  });

  it("degrades to the fallback and warns in the call site's own words", async () => {
    const failure = new Error("provider down");

    const answer = await bestEffortPass({
      attempt: async () => {
        throw failure;
      },
      fallback: "as briefed",
      warning: "Page-beat dedup rewrite skipped; keeping deterministic distinctness notes"
    });

    expect(answer).toBe("as briefed");
    expect(warn).toHaveBeenCalledWith(
      "Page-beat dedup rewrite skipped; keeping deterministic distinctness notes",
      failure
    );
  });

  // The whole risk of the shape: a degrade looks like success, so a stop folded
  // into a fallback is a run the reader ended that keeps drafting and billing.
  // No caller passes a predicate, which is why no caller can omit one.
  it("lets a user stop escape instead of degrading", async () => {
    const stop = new StopRequestedError();

    await expect(
      bestEffortPass({
        attempt: async () => {
          throw stop;
        },
        fallback: "as briefed",
        warning: "Pass skipped"
      })
    ).rejects.toBe(stop);
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * A stand-in built only because the pass's own preferred input was missing —
   * `beatDedupPatch(findings)` behind a failed rewrite call — sits inside
   * `attempt` rather than in `fallback`, which is what buys it both properties
   * below: it is skipped when it is not needed, and covered when it is. The
   * fallback is a value, so there is never a second failure with nothing behind
   * it — which is exactly how a thrown fallback merge once failed a finished
   * manuscript.
   */
  describe("a stand-in the pass reaches for", () => {
    it("costs nothing on the path that never needed it", async () => {
      const standIn = vi.fn(() => "deterministic");
      const rewritten: string | undefined = "from the model";

      const answer = await bestEffortPass({
        attempt: () => rewritten ?? standIn(),
        fallback: "as briefed",
        warning: "Pass skipped"
      });

      expect(answer).toBe("from the model");
      expect(standIn).not.toHaveBeenCalled();
    });

    it("degrades rather than escaping when it throws", async () => {
      const answer = await bestEffortPass({
        attempt: () => {
          const standIn = (): string => {
            throw new Error("a findings shape the deterministic patch cannot take");
          };
          return standIn();
        },
        fallback: "as briefed",
        warning: "Pass skipped"
      });

      expect(answer).toBe("as briefed");
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("still lets a user stop escape from inside it", async () => {
      const stop = new StopRequestedError();

      await expect(
        bestEffortPass({
          attempt: () => {
            const standIn = (): string => {
              throw stop;
            };
            return standIn();
          },
          fallback: "as briefed",
          warning: "Pass skipped"
        })
      ).rejects.toBe(stop);
    });
  });

  /**
   * The one thing the fourth caller needed that the first three did not.
   * `writeStandDownRecordBestEffort` logs a line an operator greps
   * `generation.consistency_warning` for across every book on the box, so its
   * context is a structured object rather than a longer sentence — and it stayed
   * a hand-rolled copy of this file until the option existed to carry it.
   */
  describe("structured context", () => {
    it("folds the error into the details a call site already logs", async () => {
      const failure = new Error("P2025");

      await bestEffortPass<void>({
        attempt: async () => {
          throw failure;
        },
        fallback: undefined,
        warning: "Superseded export compile could not record its stand-down",
        details: {
          event: "generation.consistency_warning",
          warning: "export_stand_down_record_failed",
          projectId: "project-1",
          generationJobId: "gj-1"
        }
      });

      expect(warn).toHaveBeenCalledWith("Superseded export compile could not record its stand-down", {
        event: "generation.consistency_warning",
        warning: "export_stand_down_record_failed",
        projectId: "project-1",
        generationJobId: "gj-1",
        error: failure
      });
    });

    // The three `bookState.ts` passes pass nothing, and their assertions read
    // the two-argument shape, so the option may not change it for them.
    it("leaves a caller with nothing to add logging the bare error", async () => {
      const failure = new Error("provider down");

      await bestEffortPass({
        attempt: async () => {
          throw failure;
        },
        fallback: "as briefed",
        warning: "Pass skipped"
      });

      expect(warn).toHaveBeenCalledWith("Pass skipped", failure);
    });

    it("says nothing at all when the pass succeeds", async () => {
      await bestEffortPass({
        attempt: async () => "critiqued",
        fallback: "as briefed",
        warning: "Pass skipped",
        details: { projectId: "project-1" }
      });

      expect(warn).not.toHaveBeenCalled();
    });
  });

  // The shape a best-effort *write* takes: nothing to keep, so `undefined` is
  // what it keeps. `writeStandDownRecordBestEffort` in handlers/compileExportStandDown.ts
  // is that shape, and reaches it through this function rather than restating it.
  it("carries a pass with no answer of its own", async () => {
    const written = await bestEffortPass<void>({
      attempt: async () => {
        throw new Error("P2025");
      },
      fallback: undefined,
      warning: "Superseded export compile could not record its stand-down"
    });

    expect(written).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
