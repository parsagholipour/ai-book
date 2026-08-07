import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { buildProjectStatus } from "../projectStatus.js";
import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  statusRecord,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

type Overrides = Record<string, any>;

function editingStatus(overrides: Overrides = {}) {
  return statusRecord({
    ...overrides,
    project: {
      id: "project-1",
      title: "Edited Book",
      status: "EDITING",
      targetPages: 12,
      ...overrides.project
    },
    progress: {
      pages: { complete: 12, target: 12 },
      pipeline: [
        { key: "plan", label: "Plan", status: "done" },
        { key: "pages", label: "Pages", status: "done", detail: "12/12 pages" },
        { key: "images", label: "Images", status: "done", detail: "4 images" },
        { key: "export", label: "Export", status: "done" }
      ],
      ...overrides.progress
    }
  });
}

function editJob(overrides: Overrides = {}) {
  return {
    id: "job-edit",
    type: "APPLY_BOOK_EDIT",
    status: "ACTIVE",
    error: null,
    progress: 0,
    steps: [],
    payload: { affectedPageIndexes: [3, 4, 5] },
    ...overrides
  };
}

function steps(
  activeKey: string,
  template = ["prepare", "snapshot", "apply", "export"],
  counters: Overrides = {}
) {
  const activeIndex = template.indexOf(activeKey);
  return template.map((key, index) => ({
    key,
    label: key,
    status: index < activeIndex ? "done" : index === activeIndex ? "active" : "pending",
    ...(index === activeIndex ? counters : {})
  }));
}

function compileJob(overrides: Overrides = {}) {
  return {
    id: "job-compile",
    type: "COMPILE_EXPORT",
    status: "ACTIVE",
    error: null,
    progress: 0,
    steps: [],
    payload: {},
    ...overrides
  };
}

async function readStatus(record: unknown) {
  mockAccessTokens({ "token-a": "user-a" });
  mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
  vi.mocked(buildProjectStatus).mockResolvedValue(record as never);
  const app = await buildMobileApp();
  const response = await app.inject({
    method: "GET",
    url: "/api/mobile/projects/project-1/status",
    headers: bearer("token-a")
  });
  await app.close();
  return response.json().status;
}

