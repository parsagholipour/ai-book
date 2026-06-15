import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "./mobileAuth.js";
import { stopProjectGenerationJobs } from "./queue.js";

const mockPrisma = vi.hoisted(() => ({
  user: { upsert: vi.fn() },
  mobileSession: { findUnique: vi.fn() },
  project: { findFirst: vi.fn(), delete: vi.fn() },
  imageAsset: { findFirst: vi.fn() },
  moderationReport: { create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  accountDeletionRequest: { findFirst: vi.fn(), create: vi.fn() }
}));

vi.mock("@book-maker/db", () => ({
  Prisma: { JsonNull: null },
  prisma: mockPrisma
}));

vi.mock("./queue.js", () => ({
  stopProjectGenerationJobs: vi.fn()
}));

const originalEnv = { ...process.env };
let tempBookStorageDir: string | null = null;
let tempImageStorageDir: string | null = null;
let tempVoiceStorageDir: string | null = null;

describe("mobile safety routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    tempBookStorageDir = mkdtempSync(join(tmpdir(), "book-maker-safety-books-"));
    tempImageStorageDir = mkdtempSync(join(tmpdir(), "book-maker-safety-images-"));
    tempVoiceStorageDir = mkdtempSync(join(tmpdir(), "book-maker-safety-voice-"));
    process.env = {
      ...originalEnv,
      WEB_PASSWORD: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_TURN_TOKEN: "",
      BOOK_STORAGE_DIR: tempBookStorageDir,
      IMAGE_STORAGE_DIR: tempImageStorageDir,
      VOICE_STORAGE_DIR: tempVoiceStorageDir,
      PRIVACY_POLICY_URL: "https://example.com/privacy",
      TERMS_OF_SERVICE_URL: "https://example.com/terms",
      ACCOUNT_DELETION_URL: "https://example.com/delete-account",
      SUPPORT_EMAIL: "support@example.com"
    };
    mockPrisma.user.upsert.mockResolvedValue({ id: "local-admin" });
    mockPrisma.project.findFirst.mockResolvedValue(projectRecord());
    mockPrisma.project.delete.mockResolvedValue(projectRecord());
    mockPrisma.imageAsset.findFirst.mockResolvedValue(imageRecord());
    mockPrisma.moderationReport.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      moderationReportRecord(data)
    );
    mockPrisma.moderationReport.findMany.mockResolvedValue([moderationReportRecord()]);
    mockPrisma.moderationReport.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      moderationReportRecord({
        id: "report-1",
        status: data.status ?? "REVIEWED",
        reviewNotes: data.reviewNotes ?? null,
        reviewerUserId: data.reviewerUserId ?? "local-admin",
        reviewedAt: data.reviewedAt ?? new Date("2026-06-15T13:00:00.000Z")
      })
    );
    mockPrisma.accountDeletionRequest.findFirst.mockResolvedValue(null);
    mockPrisma.accountDeletionRequest.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      deletionRequestRecord(data)
    );
    vi.mocked(stopProjectGenerationJobs).mockResolvedValue({
      stoppedJobs: 1,
      activeJobs: 0,
      removedQueueJobs: 1
    } as Awaited<ReturnType<typeof stopProjectGenerationJobs>>);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    for (const dir of [tempBookStorageDir, tempImageStorageDir, tempVoiceStorageDir]) {
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    tempBookStorageDir = null;
    tempImageStorageDir = null;
    tempVoiceStorageDir = null;
  });

  it("stores reports for AI-generated books owned by the signed-in user", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/reports",
      headers: bearer("token-a"),
      payload: {
        reason: "deceptive_or_misleading",
        comment: "The generated advice cites numbers that look made up."
      }
    });
    const createCall = mockPrisma.moderationReport.create.mock.calls.at(0)?.[0] as { data: Record<string, unknown> };

    expect(response.statusCode).toBe(201);
    expect(createCall.data).toMatchObject({
      reporterUserId: "user-a",
      projectId: "project-1",
      targetType: "PROJECT",
      reason: "DECEPTIVE_OR_MISLEADING",
      comment: "The generated advice cites numbers that look made up."
    });
    expect(JSON.stringify(createCall.data)).not.toMatch(/provider|model|temperature|generationStrategy|purchaseToken/);
    expect(response.json().report).toMatchObject({
      id: "report-1",
      targetType: "project",
      reason: "deceptive_or_misleading",
      status: "pending"
    });
    await app.close();
  });

  it("stores reports for generated image assets owned by the signed-in user", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/assets/image-1/reports",
      headers: bearer("token-a"),
      payload: {
        reason: "privacy_or_copyright",
        comment: "The visual resembles a private logo."
      }
    });
    const createCall = mockPrisma.moderationReport.create.mock.calls.at(0)?.[0] as { data: Record<string, any> };

    expect(response.statusCode).toBe(201);
    expect(createCall.data).toMatchObject({
      reporterUserId: "user-a",
      projectId: "project-1",
      imageAssetId: "image-1",
      targetType: "IMAGE_ASSET",
      reason: "PRIVACY_OR_COPYRIGHT"
    });
    expect(createCall.data.targetSnapshot).toMatchObject({
      imageAssetId: "image-1",
      assetType: "DIAGRAM",
      contentType: "image/png"
    });
    expect(response.json().report.targetType).toBe("image_asset");
    await app.close();
  });

  it("creates an account deletion request for the signed-in user", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/account/deletion-request",
      headers: bearer("token-a"),
      payload: { reason: "I no longer need the app." }
    });
    const createCall = mockPrisma.accountDeletionRequest.create.mock.calls.at(0)?.[0] as { data: Record<string, any> };

    expect(response.statusCode).toBe(201);
    expect(createCall.data).toMatchObject({
      userId: "user-a",
      email: "user-a@example.com",
      reason: "I no longer need the app.",
      metadata: expect.objectContaining({
        source: "mobile_app",
        supportEmail: "support@example.com",
        accountDeletionUrl: "https://example.com/delete-account"
      })
    });
    expect(response.json().request).toMatchObject({
      id: "delete-request-1",
      status: "pending",
      email: "user-a@example.com"
    });
    await app.close();
  });

  it("deletes a signed-in user's project and generated storage", async () => {
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
    mockPrisma.project.findFirst.mockImplementation(async ({ where }: { where: { id?: string; userId?: string } }) =>
      where.id === "project-1" && where.userId === "user-a" ? projectRecord() : null
    );
    const app = await buildApp();

    const ownDelete = await app.inject({
      method: "DELETE",
      url: "/api/mobile/projects/project-1",
      headers: bearer("token-a")
    });
    const otherDelete = await app.inject({
      method: "DELETE",
      url: "/api/mobile/projects/project-1",
      headers: bearer("token-b")
    });

    expect(ownDelete.statusCode).toBe(200);
    expect(ownDelete.json()).toMatchObject({
      ok: true,
      deletedProjectId: "project-1",
      assetCleanup: { book: true, images: true, voice: true }
    });
    expect(vi.mocked(stopProjectGenerationJobs)).toHaveBeenCalledWith("project-1");
    expect(mockPrisma.project.delete).toHaveBeenCalledWith({ where: { id: "project-1" } });
    expect(otherDelete.statusCode).toBe(404);
    await app.close();
  });

  it("lists and reviews moderation reports through the local admin path", async () => {
    const app = await buildApp();

    const list = await app.inject({ method: "GET", url: "/api/admin/moderation/reports" });
    const review = await app.inject({
      method: "PATCH",
      url: "/api/admin/moderation/reports/report-1",
      payload: { status: "actioned", reviewNotes: "Removed generated visual from support queue." }
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().reports).toEqual([
      expect.objectContaining({
        id: "report-1",
        status: "pending"
      })
    ]);
    expect(review.statusCode).toBe(200);
    expect(mockPrisma.moderationReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "report-1" },
        data: expect.objectContaining({
          status: "ACTIONED",
          reviewNotes: "Removed generated visual from support queue.",
          reviewerUserId: "local-admin",
          reviewedAt: expect.any(Date)
        })
      })
    );
    await app.close();
  });

  it("rate limits repeated content reports", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const app = await buildApp({ reportRateLimit: { maxAttempts: 1, windowMs: 60_000 } });

    const first = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/reports",
      headers: bearer("token-a"),
      payload: { reason: "other" }
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/reports",
      headers: bearer("token-a"),
      payload: { reason: "other" }
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("RATE_LIMITED");
    expect(mockPrisma.moderationReport.create).toHaveBeenCalledOnce();
    await app.close();
  });
});

