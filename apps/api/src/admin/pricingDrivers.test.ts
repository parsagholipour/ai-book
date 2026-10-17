import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  creditLedgerEntry: { groupBy: vi.fn(), aggregate: vi.fn(), findMany: vi.fn() },
  providerCallLog: { aggregate: vi.fn() },
  voiceCall: { findMany: vi.fn() },
  bookEditOperation: { findMany: vi.fn() },
  project: { findMany: vi.fn() },
  $queryRaw: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ Prisma: { raw: (sql: string) => sql }, prisma: mockPrisma }));
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
  ledgerEntry?: {
    status: string;
    amountCredits: number;
    reversedByEntry: { amountCredits: number } | null;
  } | null;
};

function primeWindow(options: { edits: Edit[]; chargedCredits: number; refundedCredits?: number }): void {
  mockPrisma.creditLedgerEntry.groupBy.mockResolvedValue([]);
  mockPrisma.creditLedgerEntry.aggregate.mockImplementation(({ where }: { where: { entryType: string } }) =>
    Promise.resolve({
      _sum: {
        amountCredits: where.entryType === "REFUND" ? (options.refundedCredits ?? 0) : -options.chargedCredits
      }
    })
  );
  mockPrisma.creditLedgerEntry.findMany.mockResolvedValue([]);
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockPrisma.providerCallLog.aggregate.mockResolvedValue({ _sum: { costHint: 2.5 } });
  mockPrisma.voiceCall.findMany.mockResolvedValue([]);
  mockPrisma.bookEditOperation.findMany.mockResolvedValue(options.edits);
  mockPrisma.project.findMany.mockResolvedValue([]);
}

