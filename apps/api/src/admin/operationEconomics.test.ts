import { describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  creditLedgerEntry: { groupBy: vi.fn() },
  $queryRaw: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ Prisma: { raw: (sql: string) => sql }, prisma: mockPrisma }));
vi.mock("@book-maker/db/billing", async () => (await import("../mobile/testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("../mobile/testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("../mobile/testing/mobileApiMocks.js")).projectStatusModuleMock());

import { type BookEditIntentKind } from "../bookEditIntent.js";
import { APPLY_BOOK_EDIT_OPERATION_SQL } from "./operationEconomics.js";

/**
 * The operation each edit an `APPLY_BOOK_EDIT` job can carry is charged under.
 *
 * Written out rather than derived from `billingOperationForIntent`, which is
 * what the SQL arm is generated from: a test that recomputes the same call
 * proves nothing. This table is the second opinion, so re-pricing an edit
 * fails here until someone has decided what the Operations tab should do with
 * the spend that moves.
 */
const EXPECTED: ReadonlyArray<[BookEditIntentKind, string]> = [
  // Free, and free either way: a verified exact replacement writes no ledger
  // entry, and the model calls its story-state pass still makes belong here.
  ["local_patch", "BOOK_TEXT_EDIT"],
  ["page_rewrite", "PAGE_REGENERATION"],
  ["chapter_regenerate", "PAGE_REGENERATION"],
  ["add_image", "IMAGE_GENERATION"],
  // Moving and removing a picture are free and call no provider at all, so
  // BOOK_TEXT_EDIT here attributes nothing; it is what the price list names.
  ["move_image", "BOOK_TEXT_EDIT"],
  ["remove_image", "BOOK_TEXT_EDIT"],
  // The finding: an insert is billed as page regeneration, so answering
  // BOOK_TEXT_EDIT made the gated project_operation join miss its own charge.
  ["restructure_pages", "PAGE_REGENERATION"]
];

describe("APPLY_BOOK_EDIT_OPERATION_SQL", () => {
  it("maps every intent kind an Apply can enqueue to the operation it is charged under", () => {
    for (const [kind, operation] of EXPECTED) {
      expect(APPLY_BOOK_EDIT_OPERATION_SQL).toContain(`WHEN '${kind}' THEN '${operation}'`);
    }
  });

  it("names each kind exactly once, so no earlier arm shadows a later one", () => {
    for (const [kind] of EXPECTED) {
      const arms = APPLY_BOOK_EDIT_OPERATION_SQL.match(new RegExp(`WHEN '${kind}' THEN`, "g")) ?? [];
      expect(arms).toHaveLength(1);
    }
    expect(APPLY_BOOK_EDIT_OPERATION_SQL.match(/WHEN '/g) ?? []).toHaveLength(EXPECTED.length);
  });

  it("keeps the text-edit answer for a job enqueued before intentKind existed", () => {
    // A payload with no `intentKind` makes `->>` return NULL, which no WHEN of
    // a simple CASE matches, so those rows resolve exactly as they always have.
    expect(APPLY_BOOK_EDIT_OPERATION_SQL).toContain("ELSE 'BOOK_TEXT_EDIT'");
    expect(APPLY_BOOK_EDIT_OPERATION_SQL.startsWith("CASE j.payload ->> 'intentKind'")).toBe(true);
    expect(APPLY_BOOK_EDIT_OPERATION_SQL.trimEnd().endsWith("END")).toBe(true);
  });
});
