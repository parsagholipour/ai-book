import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

type LedgerRowOverrides = {
  id?: string;
  entryType?: string;
  status?: string;
  operation?: string;
  amountCredits?: number;
  createdAt?: Date;
  projectId?: string | null;
  project?: { title: string } | null;
  description?: string | null;
  metadata?: unknown;
  reversesEntry?: { metadata: unknown } | null;
};

function ledgerRow(overrides: LedgerRowOverrides = {}) {
  return {
    id: "ledger-1",
    entryType: "SPEND",
    status: "SETTLED",
    operation: "FULL_BOOK_GENERATION",
    amountCredits: -430,
    createdAt: new Date("2026-06-15T12:00:00.000Z"),
    projectId: "project-a",
    project: { title: "The Moon Rabbit" },
    ...overrides
  };
}

describe("mobile credit log", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("tells the reader what each entry was, in words the ledger never stores", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.creditLedgerEntry.findMany.mockResolvedValueOnce([
      ledgerRow({ id: "purchase", entryType: "GRANT", operation: "PURCHASE_CREDIT_GRANT", amountCredits: 1000, projectId: null, project: null }),
      ledgerRow({ id: "monthly", entryType: "GRANT", operation: "PLAN_ALLOWANCE_GRANT", amountCredits: 500, projectId: null, project: null }),
      ledgerRow({ id: "welcome", entryType: "GRANT", operation: "WELCOME_GRANT", amountCredits: 1000, projectId: null, project: null }),
      ledgerRow({ id: "spend" }),
      ledgerRow({ id: "audiobook", operation: "AUDIOBOOK_GENERATION", status: "RESERVED", entryType: "RESERVE", amountCredits: -120 }),
      // A released hold is the same row mutated: still negative, but given back.
      ledgerRow({
        id: "released",
        entryType: "RELEASE",
        status: "REFUNDED",
        operation: "BOOK_TEXT_EDIT",
        amountCredits: -80,
        description: "TypeError: Cannot read properties of undefined (reading 'model')"
      }),
      // A settled charge refunded later is a second, positive row.
      ledgerRow({ id: "refund", entryType: "REFUND", operation: "IMAGE_GENERATION", amountCredits: 45 }),
      ledgerRow({
        id: "expired",
        entryType: "ADJUSTMENT",
        operation: "PLAN_ALLOWANCE_GRANT",
        amountCredits: -60,
        projectId: null,
        project: null
      })
    ]);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/billing/credit-log",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.creditLedgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-a" } })
    );
    expect(body.log.entries).toEqual([
      expect.objectContaining({ id: "purchase", direction: "in", credits: 1000, kind: "purchase", title: "Credits purchased" }),
      expect.objectContaining({ id: "monthly", direction: "in", credits: 500, kind: "monthly", title: "Monthly credits" }),
      expect.objectContaining({ id: "welcome", direction: "in", credits: 1000, kind: "bonus", title: "Welcome credits" }),
      expect.objectContaining({
        id: "spend",
        direction: "out",
        credits: 430,
        kind: "spend",
        title: "Book generation",
        pending: false,
        refunded: false,
        projectTitle: "The Moon Rabbit"
      }),
      // A hold has already left the balance, so it is a charge — just not a
      // settled one. Hiding it would leave a dip no line explains.
      expect.objectContaining({ id: "audiobook", direction: "out", credits: 120, title: "Audiobook", pending: true }),
      expect.objectContaining({ id: "released", direction: "out", credits: 80, title: "Book edit", refunded: true }),
      expect.objectContaining({ id: "refund", direction: "in", credits: 45, kind: "refund", title: "Illustration refunded" }),
      expect.objectContaining({ id: "expired", direction: "out", credits: 60, kind: "expired", title: "Unused monthly credits expired" })
    ]);
    // Refund reasons are worker error text. They never reach the app.
    expect(JSON.stringify(body)).not.toMatch(/TypeError|description|provider|model/);
    await app.close();
  });

  it("still titles an export unlock bought before downloads became free", async () => {
    // No new EXPORT_UNLOCK row is written since 2026-10-15, but a reader's
    // history keeps the ones they paid for, in words.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.creditLedgerEntry.findMany.mockResolvedValueOnce([
      ledgerRow({ id: "unlock", operation: "EXPORT_UNLOCK", amountCredits: -150 })
    ]);
    const app = await buildMobileApp();

    const body = (
      await app.inject({ method: "GET", url: "/api/mobile/billing/credit-log", headers: bearer("token-a") })
    ).json();

    expect(body.log.entries).toEqual([
      expect.objectContaining({ id: "unlock", direction: "out", credits: 150, title: "Export unlock" })
    ]);
    await app.close();
  });

  it("shows a store refund as credits taken back instead of an expired allowance", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.creditLedgerEntry.findMany.mockResolvedValueOnce([
      ledgerRow({ entryType: "ADJUSTMENT", operation: "PURCHASE_CREDIT_GRANT", amountCredits: -1000,
        reversesEntry: { metadata: {} } })
    ]);
    const app = await buildMobileApp();
    const response = await app.inject({ method: "GET", url: "/api/mobile/billing/credit-log", headers: bearer("token-a") });
    expect(response.json().log.entries[0]).toMatchObject({ direction: "out", credits: 1000,
      kind: "spend", title: "Credits reversed after Google Play refund" });
    await app.close();
  });

  it("says a stopped book returned only its unused credits, and that an ended month's share expired", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const stopped = { userStopSettlement: { claimKey: "user-stop:attempt-1", chargedCredits: 1000, keptCredits: 425 } };
    mockPrisma.creditLedgerEntry.findMany.mockResolvedValueOnce([
      ledgerRow({ id: "lapsed", entryType: "ADJUSTMENT", operation: "PLAN_ALLOWANCE_GRANT", amountCredits: -175,
        metadata: { expiredPlanPeriodKey: "sub:hash:2026-07-01", lapsedRefundOfEntryId: "charge" } }),
      ledgerRow({ id: "returned", entryType: "REFUND", amountCredits: 575, reversesEntry: { metadata: stopped } }),
      ledgerRow({ id: "failed", entryType: "REFUND", amountCredits: 430, reversesEntry: { metadata: {} } }),
      ledgerRow({ id: "boundary", entryType: "ADJUSTMENT", operation: "PLAN_ALLOWANCE_GRANT", amountCredits: -90,
        projectId: null, project: null, metadata: { expiredPlanPeriodKey: "sub:hash:2026-07-01" } })
    ]);
    const app = await buildMobileApp();
    const response = await app.inject({ method: "GET", url: "/api/mobile/billing/credit-log", headers: bearer("token-a") });
    expect(response.json().log.entries).toEqual([
      expect.objectContaining({ id: "lapsed", direction: "out", credits: 175, kind: "expired",
        title: "Returned monthly credits expired" }),
      expect.objectContaining({ id: "returned", direction: "in", credits: 575, kind: "refund",
        title: "Book generation stopped: unused credits returned" }),
      // A failure the reader did not cause still reads as a whole refund.
      expect.objectContaining({ id: "failed", kind: "refund", title: "Book generation refunded" }),
      expect.objectContaining({ id: "boundary", kind: "expired", title: "Unused monthly credits expired" })
    ]);
    await app.close();
  });

  it("explains a refund debt paid from monthly credits without counting the refund twice", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.creditLedgerEntry.findMany.mockResolvedValueOnce([
      ledgerRow({ id: "settled", entryType: "ADJUSTMENT", operation: "SUBSCRIPTION_CREDIT_GRANT", amountCredits: 0,
        projectId: null, project: null,
        metadata: { planDebtSettlement: { source: "allowance", credits: 6000, planPeriodKey: "sub:hash:2026-12-01" } } }),
      ledgerRow({ id: "renewal", entryType: "GRANT", operation: "SUBSCRIPTION_CREDIT_GRANT", amountCredits: 6000,
        projectId: null, project: null })
    ]);
    const app = await buildMobileApp();
    const response = await app.inject({ method: "GET", url: "/api/mobile/billing/credit-log", headers: bearer("token-a") });
    // The refund's own line already took the credits; this one only says why
    // the monthly meter reads short, so it moves the total by nothing.
    expect(response.json().log.entries).toEqual([
      expect.objectContaining({ id: "settled", direction: "in", credits: 0, kind: "monthly",
        title: "Refunded purchase settled with 6,000 monthly credits", pending: false, refunded: false }),
      expect.objectContaining({ id: "renewal", direction: "in", credits: 6000, kind: "subscription" })
    ]);
    await app.close();
  });

  it("names a per-page charge by what it bought, not by the rate it was billed at", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const insert = { intent: { kind: "restructure_pages", structuralEdit: { action: "insert" } }, pagesBilled: 1 };
    mockPrisma.creditLedgerEntry.findMany.mockResolvedValueOnce([
      ledgerRow({ id: "insert", operation: "PAGE_REGENERATION", amountCredits: -40, metadata: insert }),
      // A refund records why it happened, not what it reversed; the charge it reverses says that.
      ledgerRow({
        id: "insert-refund",
        entryType: "REFUND",
        operation: "PAGE_REGENERATION",
        amountCredits: 40,
        metadata: { reason: "That change couldn’t be applied." },
        reversesEntry: { metadata: insert }
      }),
      ledgerRow({
        id: "continue",
        operation: "PAGE_REGENERATION",
        amountCredits: -120,
        metadata: { intent: { kind: "continue_book" }, chapterCount: 1, newPageCount: 3 }
      }),
      ledgerRow({ id: "chapter", operation: "PAGE_REGENERATION", amountCredits: -90, metadata: { intent: { kind: "chapter_regenerate" } } }),
      ledgerRow({ id: "rewrite", operation: "PAGE_REGENERATION", amountCredits: -50, metadata: { intent: { kind: "page_rewrite" } } }),
      ledgerRow({ id: "notes", operation: "BOOK_TEXT_EDIT", amountCredits: -30, metadata: { writingAssist: "chapter_feedback" } }),
      // The retry lane re-runs an operation and records only its id.
      ledgerRow({ id: "retry", operation: "PAGE_REGENERATION", amountCredits: -40, metadata: { operationId: "op-insert", planId: "plan-1" } }),
      ledgerRow({ id: "plain", operation: "PAGE_REGENERATION", amountCredits: -40 })
    ]);
    mockPrisma.bookEditOperation.findMany.mockResolvedValueOnce([{ id: "op-insert", kind: "RESTRUCTURE_PAGES" }]);
    const app = await buildMobileApp();

    const body = (await app.inject({ method: "GET", url: "/api/mobile/billing/credit-log", headers: bearer("token-a") })).json();

    expect(body.log.entries.map((entry: { id: string; title: string }) => [entry.id, entry.title])).toEqual([
      ["insert", "New page"],
      ["insert-refund", "New page refunded"],
      ["continue", "New chapter"],
      ["chapter", "Chapter rewrite"],
      ["rewrite", "Page rewrite"],
      ["notes", "Chapter notes"],
      ["retry", "New pages"],
      ["plain", "Page rewrite"]
    ]);
    expect(mockPrisma.bookEditOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["op-insert"] } } })
    );
    await app.close();
  });

  it("pages by entry id and stops when the history runs out", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.creditLedgerEntry.findMany.mockResolvedValueOnce([
      ledgerRow({ id: "entry-1" }),
      ledgerRow({ id: "entry-2" }),
      // The extra row only answers "is there more" — it is not part of the page.
      ledgerRow({ id: "entry-3" })
    ]);
    const app = await buildMobileApp();

    const first = (
      await app.inject({
        method: "GET",
        url: "/api/mobile/billing/credit-log?limit=2",
        headers: bearer("token-a")
      })
    ).json();

    expect(mockPrisma.creditLedgerEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
    expect(first.log.entries.map((entry: { id: string }) => entry.id)).toEqual(["entry-1", "entry-2"]);
    expect(first.log.nextCursor).toBe("entry-2");

    mockPrisma.creditLedgerEntry.findMany.mockResolvedValueOnce([ledgerRow({ id: "entry-3" })]);
    const second = (
      await app.inject({
        method: "GET",
        url: "/api/mobile/billing/credit-log?limit=2&cursor=entry-2",
        headers: bearer("token-a")
      })
    ).json();

    expect(mockPrisma.creditLedgerEntry.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: { id: "entry-2" }, skip: 1 })
    );
    expect(second.log.entries.map((entry: { id: string }) => entry.id)).toEqual(["entry-3"]);
    expect(second.log.nextCursor).toBeNull();
    await app.close();
  });

  it("rejects an unusable page size instead of guessing one", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/billing/credit-log?limit=5000",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(mockPrisma.creditLedgerEntry.findMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("needs a session — credit history is per user", async () => {
    const app = await buildMobileApp();

    const response = await app.inject({ method: "GET", url: "/api/mobile/billing/credit-log" });

    expect(response.statusCode).toBe(401);
    expect(mockPrisma.creditLedgerEntry.findMany).not.toHaveBeenCalled();
    await app.close();
  });
});
