import Fastify, { type FastifyInstance } from "fastify";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { registerAuth } from "./auth.js";
import { resetOperatorEpochCacheForTests } from "./operatorSessions.js";

/**
 * The auth hook decides from the route the router matched, never from the URL
 * as sent.
 *
 * `request.url` keeps its percent-encoding and find-my-way decodes it before
 * matching, so `GET /%61pi/admin/users` used to be read by the hook as a path
 * outside `/api/` — nothing protected — and then run the `/api/admin/users`
 * handler, which trusted the hook. nginx forwards `$request_uri` raw, so that
 * was the whole operator console from the internet.
 *
 * Every handler here is a bare stub with no guard of its own, so a 200 is the
 * hook letting a request through and nothing else.
 */

const mockPrisma = vi.hoisted(() => ({
  user: { upsert: vi.fn() },
  mobileSession: { findUnique: vi.fn() },
  legalAcceptance: { findFirst: vi.fn() },
  // No row: generation 0, which every cookie these suites sign in for carries.
  operatorSessionEpoch: { findUnique: vi.fn(), upsert: vi.fn() }
}));

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));

const ENCODED_OPERATOR_REQUESTS = [
  { method: "GET", url: "/%61pi/admin/users", route: "/api/admin/users" },
  { method: "PUT", url: "/ap%69/admin/pricing", route: "/api/admin/pricing" },
  { method: "GET", url: "/api/%61dmin/users", route: "/api/admin/users" },
  { method: "GET", url: "/%61%70%69/admin/users", route: "/api/admin/users" },
  { method: "GET", url: "/%64ocs/json", route: "/docs/json" },
  { method: "GET", url: "/%61pi/projects", route: "/api/projects" },
  { method: "GET", url: "/%61pi/admin/users/user-1", route: "/api/admin/users/:id" },
  { method: "GET", url: "/%61ssets/images/project-1/cover.png", route: "/assets/images/:projectId/:filename" }
] as const;

let reached: string[] = [];
let app: FastifyInstance | null = null;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await registerAuth(instance, { WEB_PASSWORD: "operator-password" } as never);
  const stub = (route: string) => async (request: { params: unknown }) => {
    reached.push(route);
    return { reached: route, params: request.params };
  };
  for (const route of ["/api/admin/users", "/api/admin/users/:id", "/docs/json", "/api/projects", "/api/mobile/projects", "/api/mobile/projects/:id"]) {
    instance.get(route, stub(route));
  }
  instance.put("/api/admin/pricing", stub("/api/admin/pricing"));
  instance.post("/api/mobile/projects", stub("/api/mobile/projects"));
  instance.get("/assets/images/:projectId/:filename", stub("/assets/images/:projectId/:filename"));
  instance.get("/s/:slug", stub("/s/:slug"));
  app = instance;
  return instance;
}

async function operatorCookie(instance: FastifyInstance): Promise<string> {
  const login = await instance.inject({ method: "POST", url: "/api/auth/login", payload: { password: "operator-password" } });
  const setCookie = login.headers["set-cookie"];
  return String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0]!;
}

