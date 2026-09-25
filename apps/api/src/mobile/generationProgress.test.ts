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

  it("keeps finalization visible outside the recent-job window and does not finish at image handoff", async () => {
    const checkpoint = { phase: "illustrations", label: "Creating your illustrations", pageIndex: null,
      repairPagesAttempted: 2, remainingRepairPages: 0, illustrationJobsTotal: 30, lastProgressAt: "2026-09-23T11:15:00.000Z" };
    const images = Array.from({ length: 30 }, (_, index) => job({ id: `image-${index}`, type: "GENERATE_IMAGE", status: "QUEUED" }));
    const stages = [];
    for (const jobs of [images.slice(0, 25), [job({ type: "COMPILE_EXPORT", status: "COMPLETED", progress: 100 }), ...images],
      [job({ type: "COMPILE_EXPORT", status: "QUEUED", progress: 0 }), ...images]]) {
      const status = await readStatus(generatingStatus({ project: { jobs }, progress: {
        pages: { complete: 30, target: 30 }, images: 1, openImageJobs: 30, finalization: checkpoint
      } }));
      stages.push(status.generationProgress.percent);
      expect(status.currentAction).toBe("Creating your illustrations");
      expect(status.generationProgress.finalization.illustrationJobsTotal).toBe(30);
      expect(status.generationProgress.steps.find((step: any) => step.key === "finish").status).toBe("pending");
    }
    expect(stages).toEqual([85, 85, 85]);
  });

  it("does not count an empty illustration queue as a finished fan-out", async () => {
    const status = await readStatus(generatingStatus({ project: { jobs: [job({ type: "COMPILE_EXPORT", status: "ACTIVE", progress: 35 })] }, progress: {
      pages: { complete: 30, target: 30 }, images: 1, openImageJobs: 0,
      finalization: { phase: "illustrations", label: "Creating your illustrations", pageIndex: null,
        repairPagesAttempted: 2, remainingRepairPages: 0, illustrationJobsTotal: 0, lastProgressAt: "2026-09-23T11:15:00.000Z" }
    } }));
    expect(status.generationProgress.percent).toBe(85);
  });

  it.each([30, 0])("reports full-book coverage truthfully with %i image jobs pending", async (remaining) => {
    const status = await readStatus(generatingStatus({ project: { jobs: [job({ type: "COMPILE_EXPORT", status: "ACTIVE", progress: 100 })] }, progress: {
      pages: { complete: 30, target: 30 }, images: 31 - remaining, openImageJobs: remaining,
      pipeline: [{ key: "images", label: "Images", status: remaining ? "active" : "done" }],
      finalization: { phase: "coverage", label: "Checking your book requirements", pageIndex: null,
        repairPagesAttempted: 2, remainingRepairPages: 0, illustrationJobsTotal: 30, lastProgressAt: "2026-09-23T11:15:00.000Z" }
    } }));
    expect(status.currentAction).toBe("Checking your book requirements");
    expect(status.generationProgress.percent).toBe(remaining ? 85 : 92);
    expect(status.generationProgress.steps.find((step: any) => step.key === "finish").status).toBe("active");
    expect(status.generationProgress.steps.find((step: any) => step.key === "illustrate").status).toBe(remaining ? "active" : "done");
  });

  it("keeps progress monotonic through image completion and the render successor", async () => {
    const percentages = [];
    for (const stage of [
      { phase: "repair", total: 0, remaining: 0, progress: 35 },
      { phase: "final_review", total: 0, remaining: 0, progress: 35 },
      { phase: "illustrations", total: 0, remaining: 0, progress: 35 },
      { phase: "illustrations", total: 30, remaining: 30, progress: 100 },
      { phase: "illustrations", total: 30, remaining: 1, progress: 100 },
      { phase: "illustrations", total: 30, remaining: 0, progress: 0 },
      { phase: "render", total: 30, remaining: 0, progress: 25 },
      { phase: "render", total: 30, remaining: 0, progress: 95 }
    ]) {
      const status = await readStatus(generatingStatus({ project: { jobs: [job({ type: "COMPILE_EXPORT", progress: stage.progress })] }, progress: {
        pages: { complete: 30, target: 30 }, images: 31 - stage.remaining, openImageJobs: stage.remaining,
        finalization: { phase: stage.phase, label: "Working", pageIndex: null,
          repairPagesAttempted: 2, remainingRepairPages: 0, illustrationJobsTotal: stage.total, lastProgressAt: "2026-09-23T11:15:00.000Z" }
      } }));
      percentages.push(status.generationProgress.percent);
      expect(status.generationProgress.steps.find((step: any) => step.key === "finish").status).not.toBe("done");
    }
    expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
    expect(percentages.at(-1)).toBe(99);
  });

  it("does not revive a rejected old checkpoint while a retry writes a new book", async () => {
    const status = await readStatus(generatingStatus({ project: { jobs: [job(), job({ type: "COMPILE_EXPORT", status: "COMPLETED", progress: 100,
      payload: { finalizationProgress: { phase: "published", attempts: 2, remainingRepairPages: 0, updatedAt: "2026-09-23T11:15:00Z" } } })] },
      progress: { finalization: null } }));
    expect(status.generationProgress.finalization).toBeNull();
    expect(status.generationProgress.percent).toBeLessThan(80);
    expect(status.generationProgress.steps.find((step: any) => step.key === "finish").status).toBe("pending");
  });

  it("uses durable finalization progress after a compile handoff", async () => {
    const status = await readStatus(generatingStatus({
      project: { jobs: [job({
        type: "COMPILE_EXPORT", progress: 35,
        payload: { finalizationOperationId: "private-root", finalizationProgress: {
          operationId: "private-root", phase: "repair", pageIndex: 8,
          attempts: 2, remainingRepairPages: 1, updatedAt: "2026-09-23T11:15:00.000Z"
        } },
        steps: [{ key: "qa", status: "active" }]
      })] },
      progress: { pages: { complete: 30, target: 30 } }
    }));
    expect(status.currentAction).toBe("Polishing page 8 of 30");
    expect(status.generationProgress.finalization).toMatchObject({
      phase: "repair", repairPagesAttempted: 2, remainingRepairPages: 1
    });
    expect(status.generationProgress.percent).toBeLessThan(100);
    expect(JSON.stringify(status)).not.toMatch(/private-root|operationId|provider|model/);
  });

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

  it("does not keep a write step failed after the same page is retried", async () => {
    const status = await readStatus(
      generatingStatus({
        project: {
          jobs: [
            job({
              id: "job-page-retry",
              type: "GENERATE_PAGE",
              status: "COMPLETED",
              payload: { pageId: "page-1" }
            }),
            job({
              id: "job-page-failed",
              type: "GENERATE_PAGE",
              status: "FAILED",
              error: "Page draft timed out.",
              payload: { pageId: "page-1" }
            })
          ]
        }
      })
    );

    expect(status.generationProgress.steps[1].status).not.toBe("failed");
    expect(status.failureMessage).toBeNull();
  });

  it("does not keep a superseded plan failure after the reader retries", async () => {
    const status = await readStatus(
      generatingStatus({
        project: {
          jobs: [
            job({ id: "job-page", type: "GENERATE_PAGE", status: "ACTIVE", payload: { pageId: "page-1" } }),
            job({ id: "job-book", type: "GENERATE_BOOK", status: "COMPLETED" }),
            job({ id: "job-plan-ok", type: "PLAN_BOOK", status: "COMPLETED" }),
            job({
              id: "job-plan-failed",
              type: "PLAN_BOOK",
              status: "FAILED",
              error: "OpenAI response was incomplete: max_output_tokens."
            })
          ]
        }
      })
    );

    expect(status.failureMessage).toBeNull();
  });

  it("still reports a plan failure that has not been retried", async () => {
    const status = await readStatus(
      generatingStatus({
        project: {
          status: "FAILED",
          jobs: [
            job({
              id: "job-plan-failed",
              type: "PLAN_BOOK",
              status: "FAILED",
              error: "Plan draft failed."
            })
          ]
        }
      })
    );

    expect(status.failureMessage).toContain("while creating your plan");
  });

  it("hides a plan failure as soon as the retry is queued", async () => {
    const status = await readStatus(
      generatingStatus({
        project: {
          status: "PLANNING",
          jobs: [
            job({ id: "job-plan-retry", type: "PLAN_BOOK", status: "QUEUED" }),
            job({
              id: "job-plan-failed",
              type: "PLAN_BOOK",
              status: "FAILED",
              error: "Plan draft failed."
            })
          ]
        }
      })
    );

    expect(status.failureMessage).toBeNull();
    expect(status.status).toBe("planning");
  });

  it("stays out of the way while planning and while editing", async () => {
    const planning = await readStatus(generatingStatus({ project: { status: "PLANNING" } }));
    const editing = await readStatus(generatingStatus({ project: { status: "EDITING" } }));

    expect(planning.generationProgress).toBeNull();
    expect(editing.generationProgress).toBeNull();
    expect(editing.progressPercent).toBe(92);
  });

  it("treats composed-chapter setup counters as writing, not preparing", async () => {
    const status = await readStatus(
      generatingStatus({
        project: {
          currentPlan: { planningPackage: { chapters: Array.from({ length: 15 }, (_, index) => ({ index: index + 1 })) } },
          jobs: [
            job({
              id: "job-book",
              progress: 22,
              steps: [
                {
                  key: "setup",
                  label: "Create pages",
                  status: "active",
                  done: 2,
                  total: 15,
                  phase: "compose",
                  chapterIndex: 3
                }
              ]
            })
          ]
        },
        progress: { pages: { complete: 0, target: 10 } }
      })
    );

    expect(status.generationProgress.steps[0]).toMatchObject({ key: "prepare", status: "done" });
    expect(status.generationProgress.steps[1]).toMatchObject({
      key: "write",
      label: "Writing your chapters",
      status: "active",
      detail: "2 of 15 chapters"
    });
    expect(status.generationProgress.detail).toBe("Writing chapter 3 of 15");
    expect(status.currentAction).toBe("Writing chapter 3 of 15");
    expect(status.generationProgress.percent).toBeGreaterThan(28);
    expect(status.generationProgress.percent).toBeLessThan(80);
  });

  it("phrases the manuscript read and page finalize from chapter-write phases", async () => {
    const phrases: Record<string, string> = {
      scene: "Telling chapter 3's opening",
      edit: "Editing chapter 3",
      read: "Reading the whole manuscript",
      finalize: "Getting your pages ready"
    };
    for (const [phase, phrase] of Object.entries(phrases)) {
      const status = await readStatus(
        generatingStatus({
          project: {
            jobs: [
              job({
                id: "job-book",
                progress: 70,
                steps: [
                  {
                    key: "setup",
                    label: "Create pages",
                    status: "active",
                    done: 15,
                    total: 15,
                    phase,
                    chapterIndex: 3
                  }
                ]
              })
            ]
          },
          progress: { pages: { complete: 0, target: 10 } }
        })
      );
      expect(status.generationProgress.detail).toBe(phrase);
      expect(status.generationProgress.steps[1].status).toBe("active");
    }
  });

  it("walks the prepare phrase through the book's own briefing phases", async () => {
    const phrases: Record<string, string> = {
      stance: "Finding the book's voice",
      arc: "Planning how the book unfolds",
      episodes: "Planning what each chapter covers",
      sources: "Gathering sources for chapter 3 of 15",
      evidence: "Checking the book's sources",
      develop: "Shaping how the chapters connect",
      forms: "Planning the shape of every chapter",
      briefs: "Mapping out chapter 3 of 15",
      references: "Drawing your characters",
      research: "Looking up background for your 15 chapters"
    };
    for (const [phase, phrase] of Object.entries(phrases)) {
      const status = await readStatus(
        generatingStatus({
          project: {
            currentPlan: { planningPackage: { chapters: Array.from({ length: 15 }, (_, index) => ({ index: index + 1 })) } },
            jobs: [
              job({
                id: "job-book",
                progress: 15,
                steps: [
                  {
                    key: "briefs",
                    label: "Prepare book",
                    status: "active",
                    phase,
                    ...(phase === "sources" || phase === "briefs" ? { chapterIndex: 3, total: 15 } : {})
                  }
                ]
              })
            ]
          },
          progress: { pages: { complete: 0, target: 10 } }
        })
      );
      expect(status.generationProgress.detail).toBe(phrase);
      expect(status.generationProgress.steps[0]).toMatchObject({
        key: "prepare",
        label: "Preparing your chapters",
        status: "active"
      });
      if (phase === "sources" || phase === "briefs") {
        expect(status.generationProgress.steps[0].detail).toBe("3 of 15 chapters");
      }
    }
  });

  it("keeps drawing characters on preparing when sequential setup has no write counters", async () => {
    const status = await readStatus(
      generatingStatus({
        project: {
          jobs: [
            job({
              id: "job-book",
              progress: 70,
              steps: [{ key: "setup", label: "Create pages", status: "active", phase: "references" }]
            })
          ]
        },
        progress: { pages: { complete: 0, target: 10 } }
      })
    );

    expect(status.generationProgress.steps[0]).toMatchObject({ key: "prepare", status: "active" });
    expect(status.generationProgress.steps[1].status).toBe("pending");
    expect(status.generationProgress.detail).toBe("Drawing your characters");
  });

  it("keeps sequential setup without counters on preparing", async () => {
    const status = await readStatus(
      generatingStatus({
        project: {
          jobs: [
            job({
              id: "job-book",
              progress: 35,
              steps: [{ key: "setup", label: "Create pages", status: "active" }]
            })
          ]
        },
        progress: { pages: { complete: 0, target: 10 } }
      })
    );

    expect(status.generationProgress.steps.map((step: any) => step.status)).toEqual([
      "active",
      "pending",
      "pending",
      "pending"
    ]);
    expect(status.generationProgress.steps[0].label).toBe("Preparing your chapters");
    expect(status.generationProgress.detail).toBe("Setting up your chapters and pages");
    expect(status.generationProgress.percent).toBeGreaterThanOrEqual(20);
    expect(status.generationProgress.percent).toBeLessThanOrEqual(28);
  });

  it("walks the write band as composed chapters finish while pages stay pending", async () => {
    const percents: number[] = [];
    for (const done of [0, 1, 8]) {
      const status = await readStatus(
        generatingStatus({
          project: {
            jobs: [
              job({
                id: "job-book",
                progress: 22,
                steps: [
                  {
                    key: "setup",
                    label: "Create pages",
                    status: "active",
                    done,
                    total: 15,
                    phase: "compose",
                    chapterIndex: done + 1
                  }
                ]
              })
            ]
          },
          progress: { pages: { complete: 0, target: 10 } }
        })
      );
      percents.push(status.generationProgress.percent);
    }

    expect(percents).toEqual([...percents].sort((left, right) => left - right));
    expect(new Set(percents).size).toBe(percents.length);
    expect(percents[0]).toBeGreaterThanOrEqual(28);
    expect(Math.max(...percents)).toBeLessThan(80);
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
