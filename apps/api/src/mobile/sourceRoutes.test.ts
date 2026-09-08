import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ owner: "user1", read: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), retry: vi.fn(), hydrate: vi.fn() }));
vi.mock("@book-maker/db", () => ({
  prisma: { sourceDocument: { findFirst: mocks.findFirst }, sourceExtraction: { updateMany: mocks.updateMany }, mobileCreationDraft: { findFirst: mocks.findFirst } },
  createSourceService: (userId: string) => ({ read: (...args: unknown[]) => mocks.read(userId, ...args) })
}));
vi.mock("./httpErrors.js", () => ({ requireMobileAuth: async () => ({ user: { id: mocks.owner } }), sendMobileError: (reply: { code: (status: number) => { send: (body: unknown) => unknown } }, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } }) }));
vi.mock("./sourceAttachments.js", () => ({ hydrateSourceAttachments: mocks.hydrate, retrySourceUpload: mocks.retry, SourceUploadError: class extends Error {} }));
import { registerSourceRoutes } from "./routes/sources.js";
const apps: ReturnType<typeof Fastify>[] = [];
beforeEach(() => { vi.clearAllMocks(); mocks.owner = "user1"; });
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function app() {
  const server = Fastify();
  apps.push(server);
  await registerSourceRoutes(server);
  return server;
}
describe("authenticated source endpoints", () => {
  it("rejects invalid passage coordinates and retry payloads before accessing a source", async () => {
    const server = await app();
    expect((await server.inject({ method: "GET", url: "/api/mobile/sources/s1/versions/zero/passages/4" })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: "/api/mobile/creation-sessions/d1/attachments/s1/retry", payload: { requestId: "", version: 0 } })).statusCode).toBe(400);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("reads a passage through the authenticated owner's scope without an original file", async () => {
    mocks.read.mockResolvedValue({ sourceId: "s1", version: 1, ordinal: 4, content: "Final fact", locator: "Page 9", name: "Report" });
    const response = await (await app()).inject({ method: "GET", url: "/api/mobile/sources/s1/versions/1/passages/4" });
    expect(response.statusCode).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith("user1", "s1", 1, 4);
    expect(response.json().passage.content).toBe("Final fact");
  });
  it("returns a nondisclosing 404 for another account's passage", async () => {
    mocks.read.mockResolvedValue(null);
    mocks.owner = "other-account";
    const response = await (await app()).inject({ method: "GET", url: "/api/mobile/sources/s1/versions/1/passages/4" });
    expect(response.statusCode).toBe(404);
    expect(mocks.read).toHaveBeenCalledWith("other-account", "s1", 1, 4);
  });
  it("records explicit partial acceptance for that version without mutating the chat", async () => {
    mocks.findFirst.mockResolvedValue({ currentVersion: 2, draft: { payload: { payloadVersion: 3, attachments: [{ id: "s1", sourceId: "s1", name: "Report", kind: "document", mimeType: "text/plain", sizeBytes: 2, createdAt: "today" }] } } });
    const response = await (await app()).inject({ method: "POST", url: "/api/mobile/creation-sessions/d1/attachments/s1/use-readable", payload: { requestId: "accept-1", version: 2 } });
    expect(response.statusCode).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { sourceId: "s1", version: 2, status: { in: ["partial", "limited"] } }, data: { acceptedPartial: true } });
  });
  it("does not accept an older version after a retry changed the extraction", async () => {
    mocks.findFirst.mockResolvedValue({ currentVersion: 3, draft: { payload: { payloadVersion: 3, attachments: [{ id: "s1", name: "Report", kind: "document", mimeType: "text/plain", sizeBytes: 2, createdAt: "today" }] } } });
    const response = await (await app()).inject({ method: "POST", url: "/api/mobile/creation-sessions/d1/attachments/s1/use-readable", payload: { requestId: "accept-1", version: 2 } });
    expect(response.statusCode).toBe(409);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
