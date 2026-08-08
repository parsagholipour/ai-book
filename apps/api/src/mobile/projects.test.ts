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
  projectRecord,
  resetMobileHarness,
  statusRecord,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("mobile project listing, detail and status", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("lists and reads only the signed-in user's mobile project DTOs", async () => {
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
    mockPrisma.project.findMany.mockResolvedValueOnce([projectRecord({ id: "project-a", title: "Owned Mobile Book" })]);
    mockPrisma.project.findFirst.mockResolvedValueOnce(null);
    const app = await buildMobileApp();

    const list = await app.inject({
      method: "GET",
      url: "/api/mobile/projects",
      headers: bearer("token-a")
    });
    const crossUserDetail = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-b",
      headers: bearer("token-a")
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().projects).toEqual([expect.objectContaining({ id: "project-a", title: "Owned Mobile Book" })]);
    expect(mockPrisma.project.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-a" } }));
    expect(crossUserDetail.statusCode).toBe(404);
    expect(mockPrisma.project.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "project-b", userId: "user-a" } })
    );
    expect(JSON.stringify(list.json())).not.toMatch(/temperature|generationStrategy|provider|model|mediaSettings|cost|tokens/);
    await app.close();
  });

  it("derives the exact cover and illustration choices from authoritative media settings", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const recordWithImages = (
      id: string,
      coverEnabled: boolean,
      illustrationsEnabled: boolean,
      staleAggregate: boolean
    ) =>
      projectRecord({
        id,
        mediaSettings: {
          fullIllustrations: illustrationsEnabled,
          illustrationCadence: illustrationsEnabled ? "template-driven" : "manual",
          includeCover: coverEnabled,
          coverTemplate: "business",
          finalReview: true,
          toneProfile: "neutral",
          mobile: {
            bookType: "lead_magnet",
            lengthPreset: "short",
            qualityPreset: "balanced",
            imagesEnabled: staleAggregate
          }
        }
      });
    mockPrisma.project.findMany.mockResolvedValueOnce([
      recordWithImages("both", true, true, false),
      recordWithImages("cover-only", true, false, false),
      recordWithImages("illustrations-only", false, true, false),
      recordWithImages("neither", false, false, true)
    ]);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json().projects.map((project: any) => ({
        id: project.id,
        coverEnabled: project.coverEnabled,
        illustrationsEnabled: project.illustrationsEnabled,
        imagesEnabled: project.imagesEnabled
      }))
    ).toEqual([
      { id: "both", coverEnabled: true, illustrationsEnabled: true, imagesEnabled: true },
      { id: "cover-only", coverEnabled: true, illustrationsEnabled: false, imagesEnabled: true },
      { id: "illustrations-only", coverEnabled: false, illustrationsEnabled: true, imagesEnabled: true },
      { id: "neither", coverEnabled: false, illustrationsEnabled: false, imagesEnabled: false }
    ]);
    await app.close();
  });

  it("includes cover art on listed projects so the library can show a shelf", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findMany.mockResolvedValueOnce([
      projectRecord({
        id: "project-a",
        title: "Covered Book",
        images: [
          {
            id: "image-cover",
            projectId: "project-a",
            pageId: null,
            type: "COVER",
            path: "http://localhost:4001/assets/images/project-a/cover.png",
            metadata: { mimeType: "image/png", model: "hidden" }
          }
        ]
      }),
      projectRecord({ id: "project-b", title: "Coverless Book", images: [] })
    ]);
    const app = await buildMobileApp();

    const list = await app.inject({
      method: "GET",
      url: "/api/mobile/projects",
      headers: bearer("token-a")
    });
    const [covered, coverless] = list.json().projects;

    expect(list.statusCode).toBe(200);
    expect(covered.coverImage).toMatchObject({ id: "image-cover", role: "cover" });
    // A book without a rendered cover reports null rather than omitting the key.
    expect(coverless.coverImage).toBeNull();
    // Only the cover is loaded for a list; page visuals would bloat the payload.
    expect(mockPrisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          images: expect.objectContaining({ where: { type: "COVER" }, take: 1 })
        })
      })
    );
    await app.close();
  });

  it("returns generated page previews and mobile-safe image references on project detail", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(
      projectRecord({
        id: "project-a",
        title: "Preview Book",
        status: "GENERATING",
        pages: [
          {
            id: "page-1",
            projectId: "project-a",
            index: 1,
            title: "Set the promise",
            markdown:
              "## Set the promise\n\nA strong promise names the reader, the outcome, and the moment they can see progress.",
            summary: "Define the result the reader should get.",
            status: "COMPLETED",
            images: [
              {
                id: "image-page",
                projectId: "project-a",
                pageId: "page-1",
                type: "DIAGRAM",
                path: "http://localhost:4001/assets/images/project-a/page-1.png",
                metadata: { mimeType: "image/png", model: "hidden" }
              }
            ]
          },
          {
            id: "page-2",
            projectId: "project-a",
            index: 2,
            title: "Show the first win",
            markdown: "## Show the first win\n\nGive the reader a result within the first session.",
            summary: "The reader ships something small.",
            status: "COMPLETED",
            imageFailureReason: "interior_image_failed",
            images: []
          }
        ],
        images: [
          {
            id: "image-cover",
            projectId: "project-a",
            pageId: null,
            type: "COVER",
            path: "http://localhost:4001/assets/images/project-a/cover.png",
            metadata: { mimeType: "image/png", provider: "hidden" }
          }
        ],
        _count: { pages: 1, images: 2, jobs: 1 }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a",
      headers: bearer("token-a")
    });
    const project = response.json().project;

    expect(response.statusCode).toBe(200);
    expect(project.pages[0]).toMatchObject({
      title: "Set the promise",
      previewText: expect.stringContaining("A strong promise names the reader"),
      imageFailed: false,
      image: {
        id: "image-page",
        url: "/api/mobile/projects/project-a/assets/image-page",
        contentType: "image/png"
      }
    });
    // A lost illustration is reported as a flag, never as the reason code.
    expect(project.pages[1]).toMatchObject({ title: "Show the first win", image: null, imageFailed: true });
    expect(JSON.stringify(project)).not.toContain("interior_image_failed");
    expect(project.coverImage).toMatchObject({
      id: "image-cover",
      role: "cover",
      url: "/api/mobile/projects/project-a/assets/image-cover"
    });
    expect(JSON.stringify(project)).not.toMatch(/temperature|generationStrategy|mediaSettings|cost|tokens/);
    // Not a replan copy, so it names no origin.
    expect(project.revisedFrom).toBeNull();
    await app.close();
  });

  it("names the book a replan copy was rebuilt from, without the internal markers", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(
      projectRecord({
        id: "project-copy",
        title: "Preview Book (revised)",
        mediaSettings: {
          mobile: {
            bookType: "lead_magnet",
            revisionOfProjectId: "project-a",
            revisionOperationId: "operation-1",
            revisionRequest: "Rebuild it in French",
            revisionSource: "project_chat_book_replan",
            revisionTargetLanguage: "fr"
          }
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-copy",
      headers: bearer("token-a")
    });
    const project = response.json().project;

    expect(response.statusCode).toBe(200);
    expect(project.revisedFrom).toEqual({
      projectId: "project-a",
      request: "Rebuild it in French",
      targetLanguage: "fr"
    });
    // The operation linkage and source marker are server-side provenance.
    expect(JSON.stringify(project)).not.toMatch(/operation-1|revisionSource/);
    await app.close();
  });

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

});
