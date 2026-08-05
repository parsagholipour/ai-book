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

function generatingStatus(overrides: Overrides = {}) {
  return statusRecord({
    ...overrides,
    project: {
      id: "project-1",
      title: "Progress Book",
      status: "GENERATING",
      targetPages: 10,
      ...overrides.project
    },
    progress: {
      pages: { complete: 3, target: 10 },
      pipeline: [
        { key: "plan", label: "Plan", status: "done" },
        { key: "pages", label: "Pages", status: "active", detail: "3/10 pages" },
        { key: "images", label: "Images", status: "pending", detail: "0 images" },
        { key: "export", label: "Export", status: "pending" }
      ],
      ...overrides.progress
    }
  });
}

function job(overrides: Overrides = {}) {
  return { id: "job-1", type: "GENERATE_BOOK", status: "ACTIVE", error: null, progress: 0, steps: [], payload: {}, ...overrides };
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

describe("mobile generation progress", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("names the page being written without leaking worker internals", async () => {
    const status = await readStatus(
      generatingStatus({
        project: {
          currentPlan: { planningPackage: { chapters: [{ index: 1 }, { index: 2 }, { index: 3 }] } },
          jobs: [
            job({ id: "job-page", type: "GENERATE_PAGE", steps: [{ key: "draft", label: "Draft page", status: "active" }], pageIndex: 4 }),
            job({ id: "job-book", status: "COMPLETED", progress: 100 })
          ]
        }
      })
    );

    expect(status.generationProgress.steps.map((step: any) => step.key)).toEqual([
      "prepare",
      "write",
      "illustrate",
      "finish"
    ]);
    expect(status.generationProgress.steps[0]).toMatchObject({
      label: "Preparing your chapters",
      status: "done",
      detail: "3 chapters"
    });
    expect(status.generationProgress.steps[1]).toMatchObject({
      label: "Writing your pages",
      status: "active",
      detail: "3 of 10 pages"
    });
    expect(status.generationProgress.steps[2]).toMatchObject({
      key: "illustrate",
      label: "Creating your book images"
    });
    expect(status).toMatchObject({ coverEnabled: true, illustrationsEnabled: true, imagesEnabled: true });
    expect(status.generationProgress.detail).toBe("Writing page 4");
    expect(status.currentAction).toBe("Writing page 4");
    expect(JSON.stringify(status)).not.toMatch(/tokens|provider|model|cost|queue|jobs/i);
  });

  it("walks the friendly phrase through a page's own review steps", async () => {
    const phrases: Record<string, string> = {
      prepare: "Getting ready to write page 4",
      draft: "Writing page 4",
      qa: "Reading back page 4",
      revise: "Polishing page 4",
      save: "Saving page 4"
    };
    for (const [stepKey, phrase] of Object.entries(phrases)) {
      const status = await readStatus(
        generatingStatus({
          project: {
            jobs: [job({ id: "job-page", type: "GENERATE_PAGE", steps: [{ key: stepKey, label: stepKey, status: "active" }], pageIndex: 4 })]
          }
        })
      );
      expect(status.generationProgress.detail).toBe(phrase);
    }
  });

  it("omits the illustration step for a text-only book and widens the writing band", async () => {
    const status = await readStatus(
      generatingStatus({
        project: {
          mediaSettings: { fullIllustrations: false, includeCover: false },
          jobs: [job({ id: "job-book", status: "COMPLETED", progress: 100 })]
        },
        progress: {
          pages: { complete: 10, target: 10 },
          pipeline: [
            { key: "plan", label: "Plan", status: "done" },
            { key: "pages", label: "Pages", status: "done", detail: "10/10 pages" },
            { key: "images", label: "Images", status: "pending", detail: "0 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      })
    );

    expect(status.generationProgress.steps.map((step: any) => step.key)).toEqual(["prepare", "write", "finish"]);
    expect(status.generationProgress.percent).toBe(86);
    expect(status).toMatchObject({ coverEnabled: false, illustrationsEnabled: false, imagesEnabled: false });
  });

  it("keeps the percent moving forward as pages land", async () => {
    const percents: number[] = [];
    for (const complete of [0, 1, 4, 9]) {
      const status = await readStatus(
        generatingStatus({
          project: { jobs: [job({ id: "job-book", status: "COMPLETED", progress: 100 })] },
          progress: { pages: { complete, target: 10 } }
        })
      );
      percents.push(status.generationProgress.percent);
    }

    expect(percents).toEqual([...percents].sort((left, right) => left - right));
    expect(new Set(percents).size).toBe(percents.length);
    expect(Math.max(...percents)).toBeLessThan(100);
  });

  it("nudges the bar from a page's live output between completions", async () => {
    const percents: number[] = [];
    for (const outputTokens of [0, 300, 5_000]) {
      const status = await readStatus(
        generatingStatus({
          project: {
            jobs: [
              job({
                id: "job-page",
                type: "GENERATE_PAGE",
                steps: [{ key: "draft", label: "Draft page", status: "active" }],
                pageIndex: 4,
                tokens: { outputTokens }
              })
            ]
          }
        })
      );
      percents.push(status.generationProgress.percent);
    }

    expect(percents[1]).toBeGreaterThan(percents[0]!);
    expect(percents[2]).toBeGreaterThan(percents[1]!);
    // Never past the page that has not been saved yet: 4/10 pages would be 49.
    expect(percents[2]).toBeLessThanOrEqual(49);
  });

  it("reports the export phase from the compile job's own progress", async () => {
    const status = await readStatus(
      generatingStatus({
        project: {
          jobs: [
            job({
              id: "job-compile",
              type: "COMPILE_EXPORT",
              progress: 88,
              steps: [{ key: "pdf", label: "Generate PDF", status: "active" }]
            })
          ]
        },
        progress: {
          pages: { complete: 10, target: 10 },
          images: 4,
          hasCompileJob: true,
          pipeline: [
            { key: "plan", label: "Plan", status: "done" },
            { key: "pages", label: "Pages", status: "done", detail: "10/10 pages" },
            { key: "images", label: "Images", status: "done", detail: "4 images" },
            { key: "export", label: "Export", status: "active" }
          ]
        }
      })
    );

    expect(status.generationProgress.detail).toBe("Making your PDF");
    expect(status.generationProgress.steps[2]).toMatchObject({
      key: "illustrate",
      label: "Creating your book images",
      status: "done",
      detail: "4 book images"
    });
    expect(status.generationProgress.steps[3]).toMatchObject({ label: "Building your book", status: "active" });
    expect(status.generationProgress.percent).toBeGreaterThanOrEqual(92);
    expect(status.generationProgress.percent).toBeLessThan(100);
  });

  it("counts illustrations against the ones still owed", async () => {
    const status = await readStatus(
      generatingStatus({
        project: {
          mediaSettings: { fullIllustrations: true, includeCover: false },
          jobs: [
            job({
              id: "job-image",
              type: "GENERATE_IMAGE",
              steps: [{ key: "render", label: "Render image", status: "active" }]
            })
          ]
        },
        progress: {
          pages: { complete: 10, target: 10 },
          images: 2,
          openImageJobs: 3,
          pipeline: [
            { key: "plan", label: "Plan", status: "done" },
            { key: "pages", label: "Pages", status: "done", detail: "10/10 pages" },
            { key: "images", label: "Images", status: "active", detail: "3 in queue" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      })
    );

    expect(status.generationProgress.detail).toBe("Drawing your illustration");
    expect(status.generationProgress.steps[2]).toMatchObject({
      key: "illustrate",
      label: "Creating your illustrations",
      status: "active",
      detail: "2 of 5 illustrations"
    });
    expect(status).toMatchObject({ coverEnabled: false, illustrationsEnabled: true, imagesEnabled: true });
  });

  it("keeps the public illustration step key but gives a cover-only book cover-specific wording", async () => {
    const status = await readStatus(
      generatingStatus({
        project: {
          mediaSettings: { fullIllustrations: false, includeCover: true },
          jobs: [
            job({
              id: "job-cover",
              type: "GENERATE_IMAGE",
              payload: { assetType: "COVER" },
              steps: [{ key: "render", label: "Render cover", status: "active" }]
            })
          ]
        },
        progress: {
          pages: { complete: 10, target: 10 },
          images: 0,
          openImageJobs: 1,
          pipeline: [
            { key: "plan", label: "Plan", status: "done" },
            { key: "pages", label: "Pages", status: "done", detail: "10/10 pages" },
            { key: "images", label: "Images", status: "active", detail: "1 in queue" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      })
    );

    expect(status.generationProgress.detail).toBe("Painting your cover");
    expect(status.generationProgress.steps[2]).toMatchObject({
      key: "illustrate",
      label: "Creating your cover",
      status: "active",
      detail: "Cover in progress"
    });
    expect(status).toMatchObject({ coverEnabled: true, illustrationsEnabled: false, imagesEnabled: true });

    const settled = await readStatus(
      generatingStatus({
        project: {
          status: "COMPLETE",
          mediaSettings: { fullIllustrations: false, includeCover: true },
          jobs: []
        },
        progress: { pages: { complete: 10, target: 10 }, images: 1 }
      })
    );
    expect(settled.generationProgress.steps[2]).toMatchObject({
      key: "illustrate",
      label: "Creating your cover",
      status: "done",
      detail: "Cover ready"
    });
    expect(JSON.stringify(settled.generationProgress)).not.toMatch(/illustration/i);
  });

  it("shows a safe preparing state in the window right after approval", async () => {
    const status = await readStatus(
      generatingStatus({
        project: { jobs: [job({ id: "job-book", status: "QUEUED", progress: 0, steps: [] })] },
        progress: { pages: { complete: 0, target: 10 } }
      })
    );

    expect(status.generationProgress.steps.map((step: any) => step.status)).toEqual([
      "active",
      "pending",
      "pending",
      "pending"
    ]);
    expect(status.generationProgress.percent).toBe(20);
    expect(status.generationProgress.detail).toBe("Preparing to write your book");
  });

  it("settles every step once the book is finished", async () => {
    const status = await readStatus(
      generatingStatus({
        project: { status: "COMPLETE", jobs: [] },
        progress: { pages: { complete: 10, target: 10 }, images: 4 }
      })
    );

    expect(status.generationProgress.steps.every((step: any) => step.status === "done")).toBe(true);
    expect(status.generationProgress.percent).toBe(100);
    expect(status.progressPercent).toBe(status.generationProgress.percent);
  });

  it("marks the step that failed and leaves the rest waiting", async () => {
    const status = await readStatus(
      generatingStatus({
        project: {
          status: "FAILED",
          jobs: [job({ id: "job-page", type: "GENERATE_PAGE", status: "FAILED", error: "Page draft timed out." })]
        }
      })
    );

    expect(status.generationProgress.steps[1]).toMatchObject({ key: "write", status: "failed" });
    expect(status.generationProgress.steps[3]).toMatchObject({ key: "finish", status: "pending" });
  });

  it("stays out of the way while planning and while editing", async () => {
    const planning = await readStatus(generatingStatus({ project: { status: "PLANNING" } }));
    const editing = await readStatus(generatingStatus({ project: { status: "EDITING" } }));

    expect(planning.generationProgress).toBeNull();
    expect(editing.generationProgress).toBeNull();
    expect(editing.progressPercent).toBe(92);
  });

  it("never disagrees with the headline percent", async () => {
    for (const complete of [0, 5, 10]) {
      const status = await readStatus(
        generatingStatus({
          project: { jobs: [job({ id: "job-book", status: "COMPLETED", progress: 100 })] },
          progress: { pages: { complete, target: 10 } }
        })
      );
      expect(status.progressPercent).toBe(status.generationProgress.percent);
    }
  });
});
