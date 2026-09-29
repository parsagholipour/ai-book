import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { createProjectSchema, isStudioManuscript, synthesizeAuthorBookPlan } from "@book-maker/core";
import type { FastifyInstance } from "fastify";
import { installManuscriptFakeDb, type ManuscriptFakeDb } from "./testing/manuscriptFakeDb.js";
import {
  buildMobileApp,
  mockAccessTokens,
  mockBilling,
  mockPrisma,
  openJobRow,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { AUTH, createStudioBook } from "./testing/manuscriptTestSupport.js";

let db: ManuscriptFakeDb;

beforeEach(() => {
  resetMobileHarness();
  db = installManuscriptFakeDb();
  mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
});
afterEach(teardownMobileHarness);

/** A generated book the planner has answered, waiting for approval. */
function seedPlannedBook(options: { category?: string; targetPages?: number; status?: string; planStatus?: string } = {}): string {
  const projectId = "project-planned";
  const now = new Date("2026-09-20T10:00:00.000Z");
  const plan = synthesizeAuthorBookPlan({
    title: "The Lighthouse",
    chapters: [
      { title: "The Keeper", summary: "Mira takes the lamp for the first time.", pageCount: 4 },
      { title: "The Storm", summary: "A ship runs aground.", pageCount: 4 }
    ]
  });
  plan.chapters[0]!.keyBeats = ["She climbs the stairs alone.", "The lamp will not light."];
  db.projects.push({
    id: projectId,
    userId: "user-a",
    title: "The Lighthouse",
    subtitle: null,
    authorName: null,
    coverTagline: null,
    prompt: "A story about a lighthouse keeper's daughter during a storm.",
    category: options.category ?? "STORY",
    subcategory: null,
    targetPages: options.targetPages ?? 24,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "every_page",
      includeCover: true,
      coverArtSource: "ai",
      finalReview: true,
      toneProfile: "neutral",
      modelTier: "balanced",
      mobile: {
        bookType: "story",
        qualityPreset: "balanced",
        imagesEnabled: true,
        illustrationsEnabled: true,
        targetPages: 24,
        characters: [{ id: "char-mira", name: "Mira", description: "The keeper's daughter.", fields: [] }]
      }
    },
    status: options.status ?? "PLAN_READY",
    contentRevision: 0,
    currentPlanId: "plan-draft",
    pdfPageMap: null,
    createdAt: now,
    updatedAt: now
  });
  db.planVersions.push({
    id: "plan-draft",
    projectId,
    version: 1,
    status: options.planStatus ?? "DRAFT",
    planningPackage: plan,
    inputSnapshot: {},
    messages: [],
    approvedAt: null,
    createdAt: now,
    updatedAt: now
  });
  return projectId;
}

function fromPlan(app: FastifyInstance, projectId: string, requestId = "request-from-plan-0001", token = "token-a") {
  return app.inject({
    method: "POST",
    url: `/api/mobile/projects/${projectId}/manuscript/from-plan`,
    headers: { authorization: `Bearer ${token}` },
    payload: { requestId }
  });
}

