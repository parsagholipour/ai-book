import { describe, expect, it } from "vitest";
import { jobNames } from "./jobDispatch.js";
import { JOB_STEP_TEMPLATES } from "./jobSteps.js";

describe("JOB_STEP_TEMPLATES", () => {
  /*
   * The type already says this — `Record<GenerationJobType, …>` makes a missing
   * job type a compile error, which is the whole point of moving the table
   * here. The runtime assertion is what catches the other half: a table keyed
   * off a stale copy of `jobNames`, or an entry added under a key that only
   * looks like a job type.
   */
  it("covers exactly the job types jobNames dispatches", () => {
    expect(Object.keys(JOB_STEP_TEMPLATES).sort()).toEqual(Object.keys(jobNames).sort());
  });

  it("gives every job at least one step, with unique non-empty keys and labels", () => {
    for (const [type, steps] of Object.entries(JOB_STEP_TEMPLATES)) {
      expect(steps.length, `${type} has no steps`).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.key, `${type} has a blank step key`).not.toBe("");
        expect(step.label, `${type} has a blank step label`).not.toBe("");
      }
      // Handlers advance by key, and `advanceJobStep` marks the *first* match
      // active and everything before it done — a duplicate key inside one job
      // would make the progress list walk backwards.
      expect(new Set(steps.map((step) => step.key)).size, `${type} repeats a step key`).toBe(steps.length);
    }
  });
});
