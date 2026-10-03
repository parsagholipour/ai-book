import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminAppUpdateRoutes } from "./adminAppUpdates.js";

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  appUpdatePolicyRevision: {
    findFirst: vi.fn(),
    create: vi.fn()
  }
}));

const mockRequireOperatorActor = vi.hoisted(() => vi.fn());

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));
vi.mock("../requestAuth.js", () => ({
  requireOperatorActor: mockRequireOperatorActor,
  pathFromRequestUrl: (url: string) => new URL(url, "http://localhost").pathname
}));

async function adminApp() {
  const app = Fastify({ logger: false });
  await app.register(adminAppUpdateRoutes);
  return app;
}

const release = { platform: "android", build: 4, version: "1.1.0", policy: "required", message: "Fixes purchases" };

describe("admin app updates", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireOperatorActor.mockResolvedValue({ kind: "operator", userId: "local-admin" });
    mockPrisma.$transaction.mockImplementation(
      async (operation: (tx: typeof mockPrisma) => Promise<unknown>) => operation(mockPrisma)
    );
    mockPrisma.appUpdatePolicyRevision.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "app-update-1",
        createdAt: new Date("2026-10-03T09:00:00.000Z"),
        ...data
      })
    );
  });

  it("reads an empty list as version 0 before anything is saved", async () => {
    mockPrisma.appUpdatePolicyRevision.findFirst.mockResolvedValue(null);
    const app = await adminApp();

    const response = await app.inject({ method: "GET", url: "/api/admin/app-updates" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: 0, releases: [], note: null, updatedBy: null, updatedAt: null });
    await app.close();
  });

  it("writes the next append-only revision, newest build first", async () => {
    mockPrisma.appUpdatePolicyRevision.findFirst.mockResolvedValue({ version: 2 });
    const app = await adminApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/app-updates",
      payload: {
        baseVersion: 2,
        releases: [{ ...release, build: 3, policy: "silent", message: undefined }, release],
        note: "1.1.0 fixes purchases"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 3,
      note: "1.1.0 fixes purchases",
      releases: [release, { platform: "android", build: 3, version: "1.1.0", policy: "silent" }]
    });
    expect(mockPrisma.appUpdatePolicyRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 3, updatedBy: "operator-console" })
    });
    await app.close();
  });

  it("refuses a save edited from a version that is no longer the head", async () => {
    mockPrisma.appUpdatePolicyRevision.findFirst.mockResolvedValue({ version: 5 });
    const app = await adminApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/app-updates",
      payload: { baseVersion: 4, releases: [release] }
    });

    expect(response.statusCode).toBe(409);
    expect(mockPrisma.appUpdatePolicyRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a list naming one build twice, with the reason", async () => {
    const app = await adminApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/app-updates",
      payload: { baseVersion: 0, releases: [release, { ...release, policy: "prompt" }] }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "android build 4 is listed twice." });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it("is refused to anyone but the operator", async () => {
    mockRequireOperatorActor.mockImplementation(async (_request, reply) => {
      reply.code(403).send({ error: "Operator access required" });
      return null;
    });
    const app = await adminApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/app-updates",
      payload: { baseVersion: 0, releases: [release] }
    });

    expect(response.statusCode).toBe(403);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    await app.close();
  });
});
