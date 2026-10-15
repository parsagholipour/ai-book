import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./mobile/testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./mobile/testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("./queue.js", async () => (await import("./mobile/testing/mobileApiMocks.js")).queueModuleMock());

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { mockPrisma, resetMobileHarness, teardownMobileHarness } from "./mobile/testing/mobileApiHarness.js";
import { mobileSafetyRoutes } from "./mobileSafety.js";
import { monitoringRoutes } from "./monitoring/monitoringRoutes.js";
import { requireOperatorActor, resolveProjectActor, routedRequestPath } from "./requestAuth.js";
import { adminAccountRoutes } from "./routes/adminAccounts.js";
import { adminAnalyticsRoutes } from "./routes/adminAnalytics.js";
import { adminAppUpdateRoutes } from "./routes/adminAppUpdates.js";
import { adminGenerationQualityRoutes } from "./routes/adminGenerationQuality.js";
import { adminPricingRoutes } from "./routes/adminPricing.js";
import { adminProjectExportRoutes } from "./routes/adminProjectExports.js";
import { adminSafetyRoutes } from "./routes/adminSafety.js";
import { adminShareRoutes } from "./routes/adminShares.js";
import { adminSpendControlRoutes } from "./routes/adminSpendControls.js";
import { projectRoutes } from "./routes/projects.js";

/**
 * Only the auth hook makes an operator. A handler that reaches for one finds
 * `request.operatorAuth` set by the hook or refuses — it never concludes
 * "operator" from a missing bearer, and never marks one itself. Those two
 * habits are what turned one percent-encoded letter past the hook into the
 * whole console, so every request here is built with *no* auth hook at all:
 * that is the state a future hook bypass leaves a handler in.
 */

let app: FastifyInstance | null = null;

beforeEach(() => {
  resetMobileHarness();
});

afterEach(async () => {
  await app?.close();
  app = null;
  teardownMobileHarness();
});

/** Every Prisma method the request touched — a refused request must touch none. */
function prismaCalls(): string[] {
  return Object.entries(mockPrisma).flatMap(([model, methods]) => {
    if (vi.isMockFunction(methods)) {
      return methods.mock.calls.length > 0 ? [model] : [];
    }
    return Object.entries(methods as Record<string, unknown>)
      .filter(([, method]) => vi.isMockFunction(method) && method.mock.calls.length > 0)
      .map(([name]) => `${model}.${name}`);
  });
}

describe("routedRequestPath", () => {
  const requestFor = (url: string, routed: string | undefined) =>
    ({ url, routeOptions: { url: routed } }) as unknown as FastifyRequest;

  it("answers the pattern the router matched, however the URL was spelled", () => {
    expect(routedRequestPath(requestFor("/%61pi/admin/users", "/api/admin/users"))).toBe("/api/admin/users");
    expect(routedRequestPath(requestFor("/api/admin/users/o%27brien", "/api/admin/users/:id"))).toBe("/api/admin/users/:id");
  });

  it("decodes the path of a request no specific route took", () => {
    expect(routedRequestPath(requestFor("/%61pi/nothing?x=1", undefined))).toBe("/api/nothing");
    expect(routedRequestPath(requestFor("/%61pi/admin/users", "/*"))).toBe("/api/admin/users");
    expect(routedRequestPath(requestFor("/api/mobile/%2e%2e/admin/users", undefined))).toBe("/api/admin/users");
    // Never read as a protocol-relative URL whose host is `api`.
    expect(routedRequestPath(requestFor("//api/admin/users", undefined))).toBe("//api/admin/users");
  });

  it("answers null for a path that will not decode", () => {
    expect(routedRequestPath(requestFor("/api/%E0%A4%A", undefined))).toBeNull();
  });
});

