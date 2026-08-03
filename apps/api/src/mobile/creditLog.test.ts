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