describe("POST /manuscript/from-plan", () => {
  it("turns an unapproved plan into a Studio book whose chapters are the plan's, for free", async () => {
    const app = await buildMobileApp();
    const projectId = seedPlannedBook();

    const response = await fromPlan(app, projectId);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.project).toMatchObject({ id: projectId, source: "written", status: "draft", statusLabel: "Writing · 0 words" });
    expect(body.manuscript).toMatchObject({ source: "written", layout: "flow", kind: "story", published: false, castCharacterIds: ["char-mira"] });
    expect(body.manuscript.chapters.map((chapter: { title: string; status: string }) => [chapter.title, chapter.status])).toEqual([
      ["The Keeper", "idea"],
      ["The Storm", "idea"]
    ]);
    expect(db.manuscriptChapters.map((chapter) => chapter.notes)).toEqual([
      "Mira takes the lamp for the first time.\n\n- She climbs the stairs alone.\n- The lamp will not light.",
      "A ship runs aground."
    ]);
    expect(db.manuscriptChapters.every((chapter) => chapter.markdown === "")).toBe(true);

    const project = db.projects[0]!;
    expect(project).toMatchObject({ status: "DRAFT", currentPlanId: null, targetPages: 1, prompt: "Author-written manuscript: The Lighthouse" });
    expect(project.mediaSettings).toMatchObject({
      finalReview: false,
      fullIllustrations: false,
      coverArtSource: "design",
      includeCover: false,
      mobile: { studio: { layout: "flow", kind: "story", fromPlanId: "plan-draft", fromPlanRequestId: "request-from-plan-0001" } }
    });
    expect(isStudioManuscript(project.mediaSettings)).toBe(true);
    expect(createProjectSchema.safeParse({ ...project, subtitle: undefined, authorName: undefined, coverTagline: undefined, subcategory: undefined }).success).toBe(true);
    // Superseded, so no plan route can approve it into a generated book.
    expect(db.planVersions[0]!.status).toBe("SUPERSEDED");
    expect(mockBilling.reserveCredits).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(/model/i);
  });

  it("answers a replayed request with the book it made", async () => {
    const app = await buildMobileApp();
    const projectId = seedPlannedBook();

    await fromPlan(app, projectId);
    const again = await fromPlan(app, projectId);

    expect(again.statusCode).toBe(200);
    expect(again.json().manuscript.chapters).toHaveLength(2);
    expect(db.manuscripts).toHaveLength(1);
    expect(db.manuscriptChapters).toHaveLength(2);
  });

  it("gives a short kids' book the picture layout", async () => {
    const app = await buildMobileApp();
    const projectId = seedPlannedBook({ category: "KIDS", targetPages: 16 });

    const response = await fromPlan(app, projectId);

    expect(response.json().manuscript).toMatchObject({ layout: "picture", kind: "picture" });
  });

  it("refuses a plan that is approved, a book with pages, one already written, one still at work, and another reader's", async () => {
    const app = await buildMobileApp();
    const expectRefused = async (projectId: string, requestId: string) => {
      const response = await fromPlan(app, projectId, requestId);
      expect([response.statusCode, response.json().error.code]).toEqual([409, "PLAN_NOT_CONVERTIBLE"]);
    };

    const approved = seedPlannedBook({ status: "GENERATING", planStatus: "APPROVED" });
    await expectRefused(approved, "request-refuse-0001");
    db.projects.length = 0;
    db.planVersions.length = 0;

    const withPages = seedPlannedBook();
    db.pages.push({ id: "page-1", projectId: withPages, index: 1, chapterId: null, title: "p", markdown: "x", status: "COMPLETED", revision: 1 });
    await expectRefused(withPages, "request-refuse-0002");
    db.pages.length = 0;

    mockPrisma.generationJob.findMany.mockResolvedValue([openJobRow()]);
    await expectRefused(withPages, "request-refuse-0003");
    mockPrisma.generationJob.findMany.mockResolvedValue([]);

    expect((await fromPlan(app, withPages, "request-refuse-0004", "token-b")).statusCode).toBe(404);

    await fromPlan(app, withPages, "request-first-0001");
    await expectRefused(withPages, "request-refuse-0005");

    const { body } = await createStudioBook(app);
    await expectRefused(body.project.id, "request-refuse-0006");
    expect(db.planVersions[0]!.status).toBe("SUPERSEDED");
  });
});

describe("the converted book", () => {
  it("opens in the Studio with its chapters", async () => {
    const app = await buildMobileApp();
    const projectId = seedPlannedBook();
    await fromPlan(app, projectId);

    const manuscript = await app.inject({ method: "GET", url: `/api/mobile/projects/${projectId}/manuscript`, headers: AUTH });

    expect(manuscript.statusCode).toBe(200);
    expect(manuscript.json().manuscript.chapters).toHaveLength(2);
  });
});