describe("a handler with no auth hook in front of it", () => {
  it("refuses operator access rather than inferring it from a missing bearer", async () => {
    app = Fastify();
    app.get("/api/projects", async (request, reply) => ((await requireOperatorActor(request, reply)) ? { reached: true } : reply));
    app.get("/assets/images/:projectId/:filename", async (request, reply) => ((await resolveProjectActor(request, reply)) ? { reached: true } : reply));

    for (const url of ["/api/projects", "/assets/images/project-1/cover.png"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json(), url).toEqual({ error: "Password required" });
    }
    expect(mockPrisma.user.upsert).not.toHaveBeenCalled();
  });

  it("takes the operator the hook established, and that is the only way in", async () => {
    app = Fastify();
    // Stands in for `registerAuth` having checked the cookie.
    app.addHook("onRequest", async (request) => {
      request.operatorAuth = { userId: "local-admin" };
    });
    app.get("/api/projects", async (request, reply) => {
      const actor = await requireOperatorActor(request, reply);
      return actor ? { actor } : reply;
    });

    const response = await app.inject({ method: "GET", url: "/api/projects" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ actor: { kind: "operator", userId: "local-admin" } });
  });

  it("refuses every legacy operator route, touching nothing", async () => {
    app = Fastify();
    const operatorRoutes: Array<{ method: string; url: string }> = [];
    app.addHook("onRoute", (route) => {
      for (const method of [route.method].flat()) {
        // `/api/health` is public by design (`shouldProtectPath`).
        if (route.url.startsWith("/api/") && route.url !== "/api/health" && method !== "HEAD") {
          operatorRoutes.push({ method, url: route.url.replaceAll(/:(\w+)/g, "$1-1").replace("*", "pdf") });
        }
      }
    });
    await app.register(projectRoutes);
    await app.ready();
    vi.clearAllMocks();

    expect(operatorRoutes.map((route) => route.url)).toEqual(expect.arrayContaining(["/api/runtime", "/api/voice/rtc-config", "/api/voice/providers", "/api/plans/id-1/approve"]));
    for (const { method, url } of operatorRoutes) {
      const response = await app.inject({ method: method as "GET", url, ...(method === "GET" || method === "DELETE" ? {} : { payload: {} }) });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json(), `${method} ${url}`).toEqual({ error: "Password required" });
    }
    expect(prismaCalls()).toEqual([]);
  });

  it("refuses every admin route, touching nothing, on every admin plugin", async () => {
    app = Fastify();
    // Read off the router rather than listed, so a route added later is covered.
    const adminRoutes: Array<{ method: string; url: string }> = [];
    app.addHook("onRoute", (route) => {
      for (const method of [route.method].flat()) {
        if (route.url.startsWith("/api/admin/") && method !== "HEAD") {
          adminRoutes.push({ method, url: route.url.replaceAll(/:(\w+)/g, "$1-1") });
        }
      }
    });
    for (const plugin of [
      adminAccountRoutes,
      adminAnalyticsRoutes,
      adminAppUpdateRoutes,
      adminGenerationQualityRoutes,
      adminPricingRoutes,
      adminProjectExportRoutes,
      adminSafetyRoutes,
      adminShareRoutes,
      adminSpendControlRoutes,
      mobileSafetyRoutes
    ]) {
      await app.register(plugin);
    }
    // Sends mail, so it takes its transport; the refusal comes before any of it is read.
    await app.register(monitoringRoutes, { mailer: null, mailHealth: {} as never, recipient: undefined, publicUrl: "https://tomeza.test" });
    await app.ready();

    expect(adminRoutes.length).toBeGreaterThanOrEqual(30);
    // The ones written after this list was, named so dropping a plugin above cannot pass quietly.
    expect(adminRoutes).toEqual(
      expect.arrayContaining([
        { method: "POST", url: "/api/admin/users/id-1/moderation" },
        { method: "POST", url: "/api/admin/monitoring/test-alert" },
        { method: "POST", url: "/api/admin/shares/id-1/moderation" }
      ])
    );
    for (const { method, url } of adminRoutes) {
      const response = await app.inject({ method: method as "GET", url, ...(method === "GET" ? {} : { payload: {} }) });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json(), `${method} ${url}`).toEqual({ error: "Password required" });
    }
    expect(prismaCalls()).toEqual([]);
  });
});
