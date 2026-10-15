import { seedObject } from "./testing/objectStorage.js";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "./mobileAuth.js";

/**
 * The four AI surfaces `aiOutputReports.ts` made reportable — the creation
 * chat, the plan card, a drawn saved-character picture and a Writing Studio
 * suggestion — plus the operator picture route. Every one is the owner's only
 * (someone else's row is a 404), on the shared report limiter, and snapshots
 * what the reader was shown.
 */

const mockPrisma = vi.hoisted(() => ({
  user: { upsert: vi.fn() },
  mobileSession: { findUnique: vi.fn() },
  project: { findFirst: vi.fn(), delete: vi.fn() },
  imageAsset: { findFirst: vi.fn() },
  mobileCreationDraft: { findFirst: vi.fn() },
  planVersion: { findFirst: vi.fn() },
  libraryCharacterImage: { findFirst: vi.fn() },
  manuscriptAssist: { findFirst: vi.fn() },
  moderationReport: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  accountDeletionRequest: { findFirst: vi.fn(), create: vi.fn() },
  legalAcceptance: { create: vi.fn() }
}));

vi.mock("@book-maker/db", () => ({
  Prisma: { JsonNull: null },
  prisma: mockPrisma
}));

vi.mock("./queue.js", () => ({
  stopProjectGenerationJobs: vi.fn()
}));

const originalEnv = { ...process.env };

type Where = Record<string, unknown> & { project?: { userId?: string }; character?: { userId?: string } };

