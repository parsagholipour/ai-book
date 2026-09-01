import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "../auth.js";
import { adminProjectExportRoutes } from "./adminProjectExports.js";

const mockDb = vi.hoisted(() => ({
  prisma: {
    user: { upsert: vi.fn() },
    mobileSession: { findUnique: vi.fn() },
    project: { findUnique: vi.fn() }
  }
}));

vi.mock("@book-maker/db", () => ({
  prisma: mockDb.prisma,
  Prisma: { raw: (sql: string) => sql }
}));

const mockExports = vi.hoisted(() => ({
  sendProjectPdfExport: vi.fn(),
  sendProjectEpubExport: vi.fn()
}));

vi.mock("./projectExports.js", () => mockExports);

const originalEnv = { ...process.env };
let app: FastifyInstance;

async function buildApp(webPassword = ""): Promise<FastifyInstance> {
  process.env = { ...originalEnv, WEB_PASSWORD: webPassword, OPENAI_API_KEY: "", GEMINI_API_KEY: "" };
  const instance = Fastify();
  await registerAuth(instance, { WEB_PASSWORD: webPassword } as never);
  await instance.register(adminProjectExportRoutes);
  await instance.ready();
  return instance;
}

const completeProject = {
  title: "A Finished Book",
  language: "en",
  status: "COMPLETE",
  currentPlanId: "plan-1",
  mediaSettings: { illustrated: true },
  contentRevision: 4
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prisma.user.upsert.mockResolvedValue({ id: "local-admin" });
  mockDb.prisma.mobileSession.findUnique.mockResolvedValue(null);
  mockDb.prisma.project.findUnique.mockResolvedValue(null);
  mockExports.sendProjectPdfExport.mockImplementation(async (options: { reply: { send: (body: unknown) => unknown } }) =>
    options.reply.send("pdf-bytes")
  );
  mockExports.sendProjectEpubExport.mockImplementation(async (options: { reply: { send: (body: unknown) => unknown } }) =>
    options.reply.send("epub-bytes")
  );
});

afterEach(async () => {
  await app?.close();
  process.env = { ...originalEnv };
});

describe("GET /api/admin/projects/:id/export/pdf", () => {
  it("serves any user's completed book without an ownership scope", async () => {
    mockDb.prisma.project.findUnique.mockResolvedValue(completeProject);
    app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/admin/projects/book-1/export/pdf" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("pdf-bytes");
    expect(mockDb.prisma.project.findUnique).toHaveBeenCalledWith({
      where: { id: "book-1" },
      select: {
        title: true,
        language: true,
        status: true,
        currentPlanId: true,
        mediaSettings: true,
        contentRevision: true
      }
    });
    expect(mockExports.sendProjectPdfExport).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "book-1", project: completeProject })
    );
  });

  it("returns 404 when the project does not exist", async () => {
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/admin/projects/missing/export/pdf" });
    expect(response.statusCode).toBe(404);
    expect(mockExports.sendProjectPdfExport).not.toHaveBeenCalled();
  });

  it("requires the operator cookie when a password is set", async () => {
    app = await buildApp("hunter2");
    expect((await app.inject({ method: "GET", url: "/api/admin/projects/book-1/export/pdf" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/projects/book-1/export/epub" })).statusCode).toBe(401);
    expect(mockDb.prisma.project.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/projects/:id/export/epub", () => {
  it("sends the epub with the fields its compile needs", async () => {
    mockDb.prisma.project.findUnique.mockResolvedValue({ ...completeProject, authorName: "Tomeza" });
    app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/admin/projects/book-1/export/epub" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("epub-bytes");
    expect(mockDb.prisma.project.findUnique).toHaveBeenCalledWith({
      where: { id: "book-1" },
      select: {
        title: true,
        authorName: true,
        language: true,
        status: true,
        currentPlanId: true,
        contentRevision: true
      }
    });
    expect(mockExports.sendProjectEpubExport).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "book-1", project: { ...completeProject, authorName: "Tomeza" } })
    );
  });
});