function sqlFromQueryRawCall(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") {
        return arg;
      }
      if (Array.isArray(arg)) {
        return Array.from(arg as string[]).join(" ");
      }
      return "";
    })
    .join(" ");
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

  it("reconciles a partial structural refund to the pages actually delivered", async () => {
    primeWindow({
      edits: [
        {
          kind: "RESTRUCTURE_PAGES",
          affectedPageIndexes: [4, 5],
          project: { mediaSettings: null },
          ledgerEntry: {
            status: "SETTLED",
            amountCredits: -140,
            reversedByEntry: { amountCredits: 24 }
          }
        }
      ],
      chargedCredits: 140,
      refundedCredits: 24
    });

    const report = await loadPricingDrivers(resolveWindow(7), creditPricing());

    // Added pages are priced like a book: one 100 base plus 2 × 8 at balanced.
    expect(report.drivers.addedPagesBase).toBe(1);
    expect(report.drivers.fullBookPerPage).toBe(2);
    expect(report.drivers.pageRegenerationPerPage).toBe(0);
    expect(report.edits).toBe(1);
    expect(report.coverage).toMatchObject({
      chargedCredits: 116,
      modelledCredits: 116,
      accuracyPercent: 100
    });
  });

  it("buckets a continuation's appended pages at its tier's writing rate, plus one base", async () => {
    primeWindow({
      edits: [
        // Ten pages appended to a premium book: 100 + 10 × 30.
        { kind: "CONTINUE_BOOK", affectedPageIndexes: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21], project: { mediaSettings: { modelTier: "premium" } } },
        // A delete wrote nothing and was charged nothing.
        { kind: "RESTRUCTURE_PAGES", affectedPageIndexes: [], project: { mediaSettings: { modelTier: "premium" } } }
      ],
      chargedCredits: 400
    });

    const report = await loadPricingDrivers(resolveWindow(7), creditPricing());

    expect(report.drivers.addedPagesBase).toBe(1);
    expect(report.drivers.fullBookPerPagePremium).toBe(10);
    expect(report.drivers.pageRegenerationPerPagePremium).toBe(0);
    expect(report.coverage).toMatchObject({ chargedCredits: 400, modelledCredits: 400, accuracyPercent: 100 });
  });

  it("lets Postgres drop fully refunded charges instead of loading their ids", async () => {
    primeWindow({ edits: [], chargedCredits: 0 });

    const report = await loadPricingDrivers(resolveWindow(7), creditPricing());

    expect(report.drivers).not.toHaveProperty("exportUnlock");
    expect(report.drivers.audiobookBase).toBe(0);
    expect(mockPrisma.creditLedgerEntry.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.creditLedgerEntry.groupBy).not.toHaveBeenCalled();
    const sql = mockPrisma.$queryRaw.mock.calls.map((args) => sqlFromQueryRawCall(args as unknown[])).join("\n");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain('r."reversesEntryId" = e.id');
    expect(sql).toContain('r."amountCredits" >= ABS(e."amountCredits")');
  });

  it("counts ledger operations the spend query still returns after amount-aware filtering", async () => {
    primeWindow({ edits: [], chargedCredits: 80 });
    mockPrisma.$queryRaw.mockImplementation((...args: unknown[]) => {
      const sql = sqlFromQueryRawCall(args);
      if (sql.includes("AUDIOBOOK_GENERATION") && sql.includes("metadata")) {
        return Promise.resolve([{ metadata: { pageCount: 8 } }, { metadata: { pageCount: 4, wordCount: 1_801 } }]);
      }
      return Promise.resolve([
        { project_id: null, operation: "EXPORT_UNLOCK", count: 1 },
        { project_id: null, operation: "COVER_REGENERATION", count: 2 }
      ]);
    });

    const report = await loadPricingDrivers(resolveWindow(7), creditPricing());

    // An old standalone unlock is no price any more, so it drives nothing.
    expect(report.drivers).not.toHaveProperty("exportUnlock");
    expect(report.drivers.coverRegeneration).toBe(2);
    expect(report.drivers.audiobookBase).toBe(2);
    expect(report.drivers.audiobookPerPage).toBe(12);
    // Only the charge priced by the word drives the per-word rate: 1,801 words is 19 hundreds.
    expect(report.drivers.audiobookPer100Words).toBe(19);
  });

  it("counts no export unlock for a book, whatever its stored quote carried", async () => {
    // The unlock was retired on 2026-10-15 and is no price; a charge from
    // before, with the unlock in its quote, counts the book and nothing more.
    primeWindow({ edits: [], chargedCredits: 0 });
    mockPrisma.project.findMany.mockResolvedValue([
      {
        id: "book-1", title: "Rabbit", subtitle: null, authorName: null, coverTagline: null,
        prompt: "A bedtime story about a rabbit.", category: "STORY", subcategory: null, targetPages: 10,
        complexity: 3, temperature: 0.7, language: "en", mediaSettings: { fullIllustrations: false, coverArtSource: "design" }
      }
    ]);
    mockPrisma.$queryRaw.mockImplementation((...args: unknown[]) => {
      const sql = sqlFromQueryRawCall(args);
      if (sql.includes("AUDIOBOOK_GENERATION") && sql.includes("metadata")) return Promise.resolve([]);
      return Promise.resolve([
        { project_id: "book-1", operation: "FULL_BOOK_GENERATION", pricing_key: null, count: 3 },
        { project_id: "book-1", operation: "FULL_BOOK_GENERATION", pricing_key: null, count: 1 }
      ]);
    });

    const report = await loadPricingDrivers(resolveWindow(7), creditPricing());

    expect(report.drivers.fullBookBase).toBe(4);
    expect(report.drivers).not.toHaveProperty("exportUnlock");
    const sql = mockPrisma.$queryRaw.mock.calls.map((args) => sqlFromQueryRawCall(args as unknown[])).join("\n");
    expect(sql).not.toContain("includesExportUnlock");
  });

  it("counts a book's pictures off the quote its charge stored, and re-estimates only a charge with none", async () => {
    // A 16-page picture book charged under the rule before min(pages, 12) was
    // quoted eight pictures and a drawn cover; today's rule would draw six.
    primeWindow({ edits: [], chargedCredits: 0 });
    mockPrisma.project.findMany.mockResolvedValue([
      {
        id: "kids-1", title: "Moon Rabbit", subtitle: null, authorName: null, coverTagline: null,
        prompt: "A bedtime story about a rabbit who is afraid of the dark.", category: "KIDS", subcategory: null,
        targetPages: 16, complexity: 3, temperature: 0.7, language: "en",
        mediaSettings: {
          fullIllustrations: true,
          illustrationCadence: "template-driven",
          coverArtSource: "ai",
          mobile: { bookType: "short_story", bookTypeChoice: "children_story" }
        }
      }
    ]);
    mockPrisma.$queryRaw.mockImplementation((...args: unknown[]) => {
      const sql = sqlFromQueryRawCall(args);
      if (sql.includes("AUDIOBOOK_GENERATION") && sql.includes("metadata")) return Promise.resolve([]);
      return Promise.resolve([
        {
          project_id: "kids-1", operation: "FULL_BOOK_GENERATION", pricing_key: null, export_unlock: "false",
          quoted_interior_images: "8", quoted_cover: "true", count: 2
        },
        // An older charge with no quote at all: today's estimate, 6 pictures and the cover.
        { project_id: "kids-1", operation: "FULL_BOOK_GENERATION", pricing_key: null, export_unlock: null, count: 1 }
      ]);
    });

    const report = await loadPricingDrivers(resolveWindow(7), creditPricing());

    expect(report.drivers.fullBookBase).toBe(3);
    expect(report.drivers.imageGeneration).toBe(2 * (8 + 1) + 1 * (6 + 1));
    const sql = mockPrisma.$queryRaw.mock.calls.map((args) => sqlFromQueryRawCall(args as unknown[])).join("\n");
    expect(sql).toContain("{creditEstimate,assumptions,estimatedInteriorImages}");
    expect(sql).toContain("{creditEstimate,assumptions,includesCover}");
  });

  it("counts a stamped plan revision at its tier and an unstamped one at the old flat rate", async () => {
    primeWindow({ edits: [], chargedCredits: 80 });
    mockPrisma.$queryRaw.mockImplementation((...args: unknown[]) => {
      const sql = sqlFromQueryRawCall(args);
      if (sql.includes("AUDIOBOOK_GENERATION") && sql.includes("metadata")) return Promise.resolve([]);
      return Promise.resolve([
        { project_id: "fast-book", operation: "PLAN_REVISION", count: 3, pricing_key: "planRevisionFast" },
        { project_id: "old-book", operation: "PLAN_REVISION", count: 2, pricing_key: null }
      ]);
    });

    const report = await loadPricingDrivers(resolveWindow(7), creditPricing());

    expect(report.drivers.planRevisionFast).toBe(3);
    expect(report.drivers.planRevision).toBe(2);
  });
});
