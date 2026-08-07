import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminSafetyRoutes } from "./adminSafety.js";

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  safetySettingsRevision: {
    findFirst: vi.fn(),
    create: vi.fn()
  }
}));

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));

describe("admin safety settings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (operation: (tx: typeof mockPrisma) => Promise<unknown>) =>
        operation(mockPrisma)
    );
  });

  it("defaults copyright restrictions to disabled", async () => {
    mockPrisma.safetySettingsRevision.findFirst.mockResolvedValue(null);
    const app = Fastify();
    await app.register(adminSafetyRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/safety-settings"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 0,
      copyrightRestrictionsEnabled: false
    });
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
    const app = Fastify({ logger: false });
    await app.register(adminSafetyRoutes);

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
        updatedBy: "operator-console"
      })
    });
    await app.close();
  });
});
