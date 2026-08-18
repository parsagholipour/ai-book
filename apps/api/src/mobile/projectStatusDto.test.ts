import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  bookPdfCoverNumbering,
  DETACHED_FROM_PROJECT_LIFECYCLE,
  PRESENTATION_ONLY_RECOMPILE
} from "@book-maker/core";
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

// Split from projects.test.ts along the route seam: everything here exercises
// GET /api/mobile/projects/:id/status and the DTO it serializes.
describe("mobile project status DTO", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("returns a readable mobile status DTO without queue-centric internals", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          id: "project-1",
          title: "Progress Book",
          status: "GENERATING",
          updatedAt: new Date("2026-06-15T12:30:00.000Z"),
          jobs: [
            { id: "job-audio-failed", type: "GENERATE_AUDIOBOOK", status: "FAILED", error: "Speech quota exhausted." },
            { id: "job-failed", type: "GENERATE_PAGE", status: "FAILED", error: "Page draft timed out." },
            { id: "job-active", type: "GENERATE_PAGE", status: "ACTIVE", error: null }
          ],
          generationAttempts: [
            {
              id: "attempt-failed",
              commandKey: "mobile:plan-approval:plan-1",
              status: "FAILED",
              quotedCredits: 776,
              refundPending: false
            }
          ]
        },
        progress: {
          pages: { complete: 3, target: 10 },
          images: 1,
          resumableFailedJobs: 1,
          resumableAttemptIds: ["attempt-failed"],
          pipeline: [
            { key: "plan", label: "Plan", status: "done" },
            { key: "pages", label: "Pages", status: "active", detail: "3/10 pages" },
            { key: "images", label: "Images", status: "pending", detail: "1 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        },
        quality: {
          state: "review_recommended",
          score: 88,
          issues: [
            {
              code: "CHAPTER_TRANSITION",
              severity: "warning",
              source: "model",
              message: "The handoff is abrupt.",
              guidance: "Review pages 3 and 4.",
              affectedPageIndexes: [3, 4]
            }
          ],
          affectedPageIndexes: [3, 4]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.status).toMatchObject({
      projectId: "project-1",
      status: "generating",
      statusLabel: "Generating your book",
      progressPercent: 44,
      currentAction: "Writing page 4",
      retryAvailable: true,
      recoveryQuote: { credits: 776, retryToken: expect.any(String) },
      pageProgress: { completed: 3, target: 10 },
      imageCount: 1
    });
    expect(body.status.quality).toMatchObject({
      state: "review_recommended",
      score: 88,
      affectedPageIndexes: [3, 4]
    });
    expect(body.status.failureMessage).toContain("while writing a page");
    expect(body.status.failureMessage).not.toContain("narrat");
    expect(body.status.failureMessage).not.toContain("GENERATE_PAGE");
    expect(JSON.stringify(body.status)).not.toMatch(/jobs|queue|tokens|cost|provider/);
    await app.close();
  });

  it("quotes the failed paid retry, never the original attempt whose retry slot is spent", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          id: "project-1",
          title: "Progress Book",
          status: "FAILED",
          updatedAt: new Date("2026-06-15T12:30:00.000Z"),
          jobs: [{ id: "job-failed", type: "GENERATE_PAGE", status: "FAILED", error: "Page draft timed out." }],
          generationAttempts: [
            {
              id: "attempt-original",
              commandKey: "mobile:plan-approval:plan-1",
              status: "FAILED",
              quotedCredits: 776,
              refundPending: false,
              // Its paid retry exists — replaying it can never queue work again.
              retryAttempt: { id: "attempt-paid-retry" }
            },
            {
              id: "attempt-paid-retry",
              commandKey: "mobile:generation-retry:attempt-original:req-1",
              status: "FAILED",
              quotedCredits: 776,
              refundPending: false,
              retryAttempt: null
            }
          ]
        },
        progress: {
          resumableFailedJobs: 2,
          // Job-creation order: the original attempt's jobs are older.
          resumableAttemptIds: ["attempt-original", "attempt-paid-retry"]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.status.retryAvailable).toBe(true);
    // The retry token must be derived from the failed retry, not the original.
    const { generationRecoveryQuote } = await import("./generationRetryQuote.js");
    expect(body.status.recoveryQuote).toEqual(
      generationRecoveryQuote({
        id: "attempt-paid-retry",
        commandKey: "mobile:generation-retry:attempt-original:req-1",
        quotedCredits: 776
      })
    );
    await app.close();
  });

  it("keeps a derivative operation failure out of a completed book's status", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          id: "project-1",
          title: "Finished Book",
          status: "COMPLETE",
          jobs: [
            {
              id: "job-audio-failed",
              type: "GENERATE_AUDIOBOOK",
              status: "FAILED",
              progress: 33,
              error: "Speech quota exhausted."
            },
            { id: "job-compile", type: "COMPILE_EXPORT", status: "COMPLETED", progress: 100, error: null }
          ]
        },
        progress: {
          pages: { complete: 12, target: 12 },
          images: 3,
          pipeline: [
            { key: "plan", label: "Plan", status: "done" },
            { key: "pages", label: "Pages", status: "done", detail: "12/12 pages" },
            { key: "images", label: "Images", status: "done", detail: "3 images" },
            { key: "export", label: "Export", status: "done", detail: "Markdown & PDF ready" }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const status = response.json().status;

    expect(response.statusCode).toBe(200);
    expect(status).toMatchObject({
      status: "complete",
      progressPercent: 100,
      currentAction: "Ready to download.",
      failureMessage: null
    });
    expect(status.generationProgress).toMatchObject({ percent: 100, detail: null });
    await app.close();
  });

  it("keeps a failed export repair out of a completed book's status", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          id: "project-1",
          title: "Finished Book",
          status: "COMPLETE",
          jobs: [
            // The compile that rebuilds a missing PDF for a book that is already
            // finished and paid for. It fails alone: the reader has a book, and
            // the next download or status poll queues another repair.
            {
              id: "job-repair-failed",
              type: "COMPILE_EXPORT",
              status: "FAILED",
              progress: 40,
              error: "Chromium disconnected.",
              payload: { planId: "plan-1", skipFinalReview: true, [DETACHED_FROM_PROJECT_LIFECYCLE]: true }
            },
            { id: "job-compile", type: "COMPILE_EXPORT", status: "COMPLETED", progress: 100, error: null }
          ]
        },
        progress: {
          pages: { complete: 12, target: 12 },
          images: 3,
          pipeline: [
            { key: "plan", label: "Plan", status: "done" },
            { key: "pages", label: "Pages", status: "done", detail: "12/12 pages" },
            { key: "images", label: "Images", status: "done", detail: "3 images" },
            { key: "export", label: "Export", status: "done", detail: "Markdown & PDF ready" }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const status = response.json().status;

    expect(response.statusCode).toBe(200);
    expect(status).toMatchObject({
      status: "complete",
      currentAction: "Ready to download.",
      failureMessage: null
    });
    // The book's own last step stays done: nothing about it failed.
    expect(status.generationProgress).toMatchObject({ percent: 100 });
    expect(status.generationProgress.steps.every((step: { status: string }) => step.status !== "failed")).toBe(true);
    await app.close();
  });

  it("keeps a failed presentation reprint out of a completed book's status", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          id: "project-1",
          title: "Finished Book",
          status: "COMPLETE",
          jobs: [
            // The free recompile a Sources-list or chapter-heading toggle
            // queues. Like a repair it settles alone: the book is delivered,
            // its manuscript unchanged, and the reader can re-toggle — so a
            // Chromium blip here must not paint the book "needs attention".
            {
              id: "job-reprint-failed",
              type: "COMPILE_EXPORT",
              status: "FAILED",
              progress: 40,
              error: "Chromium disconnected.",
              payload: { planId: "plan-1", skipFinalReview: true, [PRESENTATION_ONLY_RECOMPILE]: true }
            },
            { id: "job-compile", type: "COMPILE_EXPORT", status: "COMPLETED", progress: 100, error: null }
          ]
        },
        progress: {
          pages: { complete: 12, target: 12 },
          images: 3,
          pipeline: [
            { key: "plan", label: "Plan", status: "done" },
            { key: "pages", label: "Pages", status: "done", detail: "12/12 pages" },
            { key: "images", label: "Images", status: "done", detail: "3 images" },
            { key: "export", label: "Export", status: "done", detail: "Markdown & PDF ready" }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const status = response.json().status;

    expect(response.statusCode).toBe(200);
    expect(status).toMatchObject({
      status: "complete",
      currentAction: "Ready to download.",
      failureMessage: null
    });
    expect(status.generationProgress).toMatchObject({ percent: 100 });
    expect(status.generationProgress.steps.every((step: { status: string }) => step.status !== "failed")).toBe(true);
    await app.close();
  });

  it("exposes real planning milestones without queue internals", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          status: "PLANNING",
          jobs: [
            {
              id: "job-plan",
              type: "PLAN_BOOK",
              status: "ACTIVE",
              progress: 55,
              error: null,
              steps: [
                { key: "research", label: "Research", status: "done" },
                { key: "plan", label: "Create plan", status: "active" },
                { key: "save", label: "Save plan", status: "pending" }
              ]
            }
          ]
        },
        progress: {
          pipeline: [
            { key: "plan", label: "Plan", status: "active", detail: "Planning in progress" },
            { key: "pages", label: "Pages", status: "pending", detail: "0/12 pages" },
            { key: "images", label: "Images", status: "pending", detail: "0 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const status = response.json().status;

    expect(response.statusCode).toBe(200);
    expect(status.currentAction).toBe("Shaping the chapters and flow");
    expect(status.planningProgress).toEqual({
      percent: 55,
      steps: [
        { key: "understand", label: "Understanding your idea", status: "done" },
        { key: "shape", label: "Shaping the chapters and flow", status: "active" },
        { key: "finalize", label: "Finalizing your plan", status: "pending" }
      ]
    });
    expect(JSON.stringify(status)).not.toMatch(/job-plan|PLAN_BOOK|queue|Research|Create plan|Save plan/);
    await app.close();
  });

  it("uses live generated output to advance planning within milestone guardrails", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    const planningStatus = (outputTokens: number) =>
      statusRecord({
        project: {
          status: "PLANNING",
          targetPages: 24,
          jobs: [
            {
              id: "job-plan",
              type: "PLAN_BOOK",
              status: "ACTIVE",
              progress: 45,
              error: null,
              tokens: { outputTokens },
              steps: [
                { key: "research", label: "Research", status: "done" },
                { key: "plan", label: "Create plan", status: "active" },
                { key: "save", label: "Save plan", status: "pending" }
              ]
            }
          ]
        },
        progress: {
          pipeline: [
            { key: "plan", label: "Plan", status: "active", detail: "Planning in progress" },
            { key: "pages", label: "Pages", status: "pending", detail: "0/24 pages" },
            { key: "images", label: "Images", status: "pending", detail: "0 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      });
    vi.mocked(buildProjectStatus)
      .mockResolvedValueOnce(planningStatus(200))
      .mockResolvedValueOnce(planningStatus(1_200))
      .mockResolvedValueOnce(planningStatus(100_000));
    const app = await buildMobileApp();

    const percentages: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/status",
        headers: bearer("token-a")
      });
      expect(response.statusCode).toBe(200);
      percentages.push(response.json().status.planningProgress.percent);
      expect(JSON.stringify(response.json().status)).not.toMatch(/tokens|provider|model|cost|queue/i);
    }

    expect(percentages[0]).toBeGreaterThan(45);
    expect(percentages[1]).toBeGreaterThan(percentages[0]!);
    expect(percentages[2]).toBeGreaterThanOrEqual(percentages[1]!);
    expect(percentages[2]).toBeLessThan(100);
    await app.close();
  });

  it("preserves milestone progress when no live output tokens are available", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          status: "PLANNING",
          targetPages: 24,
          jobs: [
            {
              id: "job-plan",
              type: "PLAN_BOOK",
              status: "ACTIVE",
              progress: 45,
              error: null,
              tokens: { outputTokens: 0 },
              steps: [
                { key: "research", label: "Research", status: "done" },
                { key: "plan", label: "Create plan", status: "active" },
                { key: "save", label: "Save plan", status: "pending" }
              ]
            }
          ]
        },
        progress: {
          pipeline: [
            { key: "plan", label: "Plan", status: "active", detail: "Planning in progress" },
            { key: "pages", label: "Pages", status: "pending", detail: "0/24 pages" },
            { key: "images", label: "Images", status: "pending", detail: "0 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status.planningProgress.percent).toBe(45);
    await app.close();
  });

  it("uses a smaller adaptive output target for live plan revisions", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          status: "PLANNING",
          targetPages: 24,
          jobs: [
            {
              id: "job-revision",
              type: "REVISE_PLAN",
              status: "ACTIVE",
              progress: 35,
              error: null,
              tokens: { outputTokens: 450 },
              steps: [
                { key: "revise", label: "Revise plan", status: "active" },
                { key: "save", label: "Save revision", status: "pending" }
              ]
            }
          ]
        },
        progress: {
          pipeline: [
            { key: "plan", label: "Plan", status: "active", detail: "Planning in progress" },
            { key: "pages", label: "Pages", status: "pending", detail: "0/24 pages" },
            { key: "images", label: "Images", status: "pending", detail: "0 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const status = response.json().status;

    expect(response.statusCode).toBe(200);
    expect(status.currentAction).toBe("Improving your plan");
    expect(status.planningProgress.percent).toBeGreaterThan(35);
    expect(status.planningProgress.percent).toBeLessThan(90);
    expect(JSON.stringify(status)).not.toMatch(/tokens|provider|model|cost|queue/i);
    await app.close();
  });

  it("keeps completed planning milestones for the plan-ready handoff", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          status: "PLAN_READY",
          jobs: [
            {
              id: "job-plan",
              type: "PLAN_BOOK",
              status: "COMPLETED",
              progress: 100,
              error: null,
              steps: [
                { key: "research", label: "Research", status: "done" },
                { key: "plan", label: "Create plan", status: "done" },
                { key: "save", label: "Save plan", status: "done" }
              ]
            }
          ]
        },
        progress: {
          pipeline: [
            { key: "plan", label: "Plan", status: "done", detail: "Plan ready" },
            { key: "pages", label: "Pages", status: "pending", detail: "0/12 pages" },
            { key: "images", label: "Images", status: "pending", detail: "0 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const status = response.json().status;

    expect(response.statusCode).toBe(200);
    expect(status.currentAction).toBe("Ready for review.");
    expect(status.planningProgress).toEqual({
      percent: 100,
      steps: [
        { key: "understand", label: "Understanding your idea", status: "done" },
        { key: "shape", label: "Shaping the chapters and flow", status: "done" },
        { key: "finalize", label: "Finalizing your plan", status: "done" }
      ]
    });
    await app.close();
  });

  it("uses revision copy and a safe queued planning fallback", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          status: "PLANNING",
          jobs: [
            {
              id: "job-revision",
              type: "REVISE_PLAN",
              status: "QUEUED",
              progress: 0,
              error: null,
              steps: []
            }
          ]
        },
        progress: {
          pipeline: [
            { key: "plan", label: "Plan", status: "active", detail: "Planning in progress" },
            { key: "pages", label: "Pages", status: "pending", detail: "0/12 pages" },
            { key: "images", label: "Images", status: "pending", detail: "0 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const status = response.json().status;

    expect(response.statusCode).toBe(200);
    expect(status.currentAction).toBe("Improving your plan");
    expect(status.planningProgress).toEqual({
      percent: 0,
      steps: [
        { key: "understand", label: "Understanding your changes", status: "done" },
        { key: "shape", label: "Improving your plan", status: "active" },
        { key: "finalize", label: "Saving your revision", status: "pending" }
      ]
    });
    expect(JSON.stringify(status)).not.toMatch(/job-revision|REVISE_PLAN|queue/);
    await app.close();
  });

  it("reports hasCoverPage from the current page map", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    const map = {
      version: 2,
      totalPdfPages: 8,
      hasCoverPage: true,
      pages: [{ index: 1, startPdfPage: 3, endPdfPage: 4 }],
      contentRevision: 3,
      pdfDigest: "pdf-digest-a"
    };
    const app = await buildMobileApp();
    // The status DTO is the only place the app reads this flag from, so every
    // shape of stored map is asked for here.
    const statusFor = async (
      pdfPageMap: unknown,
      options: { contentRevision?: number; status?: string } = {}
    ) => {
      vi.mocked(buildProjectStatus).mockResolvedValue(
        statusRecord({
          project: {
            id: "project-1",
            contentRevision: options.contentRevision ?? 3,
            ...(options.status ? { status: options.status } : {}),
            ...(pdfPageMap === undefined ? {} : { pdfPageMap })
          }
        })
      );
      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/status",
        headers: bearer("token-a")
      });
      expect(response.statusCode).toBe(200);
      return response.json().status;
    };

    await expect(statusFor(map)).resolves.toMatchObject({
      hasCoverPage: true,
      pdfPageNumbering: {
        hasCoverPage: true,
        contentRevision: 3,
        pdfDigest: "pdf-digest-a"
      }
    });
    await expect(statusFor({ ...map, hasCoverPage: false })).resolves.toMatchObject({
      hasCoverPage: false,
      pdfPageNumbering: {
        hasCoverPage: false,
        contentRevision: 3,
        pdfDigest: "pdf-digest-a"
      }
    });
    // Version-1 maps counted the cover; chrome must not skip sheet 1.
    expect((await statusFor({ ...map, version: 1 })).hasCoverPage).toBe(false);
    // A failed measurement still records cover-skip so chrome matches the footer,
    // and so does a renumber that lost a range — an applied page delete leaves
    // exactly this shape (`repointedPageMapUpdate`), which is why nulling the
    // column there took the flag away from every deleted-page book.
    expect(
      (
        await statusFor({
          ...bookPdfCoverNumbering(true),
          contentRevision: 3,
          pdfDigest: "pdf-digest-a"
        })
      ).hasCoverPage
    ).toBe(true);
    expect(
      (
        await statusFor({
          ...bookPdfCoverNumbering(true, 1),
          contentRevision: 3,
          pdfDigest: "pdf-digest-a"
        })
      ).hasCoverPage
    ).toBe(false);
    // The marker is a refusal for chat, never for chrome, so a stub written
    // before it existed reads the same.
    expect(
      (
        await statusFor({
          version: 2,
          hasCoverPage: true,
          pages: [],
          contentRevision: 3,
          pdfDigest: "pdf-digest-a"
        })
      ).hasCoverPage
    ).toBe(true);
    // During EDITING the stored map is deliberately behind the project. The
    // DTO exposes that map's identity, never the offered project revision.
    await expect(statusFor(map, { contentRevision: 4, status: "EDITING" })).resolves.toMatchObject({
      pdfPageNumbering: { contentRevision: 3, pdfDigest: "pdf-digest-a" }
    });
    // A same-revision repair changes the exact byte identity on the wire.
    await expect(statusFor({ ...map, pdfDigest: "pdf-digest-b" })).resolves.toMatchObject({
      pdfPageNumbering: { contentRevision: 3, pdfDigest: "pdf-digest-b" }
    });
    // Legacy rows missing either stamp are not enough to number an exact file.
    expect(await statusFor({ ...map, pdfDigest: undefined })).not.toHaveProperty("hasCoverPage");
    expect(await statusFor({ ...map, contentRevision: undefined })).not.toHaveProperty("pdfPageNumbering");
    // A map measured against another revision describes a book the reader is
    // no longer looking at, so it answers nothing at all.
    expect(await statusFor({ ...map, contentRevision: 2 })).not.toHaveProperty("hasCoverPage");
    expect(await statusFor(undefined)).not.toHaveProperty("pdfPageNumbering");
    await app.close();
  });
});
