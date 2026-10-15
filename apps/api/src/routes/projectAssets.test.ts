import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({ project: { findFirst: vi.fn() } }));

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));
vi.mock("./projectExports.js", () => ({
  ownedProjectWhere: (projectId: string, actor: { userId: string }) => ({ id: projectId, userId: actor.userId })
}));
vi.mock("../requestAuth.js", () => ({
  resolveProjectActor: vi.fn(async () => ({ kind: "mobile", userId: "user-1" })),
  sendProjectNotFound: (reply: { code(status: number): { send(body: unknown): unknown } }, label = "Project not found") =>
    reply.code(404).send({ error: label })
}));

import { seedObject } from "../testing/objectStorage.js";
import { registerProjectAssetRoutes } from "./projectAssets.js";

/**
 * The asset prefixes are the one surface both actor kinds reach, and the bytes
 * behind them include generated SVG covers. An SVG opened as a document runs
 * its script on the API's origin, so it is served sandboxed; nothing here is
 * ever sniffed into another type.
 */

async function buildApp() {
  const app = Fastify();
  registerProjectAssetRoutes(app, {} as never);
  return app;
}

describe("project asset routes", () => {
  beforeEach(() => {
    mockPrisma.project.findFirst.mockReset();
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
  });

  it("serves an SVG sandboxed and unsniffed", async () => {
    seedObject("images/project-1/cover.svg", `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/assets/images/project-1/cover.svg" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/svg+xml");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toMatch(/^sandbox;/);
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    await app.close();
  });

  it("serves a raster picture with its own type, unsniffed, and with no document policy", async () => {
    seedObject("images/project-1/page-1.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/assets/images/project-1/page-1.png" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toBeUndefined();
    await app.close();
  });

  it("serves an unknown or prototype-named extension as bytes", async () => {
    seedObject("images/project-1/page.html", "<script>alert(1)</script>");
    seedObject("images/project-1/a.constructor", "x");
    seedObject("images/project-1/a.__proto__", "x");
    const app = await buildApp();

    for (const filename of ["page.html", "a.constructor", "a.__proto__"]) {
      const response = await app.inject({ method: "GET", url: `/assets/images/project-1/${filename}` });
      expect({ filename, status: response.statusCode, type: response.headers["content-type"] }).toEqual({
        filename,
        status: 200,
        type: "application/octet-stream"
      });
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    }
    await app.close();
  });

  it("answers 404 for a project the actor does not own", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);
    seedObject("images/project-2/cover.svg", "<svg/>");
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/assets/images/project-2/cover.svg" });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
