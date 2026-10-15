import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("../testing/mobileApiMocks.js")).dbModuleMock());

import { mockPrisma, resetMobileHarness, teardownMobileHarness } from "../testing/mobileApiHarness.js";
import { MockPrismaKnownRequestError } from "../testing/mobileApiMocks.js";
import { installShareStore, seedShare, type ShareStore } from "../testing/shareTestSupport.js";
import { writeShare, type ShareWrite } from "./shareRecords.js";

const write: ShareWrite = {
  userId: "user-a",
  projectId: "project-1",
  projectTitle: "The Lighthouse Cat",
  mode: "PREVIEW",
  previewPages: 2,
  showAuthorName: false,
  caption: {
    caption: "For my niece.",
    captionStatus: "PENDING_REVIEW",
    captionVerdict: { verdict: "undecided" },
    fileReview: true
  },
  confirmRights: true,
  confirmLikeness: false
};

let store: ShareStore;

beforeEach(() => {
  resetMobileHarness();
  store = installShareStore();
});
afterEach(teardownMobileHarness);

describe("share write takedown protection", () => {
  it("refuses a taken-down share independently of the route preflight", async () => {
    const original = { ...seedShare(store, { status: "TAKEN_DOWN", takedownReason: "Copyrighted text" }) };

    await expect(writeShare(write)).rejects.toMatchObject({ code: "SHARE_TAKEN_DOWN" });

    expect(store.shares).toEqual([original]);
    expect(store.slugs).toEqual([original.slug]);
    expect(store.reports).toEqual([]);
    expect(mockPrisma.bookShare.update).not.toHaveBeenCalled();
    expect(mockPrisma.shareSlug.create).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
  });

  it.each(["ACTIVE", "REVOKED"])("locks before reading an %s share and observes an operator's commit while waiting", async (status) => {
    const row = seedShare(store, { status });
    const slug = row.slug;
    const findUnique = mockPrisma.bookShare.findUnique.getMockImplementation()!;
    let locked = false;
    const accountLock = vi.fn(async () => [{ status: "ACTIVE", sharingDisabledAt: null }]);
    const lock = vi.fn(async (strings: readonly string[], ...values: unknown[]) => {
      if (strings.join("?").includes('FROM "User"')) return accountLock();
      expect(strings.join("?").replace(/\s+/g, " ").trim()).toBe(
        'SELECT "id" FROM "BookShare" WHERE "projectId" = ? FOR UPDATE'
      );
      expect(values).toEqual(["project-1"]);
      // The admin UPDATE holds the same row lock. It commits before this
      // SELECT FOR UPDATE resolves; an earlier snapshot would miss it.
      await Promise.resolve();
      row.status = "TAKEN_DOWN";
      row.takedownReason = "Copyrighted text";
      locked = true;
      return [{ id: row.id }];
    });
    const authoritativeRead = vi.fn(async (...args: unknown[]) => {
      expect(locked, "the transaction must await its BookShare lock before reading").toBe(true);
      return findUnique(...args);
    });
    const runTransaction = mockPrisma.$transaction.getMockImplementation()!;
    mockPrisma.$transaction.mockImplementation((operation, options) => runTransaction(async (tx: typeof mockPrisma) =>
      operation({ ...tx, $queryRaw: lock, bookShare: { ...tx.bookShare, findUnique: authoritativeRead } }), options
    ));

    await expect(writeShare(write)).rejects.toMatchObject({ code: "SHARE_TAKEN_DOWN" });

    // The account row first, then the share row, then the read.
    expect(accountLock).toHaveBeenCalledOnce();
    expect(lock).toHaveBeenCalledTimes(2);
    expect(authoritativeRead).toHaveBeenCalledOnce();
    expect(accountLock.mock.invocationCallOrder[0]!).toBeLessThan(lock.mock.invocationCallOrder[1]!);
    expect(lock.mock.invocationCallOrder[1]!).toBeLessThan(authoritativeRead.mock.invocationCallOrder[0]!);
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(store.shares[0]).toMatchObject({ slug, status: "TAKEN_DOWN", takedownReason: "Copyrighted text", caption: null });
    expect(store.slugs).toEqual([slug]);
    expect(store.reports).toEqual([]);
    expect(mockPrisma.bookShare.update).not.toHaveBeenCalled();
    expect(mockPrisma.shareSlug.create).not.toHaveBeenCalled();
  });

  it.each(["ACTIVE", "TAKEN_DOWN"])("retries a concurrent create and locks its %s winner before deciding", async (status) => {
    // A missing row cannot be locked. Another creator commits immediately
    // after that SELECT, before this writer can insert its own share.
    const queryRaw = mockPrisma.$queryRaw.getMockImplementation()!;
    let shareLocks = 0;
    mockPrisma.$queryRaw.mockImplementation(async (strings: readonly string[], ...values: unknown[]) => {
      if (strings.join("?").includes('FROM "BookShare"') && (shareLocks += 1) === 1) {
        seedShare(store, { status, takedownReason: status === "TAKEN_DOWN" ? "Copyrighted text" : null });
        return [];
      }
      return queryRaw(strings, ...values);
    });
    const create = mockPrisma.bookShare.create.getMockImplementation()!;
    mockPrisma.bookShare.create.mockImplementationOnce(async (args) => {
      try {
        return await create(args);
      } catch (error) {
        // The array store does not roll back: remove only this failed
        // transaction's reserved slug, preserving the concurrent creator's.
        store.slugs.splice(store.slugs.indexOf(args.data.slug), 1);
        throw error;
      }
    });

    const result = writeShare(write);
    if (status === "TAKEN_DOWN") {
      await expect(result).rejects.toMatchObject({ code: "SHARE_TAKEN_DOWN" });
      expect(store.shares[0]).toMatchObject({ status, takedownReason: "Copyrighted text", caption: null });
      expect(store.reports).toEqual([]);
      expect(mockPrisma.bookShare.update).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toMatchObject({ status, slug: "Seeded0Slug1", caption: "For my niece." });
      expect(store.reports).toHaveLength(1);
    }
    expect(store.slugs).toEqual(["Seeded0Slug1"]);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    // Each attempt locks the account row, then the share row.
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(4);
    expect(shareLocks).toBe(2);
    expect(mockPrisma.bookShare.create).toHaveBeenCalledOnce();
    expect(mockPrisma.bookShare.findUnique).toHaveBeenCalledOnce();
    expect(mockPrisma.$queryRaw.mock.invocationCallOrder[3]!).toBeLessThan(mockPrisma.bookShare.findUnique.mock.invocationCallOrder[0]!);
  });

  it.each([
    ["sharing turned off", { status: "ACTIVE", sharingDisabledAt: new Date("2026-10-13T10:00:00.000Z") }],
    ["suspended", { status: "SUSPENDED", sharingDisabledAt: null }]
  ])("refuses an account with %s under the user-row lock, writing nothing", async (_label, account) => {
    const queryRaw = mockPrisma.$queryRaw.getMockImplementation()!;
    const statements: string[] = [];
    mockPrisma.$queryRaw.mockImplementation(async (strings: readonly string[], ...values: unknown[]) => {
      const sql = strings.join("?").replace(/\s+/g, " ").trim();
      statements.push(sql);
      if (sql.includes('FROM "User"')) {
        expect(values).toEqual(["user-a"]);
        return [account];
      }
      return queryRaw(strings, ...values);
    });

    await expect(writeShare(write)).rejects.toMatchObject({ code: "SHARING_DISABLED" });

    expect(statements).toEqual(['SELECT "status"::text AS "status", "sharingDisabledAt" FROM "User" WHERE "id" = ? FOR SHARE']);
    expect(store.shares).toEqual([]);
    expect(store.slugs).toEqual([]);
    expect(store.reports).toEqual([]);
  });

  it("still retries a slug collision and files the held note's review once", async () => {
    mockPrisma.shareSlug.create.mockRejectedValueOnce(new MockPrismaKnownRequestError("Slug collision", { code: "P2002" }));

    const share = await writeShare(write);

    expect(share).toMatchObject({ status: "ACTIVE", captionStatus: "PENDING_REVIEW" });
    expect(store.slugs).toEqual([share.slug]);
    expect(store.shares).toHaveLength(1);
    expect(store.reports).toHaveLength(1);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