describe("mobile edit progress", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("names the edit step being worked on and counts only the affected pages", async () => {
    const status = await readStatus(
      editingStatus({ project: { jobs: [editJob({ progress: 52, steps: steps("apply") })] } })
    );

    expect(status.editProgress.steps.map((step: any) => step.key)).toEqual(["prepare", "snapshot", "apply", "export"]);
    expect(status.editProgress.steps[0]).toMatchObject({ label: "Reading your book", status: "done" });
    expect(status.editProgress.steps[2]).toMatchObject({
      label: "Making your changes",
      status: "active",
      detail: "3 pages"
    });
    expect(status.editProgress.detail).toBe("Rewriting 3 pages");
    // The book's own page count is settled and says nothing about the edit.
    expect(status.pageProgress).toEqual({ completed: 12, target: 12 });
  });

  it("leads with the live edit phrase instead of the flat stage label", async () => {
    const status = await readStatus(
      editingStatus({ project: { jobs: [editJob({ progress: 85, steps: steps("export") })] } })
    );

    expect(status.currentAction).toBe("Rebuilding your book");
  });

  it("moves the bar with the job rather than pinning it at 92", async () => {
    const percents: number[] = [];
    for (const progress of [0, 20, 35, 52, 75, 85]) {
      const status = await readStatus(
        editingStatus({ project: { jobs: [editJob({ progress, steps: steps("apply") })] } })
      );
      percents.push(status.progressPercent);
      expect(status.progressPercent).toBe(status.editProgress.percent);
    }

    expect(percents).toEqual([...percents].sort((left, right) => left - right));
    expect(percents[0]).toBeGreaterThan(0);
    expect(percents.at(-1)).toBeLessThan(100);
    expect(new Set(percents).size).toBeGreaterThan(1);
  });

  it("falls back to the flat percent while the edit is enqueued but unclaimed", async () => {
    const status = await readStatus(editingStatus({ project: { jobs: [] } }));

    expect(status.editProgress).toBeNull();
    expect(status.progressPercent).toBe(92);
    expect(status.currentAction).toBe("Editing your book.");
  });

  it("drops step keys it has no reader-facing name for", async () => {
    const status = await readStatus(
      editingStatus({
        project: {
          jobs: [
            editJob({
              progress: 40,
              steps: [...steps("apply"), { key: "reindex", label: "Reindex embeddings", status: "pending" }]
            })
          ]
        }
      })
    );

    expect(status.editProgress.steps.map((step: any) => step.key)).not.toContain("reindex");
    expect(JSON.stringify(status)).not.toContain("Reindex embeddings");
  });

  it("describes a continuation with its own steps", async () => {
    const status = await readStatus(
      editingStatus({
        project: {
          jobs: [
            editJob({
              type: "CONTINUE_BOOK",
              progress: 30,
              payload: {},
              steps: steps("draft", ["outline", "draft", "save", "export"])
            })
          ]
        }
      })
    );

    expect(status.editProgress.steps.map((step: any) => step.label)).toEqual([
      "Planning the new chapters",
      "Writing the new pages",
      "Saving the new chapters",
      "Rebuilding your book"
    ]);
    expect(status.editProgress.detail).toBe("Writing the new pages");
  });

  it("names the page being rewritten and what is being done to it", async () => {
    // The long step is the rewrite, and one phrase over all of it reads as a
    // stall. The page number is the worker's own, never inverted out of the bar.
    const phrases: string[] = [];
    for (const phase of ["draft", "review", "save"]) {
      const status = await readStatus(
        editingStatus({
          project: {
            jobs: [
              editJob({
                progress: 52,
                steps: steps("apply", undefined, { done: 1, total: 3, phase, pageIndex: 8 })
              })
            ]
          }
        })
      );
      phrases.push(status.currentAction);
      expect(status.editProgress.steps[2].detail).toBe("1 of 3 pages");
    }

    expect(phrases).toEqual(["Rewriting page 8", "Reading back page 8", "Saving page 8"]);
  });

  it("counts the new pages a continuation has written", async () => {
    const status = await readStatus(
      editingStatus({
        project: {
          jobs: [
            editJob({
              type: "CONTINUE_BOOK",
              progress: 45,
              payload: {},
              steps: steps("draft", ["outline", "draft", "save", "export"], {
                done: 2,
                total: 6,
                pageIndex: 15
              })
            })
          ]
        }
      })
    );

    expect(status.currentAction).toBe("Writing page 15");
    expect(status.editProgress.steps[1].detail).toBe("2 of 6 new pages");
  });

  it("draws the milestones before the worker has claimed the job", async () => {
    // A queued job carries no steps — they are stamped on when it starts — and
    // a card that opens as a bare bar says nothing about what is coming.
    const status = await readStatus(
      editingStatus({ project: { jobs: [editJob({ status: "QUEUED", progress: 0, steps: [] })] } })
    );

    expect(status.editProgress.steps.map((step: any) => step.status)).toEqual([
      "active",
      "pending",
      "pending",
      "pending"
    ]);
    expect(status.currentAction).toBe("Getting your edit ready");
  });

  it("keeps reporting through the rebuild the edit hands off to", async () => {
    // apply-book-edit finishes by queueing the compile, and the project stays
    // EDITING until that lands. Without this the card dropped its step list and
    // froze at a flat 92 for the slowest part of the whole edit.
    const rebuilding = (progress: number, activeCompileStep: string) =>
      editingStatus({
        project: {
          jobs: [
            compileJob({ progress, steps: steps(activeCompileStep, ["qa", "compile", "write", "pdf", "epub"]) }),
            editJob({ status: "COMPLETED", progress: 85, steps: steps("export") })
          ]
        }
      });

    const early = await readStatus(rebuilding(20, "compile"));
    expect(early.editProgress.steps.map((step: any) => step.status)).toEqual(["done", "done", "done", "active"]);
    expect(early.editProgress.steps[3].label).toBe("Rebuilding your book");
    expect(early.currentAction).toBe("Putting the chapters together");

    const late = await readStatus(rebuilding(80, "pdf"));
    expect(late.currentAction).toBe("Making your PDF");
    // Never backwards over the handover: the rebuild's band starts above where
    // the edit job's own bar tops out.
    expect(late.progressPercent).toBeGreaterThan(early.progressPercent);
    expect(early.progressPercent).toBeGreaterThan(92);
    expect(late.progressPercent).toBeLessThan(100);
  });

  it("reports a rebuild the reader started themselves", async () => {
    // A manual edit, an undo, or dropping the sources list queues only the
    // recompile. It sat at a flat 92 with nothing on screen for the whole of it.
    const status = await readStatus(
      editingStatus({
        project: {
          jobs: [
            compileJob({
              progress: 60,
              payload: { skipFinalReview: true },
              steps: steps("pdf", ["qa", "compile", "write", "pdf", "epub"])
            }),
            // An older edit's history: not this rebuild's steps.
            editJob({ status: "COMPLETED", progress: 85, steps: steps("export") })
          ]
        }
      })
    );

    expect(status.editProgress.steps).toEqual([
      { key: "export", label: "Rebuilding your book", status: "active", detail: null }
    ]);
    expect(status.currentAction).toBe("Making your PDF");
    expect(status.progressPercent).toBeGreaterThan(92);
  });

  it("reports a replan's own steps instead of leaving the bar blank", async () => {
    const status = await readStatus(
      editingStatus({
        project: {
          jobs: [
            editJob({
              id: "job-replan",
              type: "REPLAN_BOOK",
              progress: 30,
              steps: steps("revise", ["revise", "save", "generate"]),
              payload: {}
            })
          ]
        }
      })
    );

    expect(status.editProgress.steps.map((step: any) => step.key)).toEqual(["revise", "save", "generate"]);
    expect(status.editProgress.steps[0]).toMatchObject({ label: "Planning your new book", status: "active" });
    expect(status.editProgress.detail).toBe("Planning your new book");
    expect(status.currentAction).toBe("Planning your new book");
  });

  it("keeps a replan below where writing the new book picks the bar up", async () => {
    // The replan hands straight over to `generationProgress`, whose prepare band
    // opens at 20. Ending above that would run the bar to ~92 and then drop it.
    const percents: number[] = [];
    for (const progress of [0, 30, 65, 85]) {
      const status = await readStatus(
        editingStatus({
          project: {
            jobs: [
              editJob({
                id: "job-replan",
                type: "REPLAN_BOOK",
                progress,
                steps: steps("revise", ["revise", "save", "generate"]),
                payload: {}
              })
            ]
          }
        })
      );
      percents.push(status.progressPercent);
      expect(status.progressPercent).toBe(status.editProgress.percent);
    }

    expect(percents).toEqual([...percents].sort((left, right) => left - right));
    expect(percents[0]).toBeGreaterThan(0);
    expect(percents.at(-1)).toBeLessThan(20);
  });

  it("never dresses a later rebuild up as the replan that came before it", async () => {
    // A heading or sources toggle recompiles without writing an edit job of its
    // own; the completed replan still sitting in the job list is not its story.
    const status = await readStatus(
      editingStatus({
        project: {
          jobs: [
            compileJob({ progress: 60, steps: steps("pdf", ["qa", "compile", "write", "pdf", "epub"]) }),
            editJob({
              id: "job-replan",
              type: "REPLAN_BOOK",
              status: "COMPLETED",
              progress: 85,
              steps: steps("generate", ["revise", "save", "generate"]),
              payload: {}
            })
          ]
        }
      })
    );

    expect(status.editProgress.steps).toEqual([
      { key: "export", label: "Rebuilding your book", status: "active", detail: null }
    ]);
  });

  it("reports nothing for a book that is not being edited", async () => {
    const status = await readStatus(
      editingStatus({
        project: { status: "COMPLETE", jobs: [editJob({ status: "COMPLETED", progress: 100, steps: steps("export") })] }
      })
    );

    expect(status.editProgress).toBeNull();
    expect(status.progressPercent).toBe(100);
  });
});
