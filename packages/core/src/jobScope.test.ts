import { describe, expect, it } from "vitest";
import { jobNames, type GenerationJobType } from "./jobDispatch.js";
import {
  DERIVATIVE_GENERATION_JOBS,
  DETACHED_FROM_PROJECT_LIFECYCLE,
  MARKDOWN_RECOMPILE_WITHOUT_VERDICT,
  PRESENTATION_ONLY_RECOMPILE,
  JOB_PAGE_REWRITE_SCOPE,
  PAGE_REWRITING_JOB_TYPES,
  PRE_EDIT_PROJECT_STATUS,
  SKIP_FINAL_REVIEW,
  generationJobControlsProjectStatus,
  isDerivativeGenerationJobType,
  isDerivativeWorkerJobName,
  jobOwnsQualityVerdict,
  openJobRewritesPages,
  payloadOwnsProjectOutcome,
  preEditProjectStatus,
  workerJobControlsProjectStatus,
  workerJobOwnsFailureLifecycle
} from "./jobScope.js";

/**
 * The payload shapes a `GenerationJob` row can actually arrive with, for the
 * claims below that have to hold for all of them. A payload is a JSON column,
 * so `null` and a non-object are as real as a record.
 */
const PAYLOAD_SHAPES: readonly unknown[] = [
  {},
  { planId: "plan-1" },
  { [SKIP_FINAL_REVIEW]: true },
  { [SKIP_FINAL_REVIEW]: "true" },
  { [DETACHED_FROM_PROJECT_LIFECYCLE]: true, [SKIP_FINAL_REVIEW]: true },
  null,
  [],
  "not-an-object"
];

describe("generation job scope", () => {
  it("keeps every declared derivative type and worker name outside the book lifecycle", () => {
    for (const [type, name] of Object.entries(DERIVATIVE_GENERATION_JOBS)) {
      expect(isDerivativeGenerationJobType(type)).toBe(true);
      expect(isDerivativeWorkerJobName(name)).toBe(true);
      expect(generationJobControlsProjectStatus(type)).toBe(false);
      expect(workerJobControlsProjectStatus(name)).toBe(false);
    }
  });

  it("keeps book-changing operations in the project lifecycle", () => {
    for (const [type, name] of [
      ["GENERATE_BOOK", "generate-book"],
      ["GENERATE_PAGE", "generate-page"],
      ["COMPILE_EXPORT", "compile-export"],
      ["APPLY_BOOK_EDIT", "apply-book-edit"],
      ["CONTINUE_BOOK", "continue-book"]
    ] as const) {
      expect(generationJobControlsProjectStatus(type)).toBe(true);
      expect(workerJobControlsProjectStatus(name)).toBe(true);
    }
  });

  it("defaults unknown future jobs to the book lifecycle", () => {
    expect(generationJobControlsProjectStatus("FUTURE_JOB")).toBe(true);
    expect(workerJobControlsProjectStatus("future-job")).toBe(true);
  });
});

describe("jobOwnsQualityVerdict", () => {
  it("gives the verdict to the compile that reviewed the manuscript", () => {
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", { planId: "plan-1" })).toBe(true);
  });

  it("keeps an edit's own recompile owning it, even though it skips final review", () => {
    // The prose moved, so its deterministic-only report has to replace findings
    // about text that no longer exists — otherwise the quality card names an
    // issue on a page the reader just fixed, forever.
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", { planId: "plan-1", skipFinalReview: true })).toBe(true);
  });

  it("refuses a detached export repair", () => {
    expect(
      jobOwnsQualityVerdict("COMPILE_EXPORT", {
        planId: "plan-1",
        skipFinalReview: true,
        [DETACHED_FROM_PROJECT_LIFECYCLE]: true
      })
    ).toBe(false);
  });

  it("refuses a presentation-only recompile", () => {
    expect(
      jobOwnsQualityVerdict("COMPILE_EXPORT", {
        planId: "plan-1",
        skipFinalReview: true,
        [PRESENTATION_ONLY_RECOMPILE]: true
      })
    ).toBe(false);
  });

  it("refuses a markdown recompile that disowned the verdict", () => {
    // The chat add_image apply appended one image line: Page.markdown moved,
    // but no prose changed, so the earned model-QA findings still describe
    // every page and this deterministic-only report must not replace them.
    expect(
      jobOwnsQualityVerdict("COMPILE_EXPORT", {
        planId: "plan-1",
        skipFinalReview: true,
        [MARKDOWN_RECOMPILE_WITHOUT_VERDICT]: true
      })
    ).toBe(false);
  });

  it("keeps the verdictless markdown recompile owning the project outcome", () => {
    // Unlike the detached and presentation flags, this one only disowns the
    // verdict: the add_image recompile still owns EDITING -> settled and the
    // failure lifecycle of the edit it finishes.
    const payload = { planId: "plan-1", skipFinalReview: true, [MARKDOWN_RECOMPILE_WITHOUT_VERDICT]: true };
    expect(payloadOwnsProjectOutcome(payload)).toBe(true);
    expect(workerJobOwnsFailureLifecycle("compile-export", payload)).toBe(true);
  });

  it("refuses every job that is not a compile", () => {
    for (const type of ["GENERATE_BOOK", "GENERATE_PAGE", "APPLY_BOOK_EDIT", "GENERATE_AUDIOBOOK"]) {
      expect(jobOwnsQualityVerdict(type, { planId: "plan-1" })).toBe(false);
    }
  });

  it("treats a missing or malformed payload as an owning compile", () => {
    // The flags are opt-out, and both are written by the one caller that means
    // them. A row whose payload never carried either is an ordinary compile.
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", null)).toBe(true);
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", [])).toBe(true);
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", "not-an-object")).toBe(true);
  });
});

