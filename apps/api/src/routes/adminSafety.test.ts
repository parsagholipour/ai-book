import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "../auth.js";
import { adminSafetyRoutes } from "./adminSafety.js";

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  user: { upsert: vi.fn() },
  safetySettingsRevision: {
    findFirst: vi.fn(),
    create: vi.fn()
  }
}));

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));

describe("admin safety settings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.user.upsert.mockResolvedValue({ id: "local-admin" });
    mockPrisma.$transaction.mockImplementation(
      async (operation: (tx: typeof mockPrisma) => Promise<unknown>) =>
        operation(mockPrisma)
    );
  });

  it("defaults copyright restrictions to disabled", async () => {
    mockPrisma.safetySettingsRevision.findFirst.mockResolvedValue(null);
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/safety-settings"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 0,
      copyrightRestrictionsEnabled: false,
      // The opposite default: no revision means the filter is ON.
      sexualContentFilterEnabled: true
    });
    await app.close();
  });

  it("reads a revision that predates the filter's column as ON, and an explicit false as off", async () => {
    mockPrisma.safetySettingsRevision.findFirst.mockResolvedValueOnce({
      version: 4, copyrightRestrictionsEnabled: true, note: null, updatedBy: null, createdAt: new Date("2026-10-01T00:00:00.000Z")
    });
    const app = await buildApp();
    const legacy = await app.inject({ method: "GET", url: "/api/admin/safety-settings" });
    expect(legacy.json()).toMatchObject({ version: 4, copyrightRestrictionsEnabled: true, sexualContentFilterEnabled: true });

    mockPrisma.safetySettingsRevision.findFirst.mockResolvedValueOnce({
      version: 5, copyrightRestrictionsEnabled: true, sexualContentFilterEnabled: false, note: null, updatedBy: null,
      createdAt: new Date("2026-10-02T00:00:00.000Z")
    });
    const off = await app.inject({ method: "GET", url: "/api/admin/safety-settings" });
    expect(off.json()).toMatchObject({ version: 5, sexualContentFilterEnabled: false });
    await app.close();
  });

  it("round-trips the sexual-content switch without moving the copyright one", async () => {
    mockPrisma.safetySettingsRevision.findFirst.mockResolvedValue({
      version: 7,
      copyrightRestrictionsEnabled: true,
      sexualContentFilterEnabled: true
    });
    mockPrisma.safetySettingsRevision.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "safety-8", note: null, updatedBy: null, createdAt: new Date("2026-10-13T09:00:00.000Z"), ...data
      })
    );
    const app = await buildApp();

    const off = await app.inject({
      method: "PATCH",
      url: "/api/admin/safety-settings",
      payload: { sexualContentFilterEnabled: false, note: "Adult fiction pilot" }
    });

    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ version: 8, copyrightRestrictionsEnabled: true, sexualContentFilterEnabled: false });
    expect(mockPrisma.safetySettingsRevision.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ version: 8, copyrightRestrictionsEnabled: true, sexualContentFilterEnabled: false })
    });

    // An older console that sends only the copyright switch keeps the filter as it is.
    mockPrisma.safetySettingsRevision.findFirst.mockResolvedValue({
      version: 8,
      copyrightRestrictionsEnabled: true,
      sexualContentFilterEnabled: false
    });
    const copyrightOnly = await app.inject({
      method: "PATCH",
      url: "/api/admin/safety-settings",
      payload: { copyrightRestrictionsEnabled: false }
    });
    expect(copyrightOnly.json()).toMatchObject({ version: 9, copyrightRestrictionsEnabled: false, sexualContentFilterEnabled: false });
    await app.close();
  });

  it("refuses a save that names no setting", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "PATCH", url: "/api/admin/safety-settings", payload: { note: "nothing" } });
    expect(response.statusCode).toBe(400);
    expect(mockPrisma.safetySettingsRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("writes an append-only revision when the operator toggles the gate", async () => {
    mockPrisma.safetySettingsRevision.findFirst.mockResolvedValue({
      version: 2,
      copyrightRestrictionsEnabled: false
    });
    mockPrisma.safetySettingsRevision.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "safety-3",
        note: null,
        updatedBy: null,
        createdAt: new Date("2026-08-08T09:00:00.000Z"),
        ...data
      })
    );
    const app = await buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/safety-settings",
      payload: {
        copyrightRestrictionsEnabled: true,
        note: "Enable for launch"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 3,
      copyrightRestrictionsEnabled: true,
      note: "Enable for launch"
    });
    expect(mockPrisma.safetySettingsRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 3,
        copyrightRestrictionsEnabled: true,
        // The current revision named no filter value, which is ON.
        sexualContentFilterEnabled: true,
        updatedBy: "operator-console"
      })
    });
    await app.close();
  });
});

/** Through the auth hook with password auth off, as in local development: the hook is what makes the operator. */
async function buildApp() {
  const app = Fastify({ logger: false });
  await registerAuth(app, { WEB_PASSWORD: "" } as never);
  await app.register(adminSafetyRoutes);
  return app;
}
