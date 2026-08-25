import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findUnique: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: {
    bookEditOperation: {
      updateMany: mocks.updateMany,
      findUnique: mocks.findUnique
    }
  }
}));

import { claimEditOperationForDelivery } from "./editOperationDelivery.js";

const operation = (status: "ACTIVE" | "APPLIED" | "CANCELED" | "FAILED") => ({
  id: "op-1",
  status,
  classifier: {}
});

describe("claimEditOperationForDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the fresh row when the activation claim wins", async () => {
    const stored = operation("ACTIVE");
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findUnique.mockResolvedValue(stored);

    await expect(claimEditOperationForDelivery("op-1")).resolves.toEqual({
      outcome: "claimed",
      stored
    });
    expect(mocks.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0]!
    );
  });

  it("replays an operation another actor settled as APPLIED", async () => {
    const stored = operation("APPLIED");
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.findUnique.mockResolvedValue(stored);

    await expect(claimEditOperationForDelivery("op-1")).resolves.toEqual({
      outcome: "replay",
      stored
    });
  });

  it("stands down when another actor settled the operation as CANCELED", async () => {
    const stored = operation("CANCELED");
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.findUnique.mockResolvedValue(stored);

    await expect(claimEditOperationForDelivery("op-1")).resolves.toEqual({
      outcome: "settled",
      stored
    });
  });

  it("re-activates a FAILED operation for the paid resume lane", async () => {
    let status: "FAILED" | "ACTIVE" = "FAILED";
    mocks.updateMany.mockImplementation(async () => {
      status = "ACTIVE";
      return { count: 1 };
    });
    mocks.findUnique.mockImplementation(async () => operation(status));

    await expect(claimEditOperationForDelivery("op-1")).resolves.toEqual({
      outcome: "claimed",
      stored: operation("ACTIVE")
    });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "op-1", status: { notIn: ["APPLIED", "CANCELED"] } },
      data: { status: "ACTIVE" }
    });
  });
});
