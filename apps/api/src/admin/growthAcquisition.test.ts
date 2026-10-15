import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({ $queryRaw: vi.fn() }));
vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));

import { loadCheckoutFunnel, loadInstallSources } from "./growthAcquisition.js";

const window = { days: 30, since: new Date("2026-09-13T00:00:00Z"), until: new Date("2026-10-13T00:00:00Z") };
const sqlOf = (call: unknown[] | undefined) => Array.from((call?.[0] ?? []) as readonly string[]).join("?");

beforeEach(() => {
  mockPrisma.$queryRaw.mockReset();
});

describe("install sources", () => {
  it("merges install reports with first-touch readers per source and medium", async () => {
    mockPrisma.$queryRaw.mockImplementation(async (strings: readonly string[]) => {
      const sql = Array.from(strings).join("?");
      if (sql.includes("DISTINCT ON")) {
        return [
          { source: "share", medium: "none", readers: 3n, new_accounts: 2n, from_shares: 3n, paid: 1n },
          { source: "google-play", medium: "organic", readers: 5n, new_accounts: 5n, from_shares: 0n, paid: 0n }
        ];
      }
      return [
        { source: "share", medium: "none", installs: 4n },
        { source: "google-play", medium: "organic", installs: 6n },
        { source: null, medium: null, installs: 1n }
      ];
    });

    expect(await loadInstallSources(window)).toEqual([
      { source: "google-play", medium: "organic", installs: 6, readers: 5, newAccounts: 5, fromShares: 0, paid: 0 },
      { source: "share", medium: "none", installs: 4, readers: 3, newAccounts: 2, fromShares: 3, paid: 1 },
      { source: "unknown", medium: "none", installs: 1, readers: 0, newAccounts: 0, fromShares: 0, paid: 0 }
    ]);
    const firstTouch = mockPrisma.$queryRaw.mock.calls.find((call) => sqlOf(call).includes("DISTINCT ON"));
    // First touch is the reader's earliest report ever, kept when it falls in the window.
    expect(sqlOf(firstTouch)).toContain('e."createdAt" <= ?');
    expect(sqlOf(firstTouch)).toContain('WHERE f."createdAt" >= ?');
    expect(firstTouch).toContain("local-admin");
  });
});

describe("checkout funnel", () => {
  it("counts starts, cancels and failures per product and only closed-list reasons and surfaces", async () => {
    mockPrisma.$queryRaw.mockImplementation(async (strings: readonly string[]) => {
      const sql = Array.from(strings).join("?");
      if (sql.includes("WITH starts")) {
        return [{ sku: "tomeza.creator_monthly", starters: 4n, paid: 2n }];
      }
      return [
        { name: "purchase_started", sku: "tomeza.creator_monthly", reason: null, surface: "export", intro: "true", events: 3n },
        { name: "purchase_started", sku: "tomeza.creator_monthly", reason: null, surface: "made_up", intro: "false", events: 2n },
        { name: "purchase_started", sku: "tomeza.credit_pack_1", reason: null, surface: "credits_needed", intro: "false", events: 1n },
        { name: "purchase_cancelled", sku: "tomeza.creator_monthly", reason: null, surface: null, intro: null, events: 2n },
        { name: "purchase_failed", sku: "tomeza.creator_monthly", reason: "play_error", surface: null, intro: null, events: 1n },
        { name: "purchase_failed", sku: "tomeza.credit_pack_1", reason: "something new", surface: null, intro: null, events: 1n }
      ];
    });

    const funnel = await loadCheckoutFunnel(window);

    expect(funnel.bySku).toEqual([
      { sku: "tomeza.creator_monthly", started: 5, introStarted: 3, cancelled: 2, failed: 1, starters: 4, paidWithin1Day: 2 },
      { sku: "tomeza.credit_pack_1", started: 1, introStarted: 0, cancelled: 0, failed: 1, starters: 0, paidWithin1Day: 0 }
    ]);
    expect(funnel.failures).toEqual([
      { reason: "play_error", events: 1 },
      { reason: "other", events: 1 }
    ]);
    expect(funnel.bySurface).toEqual([
      { surface: "export", started: 3 },
      { surface: "other", started: 2 },
      { surface: "credits_needed", started: 1 }
    ]);
  });
});
