import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  mockProjectStatus,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("mobile project listing and detail", () => {
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

  it("takes project detail's quality verdict from the owning compile, not a window of recent jobs", async () => {
    // A book whose exports keep going missing queues a repair every five
    // minutes, and eight of those used to bury the compile that actually
    // reviewed the manuscript — after which detail reported no verdict at all.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-a", status: "COMPLETE" }));
    const owningReport = { state: "review_recommended", score: 91, issues: [], affectedPageIndexes: [7] };
    mockPrisma.generationJob.findFirst.mockResolvedValue({ qualityReport: owningReport });
    const app = await buildMobileApp();

    const response = await app.inject({ method: "GET", url: "/api/mobile/projects/project-a", headers: bearer("token-a") });

    expect(response.statusCode).toBe(200);
    expect(mockProjectStatus.normalizeProjectQuality).toHaveBeenCalledWith(owningReport);
    expect(mockPrisma.generationJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: "project-a", type: "COMPILE_EXPORT", ownsQualityVerdict: true }),
        orderBy: { createdAt: "desc" }
      })
    );
    // No window left to fall out of: nothing scans the compile list any more.
    expect(mockPrisma.generationJob.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ type: "COMPILE_EXPORT" }) })
    );
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
});