async function buildApp(options: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const app = Fastify();
  const { mobileSafetyRoutes } = await import("./mobileSafety.js");
  await app.register(mobileSafetyRoutes, options);
  return app;
}

function mockAccessTokens(tokensByRawToken: Record<string, string>) {
  mockPrisma.mobileSession.findUnique.mockImplementation(async ({ where }: { where: { accessTokenHash?: string } }) => {
    const userEntry = Object.entries(tokensByRawToken).find(([token]) => hashToken(token) === where.accessTokenHash);
    if (!userEntry) {
      return null;
    }
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

function projectRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    userId: "user-a",
    title: "Owned Book",
    status: "COMPLETE",
    category: "BUSINESS",
    subcategory: "Lead Magnet Ebook",
    createdAt: new Date("2026-06-01T12:00:00.000Z"),
    updatedAt: new Date("2026-06-15T12:00:00.000Z"),
    _count: { pages: 3, images: 2 },
    ...overrides
  };
}

function imageRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "image-1",
    projectId: "project-1",
    pageId: "page-1",
    type: "DIAGRAM",
    path: "http://localhost:4001/assets/images/project-1/page-1.png",
    metadata: { mimeType: "image/png", provider: "hidden", model: "hidden" },
    project: {
      title: "Owned Book",
      status: "COMPLETE",
      category: "BUSINESS"
    },
    ...overrides
  };
}

function moderationReportRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-15T12:30:00.000Z");
  return {
    id: "report-1",
    reporterUserId: "user-a",
    reporter: { email: "user-a@example.com", displayName: "user-a" },
    projectId: "project-1",
    project: { title: "Owned Book" },
    imageAssetId: null,
    imageAsset: null,
    targetType: "PROJECT",
    reason: "OTHER",
    comment: null,
    status: "PENDING",
    targetSnapshot: {
      projectId: "project-1",
      title: "Owned Book"
    },
    reviewerUserId: null,
    reviewedAt: null,
    reviewNotes: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function deletionRequestRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "delete-request-1",
    userId: "user-a",
    email: "user-a@example.com",
    status: "PENDING",
    reason: null,
    requestedAt: new Date("2026-06-15T12:30:00.000Z"),
    completedAt: null,
    ...overrides
  };
}
