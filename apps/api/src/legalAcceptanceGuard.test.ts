import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "./auth.js";
import { hashToken } from "./mobileAuth.js";

const mockPrisma = vi.hoisted(() => ({
  user: { upsert: vi.fn() },
  mobileSession: { findUnique: vi.fn() },
  legalAcceptance: { findFirst: vi.fn() }
}));

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));

describe("current legal acceptance guard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.mobileSession.findUnique.mockResolvedValue({
      id: "session-1",
      userId: "user-1",
      accessTokenExpiresAt: new Date("2999-01-01T00:00:00.000Z"),
      refreshTokenExpiresAt: new Date("2999-02-01T00:00:00.000Z"),
      revokedAt: null,
      user: {
        id: "user-1",
        email: "reader@example.com",
        displayName: null,
        status: "ACTIVE",
        disabledAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z")
      }
    });
  });

  it("blocks content mutations but preserves reads and deletion paths", async () => {
    mockPrisma.legalAcceptance.findFirst.mockResolvedValue(null);
    const app = Fastify();
    await registerAuth(app, { WEB_PASSWORD: "operator-password" } as never);
    app.get("/api/mobile/projects", async () => ({ ok: true }));
    app.post("/api/mobile/projects", async () => ({ ok: true }));
    app.delete("/api/mobile/projects/project-1", async () => ({ ok: true }));
    app.post("/api/mobile/account/deletion-request", async () => ({ ok: true }));

    const headers = { authorization: "Bearer access-token" };
    const read = await app.inject({ method: "GET", url: "/api/mobile/projects", headers });
    const mutate = await app.inject({ method: "POST", url: "/api/mobile/projects", headers });
    const deleteProject = await app.inject({
      method: "DELETE",
      url: "/api/mobile/projects/project-1",
      headers
    });
    const deleteAccount = await app.inject({
      method: "POST",
      url: "/api/mobile/account/deletion-request",
      headers
    });

    expect(read.statusCode).toBe(200);
    expect(mutate.statusCode).toBe(428);
    expect(mutate.json().error.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
    expect(deleteProject.statusCode).toBe(200);
    expect(deleteAccount.statusCode).toBe(200);
    expect(mockPrisma.mobileSession.findUnique).toHaveBeenCalledWith({
      where: { accessTokenHash: hashToken("access-token") },
      include: { user: true }
    });
    await app.close();
  });

  it("allows content mutations after current-version acceptance", async () => {
    mockPrisma.legalAcceptance.findFirst.mockResolvedValue({ id: "acceptance-1" });
    const app = Fastify();
    await registerAuth(app, { WEB_PASSWORD: "operator-password" } as never);
    app.post("/api/mobile/projects", async () => ({ ok: true }));

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects",
      headers: { authorization: "Bearer access-token" }
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