describe("AI output report routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, WEB_PASSWORD: "" };
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
    mockPrisma.user.upsert.mockResolvedValue({ id: "local-admin" });
    mockPrisma.mobileCreationDraft.findFirst.mockImplementation(async ({ where }: { where: Where }) =>
      where.id === "draft-1" && where.userId === "user-a" ? draftRecord() : null
    );
    mockPrisma.planVersion.findFirst.mockImplementation(async ({ where }: { where: Where }) =>
      where.id === "plan-1" && where.projectId === "project-1" && where.project?.userId === "user-a" ? planRecord() : null
    );
    mockPrisma.libraryCharacterImage.findFirst.mockImplementation(async ({ where }: { where: Where }) =>
      where.characterId === "character-1" && where.userId === "user-a" && where.character?.userId === "user-a"
        ? characterImageRecord({ id: where.id })
        : null
    );
    mockPrisma.manuscriptAssist.findFirst.mockImplementation(async ({ where }: { where: Where }) =>
      where.id === "assist-1" && where.projectId === "project-1" && where.project?.userId === "user-a" ? assistRecord() : null
    );
    mockPrisma.project.findFirst.mockImplementation(async ({ where }: { where: Where }) =>
      where.id === "project-1" && where.userId === "user-a" ? { id: "project-1", title: "Owned Book" } : null
    );
    mockPrisma.moderationReport.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      reportRecord(data)
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("creation chat replies", () => {
    it("snapshots the reply, what it answered and the question it showed", async () => {
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/creation-sessions/draft-1/messages/assistant-1/reports",
        headers: bearer("token-a"),
        payload: { reason: "offensive", comment: "  The reply   mocked my idea. " }
      });

      expect(response.statusCode).toBe(201);
      const data = createdReport();
      expect(data).toMatchObject({
        reporterUserId: "user-a",
        projectId: null,
        targetType: "CREATION_CHAT_MESSAGE",
        reason: "OFFENSIVE",
        comment: "The reply mocked my idea."
      });
      expect(data.targetSnapshot).toEqual({
        draftId: "draft-1",
        chatTitle: "A picture book about a brave otter",
        createdProjectId: null,
        chatMessageId: "assistant-1",
        reply: "Lovely. Who is the otter's best friend?",
        asked: "A picture book about a brave otter",
        question: { prompt: "Who is the best friend?", options: ["A heron", "A beaver"] },
        quickReplies: ["Surprise me"],
        researchSources: [{ title: "Otters", url: "https://example.org/otters" }]
      });
      expect(response.json().report).toMatchObject({ targetType: "creation_chat_message", status: "pending" });
      await app.close();
    });

    it("answers 404 for another reader's chat and for the reader's own message", async () => {
      const app = await buildApp();

      const otherUsers = await app.inject({
        method: "POST",
        url: "/api/mobile/creation-sessions/draft-1/messages/assistant-1/reports",
        headers: bearer("token-b"),
        payload: { reason: "other" }
      });
      const ownMessage = await app.inject({
        method: "POST",
        url: "/api/mobile/creation-sessions/draft-1/messages/user-1/reports",
        headers: bearer("token-a"),
        payload: { reason: "other" }
      });

      expect(otherUsers.statusCode).toBe(404);
      expect(otherUsers.json().error.code).toBe("CHAT_MESSAGE_NOT_FOUND");
      expect(ownMessage.statusCode).toBe(404);
      expect(mockPrisma.moderationReport.create).not.toHaveBeenCalled();
      await app.close();
    });

    it("finds a legacy message by the position id the session GET handed out", async () => {
      mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(
        draftRecord({
          messages: [
            { role: "user", content: "A cookbook for camping" },
            { role: "assistant", content: "How many people are you cooking for?" }
          ]
        })
      );
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/creation-sessions/draft-1/messages/legacy-1/reports",
        headers: bearer("token-a"),
        payload: { reason: "other" }
      });

      expect(response.statusCode).toBe(201);
      expect(createdReport().targetSnapshot).toMatchObject({
        chatMessageId: "legacy-1",
        reply: "How many people are you cooking for?",
        asked: "A cookbook for camping"
      });
      await app.close();
    });

    it("needs a reason and is rate limited with the other reports", async () => {
      const app = await buildApp({ reportRateLimit: { maxAttempts: 1, windowMs: 60_000 } });
      const url = "/api/mobile/creation-sessions/draft-1/messages/assistant-1/reports";

      const missingReason = await app.inject({ method: "POST", url, headers: bearer("token-a"), payload: {} });
      const second = await app.inject({ method: "POST", url, headers: bearer("token-a"), payload: { reason: "other" } });

      expect(missingReason.statusCode).toBe(400);
      expect(missingReason.json().error.code).toBe("VALIDATION_ERROR");
      expect(second.statusCode).toBe(429);
      expect(second.json().error.code).toBe("RATE_LIMITED");
      await app.close();
    });

    it("refuses an unsigned request", async () => {
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/creation-sessions/draft-1/messages/assistant-1/reports",
        payload: { reason: "other" }
      });

      expect(response.statusCode).toBe(401);
      expect(mockPrisma.mobileCreationDraft.findFirst).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("book plans", () => {
    it("snapshots the plan as its card showed it, and nothing internal", async () => {
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/plans/plan-1/reports",
        headers: bearer("token-a"),
        payload: { reason: "deceptive_or_misleading" }
      });

      expect(response.statusCode).toBe(201);
      const data = createdReport();
      expect(data).toMatchObject({ projectId: "project-1", targetType: "BOOK_PLAN", reason: "DECEPTIVE_OR_MISLEADING" });
      expect(data.targetSnapshot).toEqual({
        projectId: "project-1",
        projectTitle: "Owned Book",
        planId: "plan-1",
        version: 2,
        status: "draft",
        title: "The Brave Otter",
        subtitle: null,
        premise: "An otter learns to swim upstream.",
        audience: "Ages 4-7",
        chapters: [{ index: 1, title: "The River", summary: "Otter meets the current." }],
        questions: [{ prompt: "Should it rhyme?", options: ["Yes", "No"] }]
      });
      expect(JSON.stringify(data.targetSnapshot)).not.toMatch(/voiceGuide|antiAiRules|illustrationPlan|provider|model/);
      await app.close();
    });

    it("answers 404 for another reader's plan", async () => {
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/plans/plan-1/reports",
        headers: bearer("token-b"),
        payload: { reason: "other" }
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("PLAN_NOT_FOUND");
      await app.close();
    });

    it("refuses the plan of an author's own book", async () => {
      mockPrisma.planVersion.findFirst.mockResolvedValue(
        planRecord({ project: { title: "My Memoir", mediaSettings: { mobile: { import: { format: "docx" } } } } })
      );
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/plans/plan-1/reports",
        headers: bearer("token-a"),
        payload: { reason: "other" }
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("NOT_AI_GENERATED");
      expect(mockPrisma.moderationReport.create).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("saved-character pictures", () => {
    it("snapshots a drawn picture with what the operator needs to find it", async () => {
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/characters/character-1/images/image-1/reports",
        headers: bearer("token-a"),
        payload: { reason: "child_safety" }
      });

      expect(response.statusCode).toBe(201);
      const data = createdReport();
      expect(data).toMatchObject({ projectId: null, targetType: "CHARACTER_IMAGE", reason: "CHILD_SAFETY" });
      expect(data.targetSnapshot).toEqual({
        characterId: "character-1",
        characterName: "Mira",
        description: "A curious girl who loves maps.",
        appearance: "Short black hair, yellow raincoat.",
        imageId: "image-1",
        ownerUserId: "user-a",
        fileName: "portrait-image-1.png",
        contentType: "image/png",
        source: "generated",
        drawnAt: "2026-10-01T10:00:00.000Z",
        rewrittenPrompt: "A girl in a yellow raincoat"
      });
      expect(JSON.stringify(data.targetSnapshot)).not.toMatch(/refusalReason|provider/);
      await app.close();
    });

    it("refuses an upload, which is the reader's own picture", async () => {
      mockPrisma.libraryCharacterImage.findFirst.mockResolvedValue(characterImageRecord({ source: "UPLOAD" }));
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/characters/character-1/images/image-1/reports",
        headers: bearer("token-a"),
        payload: { reason: "other" }
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("NOT_AI_GENERATED");
      expect(mockPrisma.moderationReport.create).not.toHaveBeenCalled();
      await app.close();
    });

    it("answers 404 for another reader's picture", async () => {
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/characters/character-1/images/image-1/reports",
        headers: bearer("token-b"),
        payload: { reason: "other" }
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("CHARACTER_IMAGE_NOT_FOUND");
      await app.close();
    });
  });

  describe("Writing Studio suggestions", () => {
    it("snapshots a stored draft suggestion and what it was asked for", async () => {
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/manuscript/assists/assist-1/reports",
        headers: bearer("token-a"),
        payload: { reason: "violence_or_self_harm" }
      });

      expect(response.statusCode).toBe(201);
      const data = createdReport();
      expect(data).toMatchObject({ projectId: "project-1", targetType: "STUDIO_SUGGESTION" });
      expect(data.targetSnapshot).toEqual({
        origin: "stored",
        projectId: "project-1",
        projectTitle: "Owned Book",
        assistId: "assist-1",
        assistKind: "draft_chapter",
        status: "applied",
        chapterId: "chapter-1",
        request: { notes: "The storm reaches the harbour." },
        suggestion: { type: "text", text: "The storm came in at dusk." }
      });
      await app.close();
    });

    it("names a reported picture's file, so the Studio sweep keeps it as evidence", async () => {
      mockPrisma.manuscriptAssist.findFirst.mockResolvedValue(
        assistRecord({
          kind: "ILLUSTRATE",
          input: { prompt: "Luna on the pier" },
          result: {
            type: "image",
            url: "/assets/images/project-1/studio-image-assist-1.webp",
            alt: "Luna on the pier at dusk.",
            provenance: { provider: "hidden" }
          }
        })
      );
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/manuscript/assists/assist-1/reports",
        headers: bearer("token-a"),
        payload: { reason: "other" }
      });

      expect(response.statusCode).toBe(201);
      const snapshot = createdReport().targetSnapshot as Record<string, unknown>;
      expect(snapshot).toMatchObject({
        assistKind: "illustrate",
        filename: "studio-image-assist-1.webp",
        request: { prompt: "Luna on the pier" },
        suggestion: {
          type: "image",
          url: "/assets/images/project-1/studio-image-assist-1.webp",
          filename: "studio-image-assist-1.webp",
          alt: "Luna on the pier at dusk."
        }
      });
      expect(JSON.stringify(snapshot)).not.toMatch(/provenance|provider/);
      await app.close();
    });

    it("answers 404 for another reader's suggestion and 409 for one with nothing to show", async () => {
      const app = await buildApp();

      const otherUsers = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/manuscript/assists/assist-1/reports",
        headers: bearer("token-b"),
        payload: { reason: "other" }
      });
      mockPrisma.manuscriptAssist.findFirst.mockResolvedValue(assistRecord({ status: "RUNNING", result: null }));
      const unfinished = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/manuscript/assists/assist-1/reports",
        headers: bearer("token-a"),
        payload: { reason: "other" }
      });

      expect(otherUsers.statusCode).toBe(404);
      expect(otherUsers.json().error.code).toBe("ASSIST_NOT_FOUND");
      expect(unfinished.statusCode).toBe(409);
      expect(unfinished.json().error.code).toBe("ASSIST_NOT_READY");
      expect(mockPrisma.moderationReport.create).not.toHaveBeenCalled();
      await app.close();
    });

    it("only looks up the assist kinds a Studio card can show", async () => {
      const app = await buildApp();

      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/manuscript/assists/assist-1/reports",
        headers: bearer("token-a"),
        payload: { reason: "other" }
      });

      const where = mockPrisma.manuscriptAssist.findFirst.mock.calls.at(0)?.[0].where as { kind: { in: string[] } };
      expect(where.kind.in).not.toContain("STYLE_PROFILE");
      expect(where.kind.in).not.toContain("REEMBED");
      await app.close();
    });

    it("keeps a quick suggestion the app sends, and says it came from the app", async () => {
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/manuscript/assist/reports",
        headers: bearer("token-a"),
        payload: {
          reason: "hate_or_harassment",
          comment: "Rude rewrite",
          assistKind: "rewrite",
          chapterId: "chapter-1",
          selection: "She walked home.",
          instruction: "Make it vivid",
          suggestion: "She stomped home, furious."
        }
      });

      expect(response.statusCode).toBe(201);
      const data = createdReport();
      expect(data).toMatchObject({
        reporterUserId: "user-a",
        projectId: "project-1",
        targetType: "STUDIO_SUGGESTION",
        reason: "HATE_OR_HARASSMENT",
        comment: "Rude rewrite"
      });
      expect(data.targetSnapshot).toEqual({
        origin: "app",
        projectId: "project-1",
        projectTitle: "Owned Book",
        assistId: null,
        assistKind: "rewrite",
        status: null,
        chapterId: "chapter-1",
        request: { instruction: "Make it vivid", selection: "She walked home." },
        suggestion: { type: "text", text: "She stomped home, furious." }
      });
      await app.close();
    });

    it("answers 404 for another reader's book and 400 for a report with no suggestion", async () => {
      const app = await buildApp();

      const otherUsers = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/manuscript/assist/reports",
        headers: bearer("token-b"),
        payload: { reason: "other", assistKind: "ask", suggestion: "An answer." }
      });
      const empty = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/manuscript/assist/reports",
        headers: bearer("token-a"),
        payload: { reason: "other", assistKind: "ask", suggestion: "   " }
      });

      expect(otherUsers.statusCode).toBe(404);
      expect(empty.statusCode).toBe(400);
      expect(empty.json().error).toEqual({ code: "VALIDATION_ERROR", message: "That report could not be read." });
      expect(mockPrisma.moderationReport.create).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("the operator's picture route", () => {
    it("serves a reported character picture from the owner's prefix the snapshot names", async () => {
      seedObject("images/characters/user-a/portrait-image-1.png", "png-bytes");
      mockPrisma.moderationReport.findUnique.mockResolvedValue({
        targetType: "CHARACTER_IMAGE",
        projectId: null,
        targetSnapshot: { ownerUserId: "user-a", fileName: "portrait-image-1.png" }
      });
      const app = await buildApp({}, { authHook: true });

      const response = await app.inject({ method: "GET", url: "/api/admin/moderation/reports/report-1/picture" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.body).toBe("png-bytes");
      await app.close();
    });

    it("serves a reported Studio picture from its book, and nothing for a report without one", async () => {
      seedObject("images/project-1/studio-image-assist-1.webp", "webp-bytes");
      mockPrisma.moderationReport.findUnique
        .mockResolvedValueOnce({
          targetType: "STUDIO_SUGGESTION",
          projectId: "project-1",
          targetSnapshot: { filename: "studio-image-assist-1.webp" }
        })
        .mockResolvedValueOnce({ targetType: "CREATION_CHAT_MESSAGE", projectId: null, targetSnapshot: { reply: "Hi" } })
        .mockResolvedValueOnce({
          targetType: "STUDIO_SUGGESTION",
          projectId: "project-1",
          targetSnapshot: { filename: "../project-2/cover.png" }
        });
      const app = await buildApp({}, { authHook: true });

      const studio = await app.inject({ method: "GET", url: "/api/admin/moderation/reports/report-1/picture" });
      const chat = await app.inject({ method: "GET", url: "/api/admin/moderation/reports/report-2/picture" });
      const traversal = await app.inject({ method: "GET", url: "/api/admin/moderation/reports/report-3/picture" });

      expect(studio.statusCode).toBe(200);
      expect(studio.body).toBe("webp-bytes");
      expect(chat.statusCode).toBe(404);
      expect(traversal.statusCode).toBe(404);
      await app.close();
    });

    it("refuses a mobile bearer", async () => {
      const app = await buildApp({}, { authHook: true });

      const response = await app.inject({
        method: "GET",
        url: "/api/admin/moderation/reports/report-1/picture",
        headers: bearer("token-a")
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(401);
      expect(response.statusCode).toBeLessThan(404);
      expect(mockPrisma.moderationReport.findUnique).not.toHaveBeenCalled();
      await app.close();
    });
  });
});

async function buildApp(options: Record<string, unknown> = {}, { authHook = false } = {}): Promise<FastifyInstance> {
  const app = Fastify();
  if (authHook) {
    const { registerAuth } = await import("./auth.js");
    await registerAuth(app, { WEB_PASSWORD: "" } as never);
  }
  const { mobileSafetyRoutes } = await import("./mobileSafety.js");
  await app.register(mobileSafetyRoutes, options);
  return app;
}

function createdReport(): Record<string, unknown> {
  const call = mockPrisma.moderationReport.create.mock.calls.at(0)?.[0] as { data: Record<string, unknown> } | undefined;
  if (!call) throw new Error("No report was created.");
  return call.data;
}

function mockAccessTokens(tokensByRawToken: Record<string, string>) {
  mockPrisma.mobileSession.findUnique.mockImplementation(async ({ where }: { where: { accessTokenHash?: string } }) => {
    const userEntry = Object.entries(tokensByRawToken).find(([token]) => hashToken(token) === where.accessTokenHash);
    if (!userEntry) return null;
    const [, userId] = userEntry;
    return {
      id: `session-${userId}`,
      userId,
      accessTokenExpiresAt: new Date("2999-06-15T08:15:00.000Z"),
      refreshTokenExpiresAt: new Date("2999-07-15T08:00:00.000Z"),
      revokedAt: null,
      user: {
        id: userId,
        email: `${userId}@example.com`,
        displayName: userId,
        status: "ACTIVE",
        disabledAt: null,
        createdAt: new Date("2026-06-01T12:00:00.000Z"),
        updatedAt: new Date("2026-06-01T12:00:00.000Z")
      }
    };
  });
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function draftRecord(overrides: { messages?: unknown[] } = {}) {
  return {
    id: "draft-1",
    createdProjectId: null,
    payload: {
      payloadVersion: 3,
      rawIdea: "",
      optionalDetails: { mustInclude: "", tone: "" },
      messages: overrides.messages ?? [
        { id: "user-1", parentId: null, isActiveChild: true, role: "user", content: "A picture book about a brave otter" },
        {
          id: "assistant-1",
          parentId: "user-1",
          isActiveChild: true,
          role: "assistant",
          content: "Lovely. Who is the otter's best friend?",
          research: {
            query: "otters",
            summary: "Otters are playful.",
            sources: [{ title: "Otters", url: "https://example.org/otters", summary: "About otters." }]
          },
          turnUi: {
            quickReplies: ["Surprise me"],
            question: { prompt: "Who is the best friend?", answerKind: "choice", options: ["A heron", "A beaver"] }
          }
        }
      ]
    }
  };
}

function planRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-1",
    projectId: "project-1",
    version: 2,
    status: "DRAFT",
    planningPackage: {
      title: "The Brave Otter",
      premise: "An otter learns to swim upstream.",
      audience: "Ages 4-7",
      voiceGuide: ["internal"],
      antiAiRules: ["internal"],
      illustrationPlan: { globalStyle: "internal" },
      questions: [{ prompt: "Should it rhyme?", options: ["Yes", "No"], answerKind: "choice" }],
      chapters: [{ index: 1, title: "The River", summary: "Otter meets the current.", targetPages: 4, beats: ["x"] }]
    },
    project: { title: "Owned Book", mediaSettings: {} },
    ...overrides
  };
}

function characterImageRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "image-1",
    source: "GENERATED",
    fileName: "portrait-image-1.png",
    metadata: {
      copyrightRewrite: { refusalReason: "IP filter", replaced: ["Elsa"], prompt: "A girl in a yellow raincoat" }
    },
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    character: {
      id: "character-1",
      name: "Mira",
      description: "A curious girl who loves maps.",
      appearance: "Short black hair, yellow raincoat."
    },
    ...overrides
  };
}

function assistRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "assist-1",
    projectId: "project-1",
    kind: "DRAFT_CHAPTER",
    status: "APPLIED",
    chapterId: "chapter-1",
    input: { notes: "The storm reaches the harbour.", targetWords: 800 },
    result: { type: "draft", markdown: "The storm came in at dusk." },
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    project: { title: "Owned Book" },
    ...overrides
  };
}

function reportRecord(data: Record<string, unknown>) {
  const now = new Date("2026-10-12T12:00:00.000Z");
  return {
    id: "report-1",
    reporterUserId: data.reporterUserId ?? null,
    projectId: data.projectId ?? null,
    imageAssetId: null,
    bookShareId: null,
    targetType: data.targetType,
    reason: data.reason,
    comment: data.comment ?? null,
    status: "PENDING",
    targetSnapshot: data.targetSnapshot,
    reviewerUserId: null,
    reviewedAt: null,
    reviewNotes: null,
    createdAt: now,
    updatedAt: now
  };
}
