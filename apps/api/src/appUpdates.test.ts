import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appUpdateReleasesSchema,
  appUpdateRoutes,
  currentAppUpdateReleases,
  decideAppUpdate,
  forgetAppUpdatePolicy,
  readAppClient,
  registerAppUpdateGate,
  type AppUpdateRelease
} from "./appUpdates.js";

const mockPrisma = vi.hoisted(() => ({
  appUpdatePolicyRevision: {
    findFirst: vi.fn()
  }
}));

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));

const android = (build: number, policy: AppUpdateRelease["policy"], message?: string): AppUpdateRelease => ({
  platform: "android",
  build,
  version: `1.${build}.0`,
  policy,
  ...(message ? { message } : {})
});

function storePolicy(releases: AppUpdateRelease[] | null): void {
  mockPrisma.appUpdatePolicyRevision.findFirst.mockResolvedValue(releases ? { releases } : null);
}

async function appWithGate() {
  const app = Fastify({ logger: false });
  registerAppUpdateGate(app);
  await app.register(appUpdateRoutes);
  app.get("/api/mobile/projects", async () => ({ projects: [] }));
  app.get("/api/admin/overview", async () => ({ ok: true }));
  return app;
}

const fromBuild = (build: number, platform = "android") => ({
  "x-app-build": String(build),
  "x-app-platform": platform
});

describe("decideAppUpdate", () => {
  it("asks nothing of a build no recorded release is newer than", () => {
    expect(decideAppUpdate([android(3, "required")], { platform: "android", build: 3 })).toEqual({
      action: "none",
      latestBuild: null,
      latestVersion: null,
      message: null
    });
  });

  it("stays silent when every newer release is silent", () => {
    expect(decideAppUpdate([android(4, "silent"), android(5, "silent")], { platform: "android", build: 3 }).action).toBe(
      "none"
    );
  });

  it("prompts with the newest build and the prompting release's note", () => {
    expect(
      decideAppUpdate([android(4, "prompt", "New covers"), android(5, "silent")], { platform: "android", build: 3 })
    ).toEqual({ action: "prompt", latestBuild: 5, latestVersion: "1.5.0", message: "New covers" });
  });

  it("keeps a build below a required release gated however many quieter releases follow", () => {
    const releases = [android(4, "required", "Fixes purchases"), android(5, "prompt", "New covers"), android(6, "silent")];
    expect(decideAppUpdate(releases, { platform: "android", build: 3 })).toEqual({
      action: "required",
      latestBuild: 6,
      latestVersion: "1.6.0",
      message: "Fixes purchases"
    });
    // Past the required release, only the prompt is still newer.
    expect(decideAppUpdate(releases, { platform: "android", build: 4 }).action).toBe("prompt");
    expect(decideAppUpdate(releases, { platform: "android", build: 5 }).action).toBe("none");
  });

  it("reads only the client's own platform", () => {
    expect(decideAppUpdate([android(9, "required")], { platform: "ios", build: 1 }).action).toBe("none");
  });

  it("asks nothing of a request that names no build", () => {
    expect(decideAppUpdate([android(9, "required")], null).action).toBe("none");
  });
});

describe("readAppClient", () => {
  it("reads the build and platform headers", () => {
    expect(readAppClient({ headers: fromBuild(12, "Android") })).toEqual({ platform: "android", build: 12 });
  });

  it.each([
    [{}],
    [{ "x-app-build": "12" }],
    [{ "x-app-platform": "android" }],
    [{ "x-app-build": "12.0", "x-app-platform": "android" }],
    [{ "x-app-build": "-1", "x-app-platform": "android" }],
    [{ "x-app-build": "12", "x-app-platform": "web" }]
  ])("treats %j as no app build", (headers) => {
    expect(readAppClient({ headers })).toBeNull();
  });
});

describe("appUpdateReleasesSchema", () => {
  it("refuses one platform build listed twice", () => {
    const parsed = appUpdateReleasesSchema.safeParse([android(4, "prompt"), android(4, "required")]);
    expect(parsed.success).toBe(false);
  });

  it("accepts the same build number on two platforms", () => {
    const parsed = appUpdateReleasesSchema.safeParse([android(4, "prompt"), { ...android(4, "prompt"), platform: "ios" }]);
    expect(parsed.success).toBe(true);
  });
});

