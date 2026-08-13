import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  creditLedgerEntry: { groupBy: vi.fn(), aggregate: vi.fn(), findMany: vi.fn() },
  providerCallLog: { aggregate: vi.fn() },
  voiceCall: { findMany: vi.fn() },
  bookEditOperation: { findMany: vi.fn() },
  project: { findMany: vi.fn() }
}));

vi.mock("@book-maker/db", () => ({ Prisma: {}, prisma: mockPrisma }));
vi.mock("@book-maker/db/billing", async () => (await import("../mobile/testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("../mobile/testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("../mobile/testing/mobileApiMocks.js")).projectStatusModuleMock());

import { creditPricing } from "@book-maker/core";
import { loadPricingDrivers } from "./pricingDrivers.js";
import { resolveWindow } from "./metrics.js";

type Edit = {
  kind: string;
  affectedPageIndexes: number[];
  project: { mediaSettings: unknown } | null;
};

function primeWindow(options: { edits: Edit[]; chargedCredits: number }): void {
  mockPrisma.creditLedgerEntry.groupBy.mockResolvedValue([]);
  mockPrisma.creditLedgerEntry.aggregate.mockResolvedValue({
    _sum: { amountCredits: -options.chargedCredits }
  });
  mockPrisma.creditLedgerEntry.findMany.mockResolvedValue([]);
  mockPrisma.providerCallLog.aggregate.mockResolvedValue({ _sum: { costHint: 2.5 } });
  mockPrisma.voiceCall.findMany.mockResolvedValue([]);
  mockPrisma.bookEditOperation.findMany.mockResolvedValue(options.edits);
  mockPrisma.project.findMany.mockResolvedValue([]);
}

describe("loadPricingDrivers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts every edit kind into its tier bucket, ADD_IMAGE as one image whatever pages it names", async () => {
    primeWindow({
      edits: [
        // 25 base + 2 × 10 per page, balanced (no tier recorded).
        { kind: "LOCAL_PATCH", affectedPageIndexes: [3, 4], project: { mediaSettings: null } },
        // 3 × 40 per page at the fast rate.
        { kind: "PAGE_REWRITE", affectedPageIndexes: [1, 2, 3], project: { mediaSettings: { modelTier: "fast" } } },
        // One image at 45, even though the operation names five pages.
        { kind: "ADD_IMAGE", affectedPageIndexes: [1, 2, 3, 4, 5], project: { mediaSettings: null } },
        // One image at the premium rate, 85.
        { kind: "ADD_IMAGE", affectedPageIndexes: [7], project: { mediaSettings: { modelTier: "premium" } } }
      ],
      // 45 + 120 + 45 + 85 — what the ledger charged for exactly these edits.
      chargedCredits: 295
    });

    const report = await loadPricingDrivers(resolveWindow(30), creditPricing());

    expect(report.drivers.bookTextEditBase).toBe(1);
    expect(report.drivers.bookTextEditPerPage).toBe(2);
    expect(report.drivers.pageRegenerationPerPageFast).toBe(3);
    expect(report.drivers.imageGeneration).toBe(1);
    expect(report.drivers.imageGenerationPremium).toBe(1);
    expect(report.drivers.imageGenerationFast).toBe(0);
    expect(report.edits).toBe(4);
    // 1×25 + 2×10 + 3×40 + 1×45 + 1×85 at the default prices.
    expect(report.coverage.modelledCredits).toBe(295);
    expect(report.coverage.chargedCredits).toBe(295);
    expect(report.coverage.accuracyPercent).toBe(100);
  });

  it("prices an ADD_IMAGE on a book with no tier recorded at the balanced rate", async () => {
    primeWindow({
      edits: [{ kind: "ADD_IMAGE", affectedPageIndexes: [12], project: null }],
      chargedCredits: 45
    });

    const report = await loadPricingDrivers(resolveWindow(7), creditPricing());

    expect(report.drivers.imageGeneration).toBe(1);
    expect(report.coverage.modelledCredits).toBe(45);
    expect(report.coverage.accuracyPercent).toBe(100);
  });

  it("does not count MOVE_IMAGE or REMOVE_IMAGE as generated images", async () => {
    primeWindow({
      edits: [
        { kind: "MOVE_IMAGE", affectedPageIndexes: [1, 2], project: { mediaSettings: null } },
        { kind: "REMOVE_IMAGE", affectedPageIndexes: [3], project: { mediaSettings: { modelTier: "premium" } } }
      ],
      chargedCredits: 0
    });

    const report = await loadPricingDrivers(resolveWindow(7), creditPricing());

    expect(report.drivers.imageGeneration).toBe(0);
    expect(report.drivers.imageGenerationPremium).toBe(0);
    expect(report.edits).toBe(2);
    expect(report.coverage.modelledCredits).toBe(0);
  });
});
