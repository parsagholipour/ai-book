import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "./auth.js";
import { requireOperatorActor } from "./requestAuth.js";

/**
 * A mobile bearer token authenticates `/api/mobile/*` and the `/assets/*` URLs
 * the app is handed, and nothing else.
 *
 * The legacy operator API is the same books behind cheaper rules — it charges no
 * credits, claims no free-tier image slot, and renders exports inline — so a
 * bearer accepted there is a bypass even though every handler scopes to the
 * caller's own `userId`.
 */

const mockPrisma = vi.hoisted(() => ({
  user: { upsert: vi.fn() },
  mobileSession: { findUnique: vi.fn() },
  legalAcceptance: { findFirst: vi.fn() }
}));

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));

const OPERATOR_ONLY_PATHS = [
  "/api/projects",
  "/api/projects/project-1/export/pdf",
  "/api/projects/project-1/export/epub",
  "/api/projects/project-1/book",
  "/api/plans/plan-1/approve",
  "/api/templates",
  "/api/admin/users/user-1",
  "/api/runtime"
];

const MOBILE_BEARER_PATHS = ["/api/mobile/projects", "/assets/images/project-1/cover.png"];

describe("operator surface guard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.user.upsert.mockResolvedValue({ id: "local-admin" });
    mockPrisma.legalAcceptance.findFirst.mockResolvedValue({ id: "acceptance-1" });
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

  async function buildApp() {
    const app = Fastify();
    await registerAuth(app, { WEB_PASSWORD: "operator-password" } as never);
    for (const path of OPERATOR_ONLY_PATHS) {
      const handler = async (request: Parameters<typeof requireOperatorActor>[0], reply: Parameters<typeof requireOperatorActor>[1]) => {
        const actor = await requireOperatorActor(request, reply);
        return actor ? { reached: true, actor: actor.kind } : reply;
      };
      app.get(path, handler);
      app.post(path, handler);
    }
    for (const path of MOBILE_BEARER_PATHS) {
      app.get(path, async () => ({ reached: true }));
      app.post(path, async () => ({ reached: true }));
    }
    return app;
  }

  it("refuses a valid mobile bearer everywhere but the mobile surface", async () => {
    const app = await buildApp();

    const responses = await Promise.all(
      OPERATOR_ONLY_PATHS.map((url) =>
        app.inject({ method: "GET", url, headers: { authorization: "Bearer access-token" } })
      )
    );

    expect(responses.map((response) => response.statusCode)).toEqual(OPERATOR_ONLY_PATHS.map(() => 401));
    expect(responses.every((response) => response.json().error === "Password required")).toBe(true);
    await app.close();
  });

  it("keeps the mobile API and the assets it links reachable with a bearer", async () => {
    const app = await buildApp();

    const responses = await Promise.all(
      MOBILE_BEARER_PATHS.map((url) =>
        app.inject({ method: "GET", url, headers: { authorization: "Bearer access-token" } })
      )
    );

    expect(responses.map((response) => response.statusCode)).toEqual(MOBILE_BEARER_PATHS.map(() => 200));
    await app.close();
  });

  it("still lets the operator cookie through the whole protected surface", async () => {
    const app = await buildApp();
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "operator-password" }
    });
    const setCookie = login.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;

    const responses = await Promise.all(
      [...OPERATOR_ONLY_PATHS, ...MOBILE_BEARER_PATHS].map((url) =>
        app.inject({ method: "GET", url, headers: { cookie } })
      )
    );

    expect(responses.map((response) => response.statusCode)).toEqual(
      [...OPERATOR_ONLY_PATHS, ...MOBILE_BEARER_PATHS].map(() => 200)
    );
    await app.close();
  });

  it("keeps a verified operator cookie authoritative when a bearer is also present", async () => {
    const app = await buildApp();
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "operator-password" }
    });
    const setCookie = login.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;

    for (const authorization of ["Bearer access-token", "Bearer invalid-token"]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { cookie, authorization }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ reached: true, actor: "operator" });
    }
    await app.close();
  });
});
