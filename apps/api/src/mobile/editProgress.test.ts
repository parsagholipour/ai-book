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

function steps(activeKey: string, template = ["prepare", "snapshot", "apply", "export"]) {
  const activeIndex = template.indexOf(activeKey);
  return template.map((key, index) => ({
    key,
    label: key,
    status: index < activeIndex ? "done" : index === activeIndex ? "active" : "pending"
  }));
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
