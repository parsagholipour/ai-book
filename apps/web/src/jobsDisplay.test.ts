import { JOB_STEP_TEMPLATES } from "@book-maker/core/jobSteps";
import { describe, expect, it } from "vitest";
import type { GenerationJobRow, JobStep, ProjectStatus } from "./api.js";
import { normalizeProjectStatus, resolveJobDisplaySteps } from "./jobsDisplay.js";

function jobRow(overrides: Partial<GenerationJobRow> & Pick<GenerationJobRow, "type">): GenerationJobRow {
  return { id: "job-1", status: "PENDING", progress: 0, ...overrides };
}

describe("resolveJobDisplaySteps", () => {
  it("prefers the steps the API sent over the fallback labels", () => {
    const steps = resolveJobDisplaySteps(
      jobRow({
        type: "GENERATE_PAGE",
        status: "ACTIVE",
        progress: 40,
        steps: [{ key: "draft", label: "Draft page", status: "active" }]
      })
    );

    expect(steps).toEqual([{ key: "draft", label: "Draft page", status: "active" }]);
  });

  it("drops step-shaped junk the API sent and falls back", () => {
    const steps = resolveJobDisplaySteps(
      jobRow({ type: "REVISE_PLAN", steps: [{ key: "revise" }] as unknown as JobStep[] })
    );

    expect(steps.map((step) => step.label)).toEqual(["Revise plan", "Save revision"]);
  });

  /**
   * The one that fails when core gains a job type the console cannot render.
   * `JOB_STEP_TEMPLATES` is exhaustive over `GenerationJobType` by type, so a new
   * entry in `jobNames` reaches this loop the moment core compiles again.
   */
  it("renders every job type core authors steps for", () => {
    for (const [type, template] of Object.entries(JOB_STEP_TEMPLATES)) {
      const steps = resolveJobDisplaySteps(jobRow({ type }));

      expect(template.length, `${type} has no authored steps`).toBeGreaterThan(0);
      expect(
        steps.map((step) => step.label),
        `${type} renders the wrong labels`
      ).toEqual(template.map((step) => step.label));
    }
  });

  it("keeps GENERATE_CHARACTER_PORTRAIT, the type the hand-copy once missed", () => {
    expect(resolveJobDisplaySteps(jobRow({ type: "GENERATE_CHARACTER_PORTRAIT" })).map((step) => step.label)).toEqual([
      "Prepare portrait",
      "Draw portrait",
      "Save portrait"
    ]);
  });

  it("gives a type this build has no template for no steps rather than throwing", () => {
    // A console a release behind the API. The row still renders its type,
    // progress bar and message; only the step list is left off.
    expect(resolveJobDisplaySteps(jobRow({ type: "TRANSLATE_BOOK", status: "ACTIVE", progress: 50 }))).toEqual([]);
    expect(resolveJobDisplaySteps(jobRow({ type: "", status: "COMPLETED", progress: 100 }))).toEqual([]);
  });

  it("marks every step done for a completed job", () => {
    const steps = resolveJobDisplaySteps(jobRow({ type: "GENERATE_IMAGE", status: "COMPLETED", progress: 100 }));

    expect(steps.map((step) => step.status)).toEqual(["done", "done", "done"]);
  });

  it("fails the first step only for a failed job", () => {
    const steps = resolveJobDisplaySteps(jobRow({ type: "GENERATE_IMAGE", status: "FAILED", progress: 30 }));

    expect(steps.map((step) => step.status)).toEqual(["failed", "pending", "pending"]);
  });

  it("walks the active step with progress, and never past the last one", () => {
    const at = (progress: number) =>
      resolveJobDisplaySteps(jobRow({ type: "GENERATE_IMAGE", status: "ACTIVE", progress })).map((step) => step.status);

    expect(at(0)).toEqual(["active", "pending", "pending"]);
    expect(at(50)).toEqual(["done", "active", "pending"]);
    expect(at(100)).toEqual(["done", "done", "active"]);
  });

  it("leaves a queued job's steps pending", () => {
    const steps = resolveJobDisplaySteps(jobRow({ type: "GENERATE_IMAGE", status: "PENDING", progress: 0 }));

    expect(steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
  });
});

describe("normalizeProjectStatus", () => {
  it("fills in fallback steps per job and leaves an unknown type's row standing", () => {
    const status = {
      project: {
        status: "GENERATING",
        jobs: [jobRow({ id: "a", type: "GENERATE_PAGE" }), jobRow({ id: "b", type: "TRANSLATE_BOOK" })]
      },
      progress: { pages: { complete: 1, target: 4 }, images: 0, research: 0, failedJobs: 0 }
    } as unknown as ProjectStatus;

    const normalized = normalizeProjectStatus(status);

    expect(normalized.project.jobs.map((job) => job.id)).toEqual(["a", "b"]);
    expect(normalized.project.jobs[0]?.steps).toHaveLength(JOB_STEP_TEMPLATES.GENERATE_PAGE.length);
    expect(normalized.project.jobs[1]?.steps).toEqual([]);
    expect(normalized.progress.pipeline?.map((step) => step.key)).toEqual(["plan", "pages", "images", "export"]);
  });
});