describe("preEditProjectStatus", () => {
  it("reads back the status the book was in before the edit was queued", () => {
    expect(preEditProjectStatus({ [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED" })).toBe("REVIEW_REQUIRED");
    expect(preEditProjectStatus({ [PRE_EDIT_PROJECT_STATUS]: "COMPLETE" })).toBe("COMPLETE");
  });

  it("settles a job that never carried the key as COMPLETE", () => {
    // What a job enqueued before the key existed means, and what almost every
    // book is. Never EDITING: the point of the key is that the project already
    // says that by the time anything reads it.
    expect(preEditProjectStatus({ operationId: "op-1" })).toBe("COMPLETE");
    expect(preEditProjectStatus({ [PRE_EDIT_PROJECT_STATUS]: "EDITING" })).toBe("COMPLETE");
    expect(preEditProjectStatus(null)).toBe("COMPLETE");
  });
});

describe("openJobRewritesPages", () => {
  it("names every dispatchable job type and nothing else", () => {
    // The `Record` is exhaustive by type, which is the point of it; this is the
    // other side of that claim — no entry survives a job type being renamed or
    // dropped from `jobNames`.
    expect(Object.keys(JOB_PAGE_REWRITE_SCOPE).sort()).toEqual(Object.keys(jobNames).sort());
    expect(PAGE_REWRITING_JOB_TYPES).not.toHaveLength(0);
  });

  it("answers for the open row: drafting jobs yes, derivative work no", () => {
    // The window a status cannot see: `restructurePages` and `replanBook` draft
    // pages while the project says EDITING, before either has queued a compile.
    expect(openJobRewritesPages("APPLY_BOOK_EDIT", { operationId: "op-1" })).toBe(true);
    expect(openJobRewritesPages("REPLAN_BOOK", { operationId: "op-1" })).toBe(true);
    expect(openJobRewritesPages("CONTINUE_BOOK", {})).toBe(true);
    // And the work that is open on plenty of delivered books without touching one.
    expect(openJobRewritesPages("GENERATE_AUDIOBOOK", {})).toBe(false);
    expect(openJobRewritesPages("GENERATE_CHARACTER_PORTRAIT", {})).toBe(false);
    expect(openJobRewritesPages("GENERATE_IMAGE", { pageId: "page-1" })).toBe(false);
  });

  it("reads the compile's payload, because that job is two jobs", () => {
    expect(openJobRewritesPages("COMPILE_EXPORT", { planId: "plan-1" })).toBe(true);
    expect(openJobRewritesPages("COMPILE_EXPORT", { planId: "plan-1", [SKIP_FINAL_REVIEW]: true })).toBe(false);
    // A payload is a database column: it can be anything, and the flag is only
    // ever set as a literal `true`.
    expect(openJobRewritesPages("COMPILE_EXPORT", null)).toBe(true);
    expect(openJobRewritesPages("COMPILE_EXPORT", { [SKIP_FINAL_REVIEW]: "true" })).toBe(true);
  });

  it("answers false for a type nothing dispatches", () => {
    // A read-side question about work that is going to happen. RESEARCH is in
    // the Prisma enum and in no dispatch table, so nothing is going to run it.
    expect(openJobRewritesPages("RESEARCH", {})).toBe(false);
    expect(openJobRewritesPages("", {})).toBe(false);
    // The lookup is a Map for this: an object's inherited keys would have
    // answered "always" here, and `type` arrives as a database string.
    expect(openJobRewritesPages("constructor", {})).toBe(false);
    expect(openJobRewritesPages("toString", {})).toBe(false);
  });
});

describe("the shared tables are frozen, not merely typed readonly", () => {
  // Every one of these is a module-level singleton read by a poll that runs for
  // the life of the process, and two of them are read straight into a database
  // `where`. `readonly` is a compile-time claim a cast walks past and a
  // JavaScript consumer never sees at all, so the runtime has to enforce it too.
  it("refuses every in-place edit of the job-type list a status poll queries with", () => {
    // `apps/api/src/projectPageCounts.ts` builds `type: { in: … }` from this. A
    // caller that sorted it, spliced a type out or pushed one in would change
    // what *every* later poll asks — and a poll that has stopped asking about
    // `GENERATE_PAGE` reports "nothing is going to rewrite this page" while the
    // page is being written, which is the skew the table exists to prevent.
    const before = [...PAGE_REWRITING_JOB_TYPES];
    const mutable = PAGE_REWRITING_JOB_TYPES as GenerationJobType[];

    expect(Object.isFrozen(PAGE_REWRITING_JOB_TYPES)).toBe(true);
    expect(() => mutable.sort()).toThrow(TypeError);
    expect(() => mutable.splice(0, 1)).toThrow(TypeError);
    expect(() => mutable.push("PLAN_BOOK")).toThrow(TypeError);
    expect(() => mutable.reverse()).toThrow(TypeError);
    expect(() => {
      mutable[0] = "PLAN_BOOK";
    }).toThrow(TypeError);
    expect(mutable).toHaveLength(before.length);
    expect([...PAGE_REWRITING_JOB_TYPES]).toEqual(before);
  });

  it("keeps that list exactly the types the table does not answer `never` for", () => {
    // Derived rather than spelled a second time, and the freeze is what keeps
    // the derivation true for longer than the module's first tick.
    const derived = Object.entries(JOB_PAGE_REWRITE_SCOPE).flatMap(([type, scope]) =>
      scope === "never" ? [] : [type]
    );

    expect([...PAGE_REWRITING_JOB_TYPES]).toEqual(derived);
    for (const type of PAGE_REWRITING_JOB_TYPES) {
      expect(openJobRewritesPages(type, {})).toBe(true);
    }
  });

  it("refuses a write to the scope table itself", () => {
    // The table is the authority both predicates read. Flipping one entry from
    // a consumer would answer for every caller in the process.
    const mutable = JOB_PAGE_REWRITE_SCOPE as Record<string, string>;

    expect(Object.isFrozen(JOB_PAGE_REWRITE_SCOPE)).toBe(true);
    expect(() => {
      mutable.GENERATE_PAGE = "never";
    }).toThrow(TypeError);
    expect(() => {
      mutable.FUTURE_JOB = "always";
    }).toThrow(TypeError);
    expect(JOB_PAGE_REWRITE_SCOPE.GENERATE_PAGE).toBe("always");
    expect(openJobRewritesPages("GENERATE_PAGE", {})).toBe(true);
  });

  it("refuses a write to the derivative-job map", () => {
    // Narrower blast radius — the two predicates read `Set`s taken at module
    // load — but it is the same kind of shared table, and a consumer reading
    // `Object.entries` off it deserves the same guarantee.
    const mutable = DERIVATIVE_GENERATION_JOBS as unknown as Record<string, string>;

    expect(Object.isFrozen(DERIVATIVE_GENERATION_JOBS)).toBe(true);
    expect(() => {
      mutable.GENERATE_AUDIOBOOK = "something-else";
    }).toThrow(TypeError);
    expect(() => {
      delete mutable.GENERATE_AUDIOBOOK;
    }).toThrow(TypeError);
    expect(DERIVATIVE_GENERATION_JOBS.GENERATE_AUDIOBOOK).toBe("generate-audiobook");
  });
});

describe("the scope table under `openJobRewritesPages`", () => {
  it("lets no payload talk an `always` type out of a rewrite", () => {
    // The table's own soundness, and the reason a caller may read a type before
    // it has paid for a payload: every shape a `GenerationJob.payload` can hold
    // — including the `skipFinalReview` flag itself — leaves an `always` type
    // answering true. Only the compile's scope reads the payload at all.
    for (const [type, scope] of Object.entries(JOB_PAGE_REWRITE_SCOPE)) {
      if (scope !== "always") {
        continue;
      }
      for (const payload of PAYLOAD_SHAPES) {
        expect(openJobRewritesPages(type, payload)).toBe(true);
      }
      expect(openJobRewritesPages(type, { [SKIP_FINAL_REVIEW]: true })).toBe(true);
    }
  });

  it("leaves the compile to its payload, which is the one scope that reads one", () => {
    expect(openJobRewritesPages("COMPILE_EXPORT", { planId: "plan-1" })).toBe(true);
    expect(openJobRewritesPages("COMPILE_EXPORT", { [SKIP_FINAL_REVIEW]: true })).toBe(false);
  });

  it("answers false for a type nothing dispatches, and for an inherited property", () => {
    for (const type of ["RESEARCH", "", "constructor", "toString"]) {
      expect(openJobRewritesPages(type, {})).toBe(false);
    }
  });
});