describe("app update gate and route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    forgetAppUpdatePolicy();
  });

  it("answers 426 with the decision to a build below a required release", async () => {
    storePolicy([android(4, "required", "Fixes purchases")]);
    const app = await appWithGate();

    const response = await app.inject({ method: "GET", url: "/api/mobile/projects", headers: fromBuild(3) });

    expect(response.statusCode).toBe(426);
    expect(response.json()).toMatchObject({
      error: {
        code: "APP_UPDATE_REQUIRED",
        update: { action: "required", latestBuild: 4, message: "Fixes purchases" }
      }
    });
    await app.close();
  });

  it("gates the mobile surface however its path is spelled", async () => {
    storePolicy([android(4, "required")]);
    const app = await appWithGate();

    // The router decodes these to `/api/mobile/projects`; the gate reads what it routed.
    for (const url of ["/%61pi/mobile/projects", "/api/%6Dobile/projects", "/api/mobile/%70rojects"]) {
      const response = await app.inject({ method: "GET", url, headers: fromBuild(3) });
      expect(response.statusCode, url).toBe(426);
    }
    const check = await app.inject({ method: "GET", url: "/api/mobile/%61pp-update", headers: fromBuild(3) });
    expect(check.statusCode).toBe(200);
    await app.close();
  });

  it("lets a prompted build, a current build and a request with no build through", async () => {
    storePolicy([android(4, "required"), android(5, "prompt")]);
    const app = await appWithGate();

    for (const headers of [fromBuild(4), fromBuild(5), {}]) {
      const response = await app.inject({ method: "GET", url: "/api/mobile/projects", headers });
      expect(response.statusCode).toBe(200);
    }
    await app.close();
  });

  it("never gates the check itself, or anything outside the mobile surface", async () => {
    storePolicy([android(4, "required")]);
    const app = await appWithGate();

    const check = await app.inject({ method: "GET", url: "/api/mobile/app-update?x=1", headers: fromBuild(3) });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toEqual({
      update: { action: "required", latestBuild: 4, latestVersion: "1.4.0", message: null }
    });

    const admin = await app.inject({ method: "GET", url: "/api/admin/overview", headers: fromBuild(3) });
    expect(admin.statusCode).toBe(200);
    await app.close();
  });

  it("answers the check with no update when nothing is recorded", async () => {
    storePolicy(null);
    const app = await appWithGate();

    const response = await app.inject({ method: "GET", url: "/api/mobile/app-update", headers: fromBuild(1) });

    expect(response.json()).toEqual({
      update: { action: "none", latestBuild: null, latestVersion: null, message: null }
    });
    await app.close();
  });
});

describe("currentAppUpdateReleases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    forgetAppUpdatePolicy();
  });

  it("reads the database once per TTL, and again after the console forgets it", async () => {
    storePolicy([android(4, "prompt")]);

    await currentAppUpdateReleases(1_000);
    await currentAppUpdateReleases(20_000);
    expect(mockPrisma.appUpdatePolicyRevision.findFirst).toHaveBeenCalledTimes(1);

    await currentAppUpdateReleases(40_000);
    expect(mockPrisma.appUpdatePolicyRevision.findFirst).toHaveBeenCalledTimes(2);

    forgetAppUpdatePolicy();
    await currentAppUpdateReleases(40_001);
    expect(mockPrisma.appUpdatePolicyRevision.findFirst).toHaveBeenCalledTimes(3);
  });

  it("keeps the last good list through a failed read", async () => {
    storePolicy([android(4, "required")]);
    await currentAppUpdateReleases(1_000);

    mockPrisma.appUpdatePolicyRevision.findFirst.mockRejectedValue(new Error("connection reset"));
    await expect(currentAppUpdateReleases(40_000)).resolves.toEqual([android(4, "required")]);
  });

  it("gates nobody when the stored list no longer parses", async () => {
    mockPrisma.appUpdatePolicyRevision.findFirst.mockResolvedValue({ releases: [{ platform: "android", build: "x" }] });
    await expect(currentAppUpdateReleases(1_000)).resolves.toEqual([]);
  });
});