/** A request whose path goes out byte for byte: `fetch` and `inject` both resolve dot segments first. */
async function rawGet(address: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  const { hostname, port } = new URL(address);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: hostname, port: Number(port), path, method: "GET", headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

const bearer = { authorization: "Bearer access-token" };

beforeEach(() => {
  vi.resetAllMocks();
  resetOperatorEpochCacheForTests();
  reached = [];
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

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("the auth hook reads the route the router matched", () => {
  it("refuses an encoded spelling of every operator path without the cookie", async () => {
    const instance = await buildApp();

    for (const { method, url } of ENCODED_OPERATOR_REQUESTS) {
      const response = await instance.inject({ method, url });
      // The asset route is the shared surface, so its refusal is the app's 401.
      const expected = url.startsWith("/%61ssets/") ? { error: { code: "AUTH_REQUIRED", message: "Sign in to continue." } } : { error: "Password required" };
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json(), `${method} ${url}`).toEqual(expected);
    }
    expect(reached).toEqual([]);
  });

  it("refuses a mobile bearer on an encoded operator path", async () => {
    const instance = await buildApp();

    for (const { method, url } of ENCODED_OPERATOR_REQUESTS.filter((request) => !request.url.startsWith("/%61ssets/"))) {
      const response = await instance.inject({ method, url, headers: bearer });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json(), `${method} ${url}`).toEqual({ error: "Password required" });
    }
    expect(reached).toEqual([]);
  });

  it("still lets the operator through however the path is spelled", async () => {
    const instance = await buildApp();
    const cookie = await operatorCookie(instance);

    for (const { method, url, route } of ENCODED_OPERATOR_REQUESTS) {
      const response = await instance.inject({ method, url, headers: { cookie } });
      expect(response.statusCode, `${method} ${url}`).toBe(200);
      expect(response.json().reached, `${method} ${url}`).toBe(route);
    }
  });

  it("answers an encoded mobile path exactly as the plain one", async () => {
    const instance = await buildApp();

    const plain = await instance.inject({ method: "GET", url: "/api/mobile/projects", headers: bearer });
    const encoded = await instance.inject({ method: "GET", url: "/api/mobile/%70rojects", headers: bearer });
    const signedOut = await instance.inject({ method: "GET", url: "/api/mobile/%70rojects" });

    expect(plain.statusCode).toBe(200);
    expect(encoded.statusCode).toBe(200);
    expect(encoded.json()).toEqual(plain.json());
    expect(signedOut.statusCode).toBe(401);
    expect(signedOut.json()).toEqual({ error: { code: "AUTH_REQUIRED", message: "Sign in to continue." } });
  });

  it("never reaches an operator handler through a dot segment, raw on the wire or resolved", async () => {
    const instance = await buildApp();
    const address = await instance.listen({ host: "127.0.0.1", port: 0 });
    const dotted = ["/api/mobile/../admin/users", "/api/mobile/%2e%2e/admin/users", "/api/mobile/%2E%2E/admin/users", "/api/mobile/./../admin/users"];

    for (const path of dotted) {
      const resolved = await instance.inject({ method: "GET", url: path, headers: bearer });
      expect(resolved.statusCode, `inject ${path}`).toBe(401);
      for (const headers of [{}, bearer]) {
        expect(await rawGet(address, path, headers), `raw ${path}`).toBe(401);
      }
    }
    expect(reached).toEqual([]);
  });

  it("keeps percent-encoded route parameters working", async () => {
    const instance = await buildApp();
    const cookie = await operatorCookie(instance);

    const asset = await instance.inject({ method: "GET", url: "/assets/images/project-1/cover%20art.png", headers: bearer });
    const project = await instance.inject({ method: "GET", url: "/api/mobile/projects/caf%C3%A9", headers: bearer });
    const slashInId = await instance.inject({ method: "GET", url: "/api/mobile/projects/a%2Fb", headers: bearer });
    const user = await instance.inject({ method: "GET", url: "/api/admin/users/o%27brien", headers: { cookie } });
    const share = await instance.inject({ method: "GET", url: "/s/Slug%2D1" });

    expect(asset.statusCode).toBe(200);
    expect(asset.json().params).toEqual({ projectId: "project-1", filename: "cover art.png" });
    expect(project.statusCode).toBe(200);
    expect(project.json().params).toEqual({ id: "café" });
    expect(slashInId.statusCode).toBe(200);
    expect(slashInId.json().params).toEqual({ id: "a/b" });
    expect(user.statusCode).toBe(200);
    expect(user.json().params).toEqual({ id: "o'brien" });
    // The share surface stays public: no cookie, no bearer.
    expect(share.statusCode).toBe(200);
    expect(share.json().params).toEqual({ slug: "Slug-1" });
  });

  it("classifies a request no route matched by its decoded path", async () => {
    const instance = await buildApp();

    const encodedMissing = await instance.inject({ method: "GET", url: "/%61pi/nothing-here" });
    const plainMissing = await instance.inject({ method: "GET", url: "/api/nothing-here" });
    const outside = await instance.inject({ method: "GET", url: "/nothing-here" });

    expect(encodedMissing.statusCode).toBe(401);
    expect(plainMissing.statusCode).toBe(401);
    expect(outside.statusCode).toBe(404);
  });
});

/** A cookie signed with the console password, for payloads the login route never issues. */
function signedCookie(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", "operator-password").update(body).digest("base64url");
  return `ai_book_maker_session=${encodeURIComponent(`${body}.${signature}`)}`;
}

describe("the operator cookie", () => {
  it("lives a week, and a cookie from before the week or the generation is refused", async () => {
    const instance = await buildApp();
    const login = await instance.inject({ method: "POST", url: "/api/auth/login", payload: { password: "operator-password" } });
    expect(String(login.headers["set-cookie"])).toContain(`Max-Age=${60 * 60 * 24 * 7}`);

    // The 30-day cookie every browser held before: no generation in it.
    const legacy = signedCookie({ exp: Date.now() + 29 * 24 * 60 * 60 * 1000 });
    expect((await instance.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: legacy } })).statusCode).toBe(401);
    // A generation, but an expiry no week-long cookie can carry.
    const tooLong = signedCookie({ exp: Date.now() + 20 * 24 * 60 * 60 * 1000, epoch: 0 });
    expect((await instance.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: tooLong } })).statusCode).toBe(401);
    const current = signedCookie({ exp: Date.now() + 60_000, epoch: 0 });
    expect((await instance.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: current } })).statusCode).toBe(200);
  });

  it("signs every browser out when one of them asks", async () => {
    const instance = await buildApp();
    const first = await operatorCookie(instance);
    const second = await operatorCookie(instance);
    expect((await instance.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: second } })).statusCode).toBe(200);
    mockPrisma.operatorSessionEpoch.upsert.mockResolvedValue({ epoch: 1 });

    const revoked = await instance.inject({ method: "POST", url: "/api/auth/logout-everywhere", headers: { cookie: first } });

    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ enabled: true, authenticated: false });
    expect(String(revoked.headers["set-cookie"])).toContain("Max-Age=0");
    expect(mockPrisma.operatorSessionEpoch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "console" }, update: { epoch: { increment: 1 } } })
    );
    // The other browser's cookie is refused, and so is the one that asked.
    expect((await instance.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: second } })).statusCode).toBe(401);
    expect((await instance.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: first } })).statusCode).toBe(401);
    // Signing in again issues a cookie of the new generation.
    mockPrisma.operatorSessionEpoch.findUnique.mockResolvedValue({ epoch: 1 });
    const fresh = await operatorCookie(instance);
    expect((await instance.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: fresh } })).statusCode).toBe(200);
  });

  it("will not sign out everywhere without a valid cookie", async () => {
    const instance = await buildApp();
    const response = await instance.inject({ method: "POST", url: "/api/auth/logout-everywhere" });
    expect(response.statusCode).toBe(401);
    expect(mockPrisma.operatorSessionEpoch.upsert).not.toHaveBeenCalled();
  });

  it("fails closed when the generation has never been readable", async () => {
    const instance = await buildApp();
    const cookie = signedCookie({ exp: Date.now() + 60_000, epoch: 0 });
    mockPrisma.operatorSessionEpoch.findUnique.mockRejectedValue(new Error("database down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect((await instance.inject({ method: "GET", url: "/api/admin/users", headers: { cookie } })).statusCode).toBe(401);
    const login = await instance.inject({ method: "POST", url: "/api/auth/login", payload: { password: "operator-password" } });
    expect(login.statusCode).toBe(503);
    expect(reached).toEqual([]);
    consoleError.mockRestore();
  });

  it("keeps the last generation it read through a failed read", async () => {
    const instance = await buildApp();
    const cookie = await operatorCookie(instance);
    resetOperatorEpochCacheForTests();
    expect((await instance.inject({ method: "GET", url: "/api/admin/users", headers: { cookie } })).statusCode).toBe(200);
    mockPrisma.operatorSessionEpoch.findUnique.mockRejectedValue(new Error("database down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    try {
      expect((await instance.inject({ method: "GET", url: "/api/admin/users", headers: { cookie } })).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });
});

describe("console security headers", () => {
  it("are on console and /docs responses, and not on the app's or the share pages'", async () => {
    const instance = await buildApp();
    const cookie = await operatorCookie(instance);

    for (const url of ["/api/admin/users", "/docs/json", "/api/auth/status", "/nothing-here"]) {
      const response = await instance.inject({ method: "GET", url, headers: { cookie } });
      expect(response.headers["x-frame-options"], url).toBe("SAMEORIGIN");
      expect(response.headers["x-content-type-options"], url).toBe("nosniff");
      expect(response.headers["referrer-policy"], url).toBe("same-origin");
    }
    for (const url of ["/api/mobile/projects", "/s/Slug-1"]) {
      const response = await instance.inject({ method: "GET", url, headers: bearer });
      expect(response.headers["x-frame-options"], url).toBeUndefined();
    }
  });
});
