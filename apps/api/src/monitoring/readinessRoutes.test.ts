import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "../auth.js";
import { READINESS_CHECKS, type ReadinessProbe, type ReadinessReport } from "./readiness.js";
import { readinessRoutes } from "./readinessRoutes.js";

/**
 * `/api/ready` is public behind the real auth hook, with the operator password
 * set — and so is every spelling of it the router decodes to the same route,
 * because the hook reads the route the router matched (`routedRequestPath`),
 * never the URL as sent.
 */

const mockPrisma = vi.hoisted(() => ({
  user: { upsert: vi.fn(async () => ({ id: "local-admin" })) },
  mobileSession: { findUnique: vi.fn() },
  legalAcceptance: { findFirst: vi.fn() }
}));

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));

function report(failing: string[] = []): ReadinessReport {
  const results = Object.fromEntries(
    READINESS_CHECKS.map((check) => [
      check,
      failing.includes(check) ? { ok: false, reason: "connect ECONNREFUSED 172.18.0.3:5432 password=hunter2" } : { ok: true }
    ])
  ) as ReadinessReport["results"];
  return { ok: failing.length === 0, checkedAt: new Date("2026-10-13T12:00:00.000Z"), results };
}

let app: FastifyInstance | null = null;

async function buildApp(probe: ReadinessProbe): Promise<FastifyInstance> {
  const instance = Fastify();
  await registerAuth(instance, { WEB_PASSWORD: "operator-password-1234" } as never);
  await instance.register(readinessRoutes, { probe });
  instance.get("/api/admin/users", async () => ({ reached: true }));
  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("GET /api/ready", () => {
  it("answers 200 with a terse body and no cookie when every check passes", async () => {
    const instance = await buildApp({ check: async () => report() });
    const response = await instance.inject({ method: "GET", url: "/api/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      ok: true,
      checks: { db: "ok", redis: "ok", storage: "ok", mail: "ok", worker_long: "ok", worker_interactive: "ok", queue_long: "ok", queue_interactive: "ok" }
    });
  });

  it("answers 503 naming the failing check and nothing about why", async () => {
    const instance = await buildApp({ check: async () => report(["db", "queue_long"]) });
    const response = await instance.inject({ method: "GET", url: "/api/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, checks: { db: "fail", queue_long: "fail", redis: "ok" } });
    expect(response.body).not.toMatch(/ECONNREFUSED|172\.18|hunter2|reason/);
  });

  it("is public under every spelling the router decodes to it, while the console next to it stays locked", async () => {
    const probe = { check: vi.fn(async () => report()) };
    const instance = await buildApp(probe);
    const plain = await instance.inject({ method: "GET", url: "/api/ready" });

    for (const url of ["/%61pi/ready", "/api/%72eady", "/%61%70%69/%72%65%61%64%79", "/api/ready?probe=uptime"]) {
      const response = await instance.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.json(), url).toEqual(plain.json());
    }
    const head = await instance.inject({ method: "HEAD", url: "/%61pi/ready" });
    expect(head.statusCode).toBe(200);

    // The exemption is the route, not a prefix: its neighbours still need the cookie.
    for (const url of ["/api/admin/users", "/%61pi/admin/users", "/api/ready/../admin/users"]) {
      expect((await instance.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
    expect(mockPrisma.user.upsert).not.toHaveBeenCalled();
  });

  it("does not treat a mobile bearer as a reason to refuse it", async () => {
    const instance = await buildApp({ check: async () => report() });
    const response = await instance.inject({ method: "GET", url: "/api/ready", headers: { authorization: "Bearer stale-token" } });
    expect(response.statusCode).toBe(200);
    expect(mockPrisma.mobileSession.findUnique).not.toHaveBeenCalled();
  });
});
