import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

// A transaction-local schema keeps this migration test away from app tables.
// PAYMENT_TEST_DATABASE_URL is explicitly a test DB; ordinary DATABASE_URL is ignored.
const client = new Client({ connectionString: process.env.PAYMENT_TEST_DATABASE_URL ??
  "postgresql://bookmaker:bookmaker@localhost:55432/bookmaker" });

beforeAll(async () => {
  await client.connect();
  await client.query("BEGIN");
  const schema = `payments_${randomUUID().replaceAll("-", "")}`;
  await client.query(`CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE "User" (id TEXT PRIMARY KEY);
    CREATE TABLE "PurchaseRecord" (
      id TEXT PRIMARY KEY, "userId" TEXT, provider TEXT, "externalPurchaseId" TEXT,
      "purchaseTokenHash" TEXT, status TEXT, "amountMicros" BIGINT, currency TEXT,
      "purchasedAt" TIMESTAMP(3), "verifiedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3), metadata JSONB
    );
    CREATE TABLE "CreditLedgerEntry" (
      id TEXT PRIMARY KEY, "purchaseRecordId" TEXT, "idempotencyKey" TEXT, metadata JSONB,
      operation TEXT, "entryType" TEXT, status TEXT, "createdAt" TIMESTAMP(3)
    );
    CREATE TABLE "GooglePlayRefund" (
      "purchaseTokenHash" TEXT, "orderId" TEXT, "productType" INT, "refundableQuantity" INT, quantity INT
    );
    INSERT INTO "User" VALUES ('reader');
    INSERT INTO "PurchaseRecord" VALUES
      ('sub', 'reader', 'GOOGLE_PLAY', 'order-12', 'sub-token', 'FAILED', 19990000, 'USD',
       '2026-10-04', '2027-01-04', '2026-10-04', '{"purchaseKind":"subscription"}'),
      ('pack', 'reader', 'GOOGLE_PLAY', 'pack-order', 'pack-token', 'GRANTED', 9990000, 'USD',
       '2026-10-09', '2026-10-09', '2026-10-09', '{"purchaseKind":"one_time","quantity":3}'),
      ('pending', 'reader', 'GOOGLE_PLAY', 'pending-order', 'pending-token', 'PENDING', 9990000, 'USD',
       '2026-10-09', '2026-10-09', '2026-10-09', '{"purchaseKind":"one_time"}'),
      ('zero-credit', 'reader', 'GOOGLE_PLAY', 'zero-order', 'zero-token', 'GRANTED', 1000000, 'USD',
       '2026-10-10', '2026-10-10', '2026-10-10', '{"purchaseKind":"one_time"}');
    INSERT INTO "CreditLedgerEntry"
      SELECT 'grant-' || month, 'sub', 'google-play:subscription:sub-token:order-' || month,
        jsonb_build_object('externalPurchaseId', 'order-' || month),
        'SUBSCRIPTION_CREDIT_GRANT', 'GRANT', 'SETTLED', ('2026-' || month || '-04')::timestamp
      FROM generate_series(10, 12) month;
    INSERT INTO "CreditLedgerEntry" VALUES
      ('pack-grant', 'pack', 'google-play:purchase:pack-token:credits', '{"externalPurchaseId":"pack-order"}',
       'PURCHASE_CREDIT_GRANT', 'GRANT', 'SETTLED', '2026-10-09');
    INSERT INTO "GooglePlayRefund" VALUES ('sub-token', 'order-10', 1, 0, NULL), ('pack-token', 'pack-order', 2, 2, 3);
  `);
  const migration = await readFile(new URL("../prisma/migrations/000093_purchase_payments/migration.sql", import.meta.url), "utf8");
  await client.query(migration);
});
afterAll(async () => {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
});

it("backfills all expired subscription orders with their original grant dates and refunds", async () => {
  const { rows } = await client.query(`SELECT "orderId", "amountMicros"::text, "refundedAmountMicros"::text,
    to_char("paidAt", 'YYYY-MM-DD') AS day, "amountSource" FROM "PurchasePayment" WHERE "purchaseRecordId" = 'sub' ORDER BY "paidAt"`);
  expect(rows).toEqual([10, 11, 12].map((month) => ({ orderId: `order-${month}`, amountMicros: "19990000",
    refundedAmountMicros: month === 10 ? "19990000" : "0", day: `2026-${month}-04`, amountSource: "legacy_catalog_estimate" })));
});

it("backfills one-time quantities once, preserves zero-credit sales, and excludes pending attempts", async () => {
  const { rows } = await client.query(`SELECT "purchaseRecordId", "amountMicros"::text, "refundedAmountMicros"::text
    FROM "PurchasePayment" WHERE "purchaseRecordId" <> 'sub' ORDER BY "purchaseRecordId"`);
  expect(rows).toEqual([
    { purchaseRecordId: "pack", amountMicros: "29970000", refundedAmountMicros: "9990000" },
    { purchaseRecordId: "zero-credit", amountMicros: "1000000", refundedAmountMicros: "0" }
  ]);
});

it("prevents duplicate order keys on PostgreSQL without changing the historical amount", async () => {
  await client.query(`INSERT INTO "PurchasePayment" (id, "userId", "purchaseRecordId", "idempotencyKey", "amountMicros", currency, "paidAt")
    VALUES ('duplicate', 'reader', 'sub', 'google-play:subscription:sub-token:order-12', 1, 'USD', now())
    ON CONFLICT ("idempotencyKey") DO NOTHING`);
  const { rows } = await client.query(`SELECT count(*)::int AS count, SUM("amountMicros")::text AS gross
    FROM "PurchasePayment" WHERE "purchaseRecordId" = 'sub'`);
  expect(rows).toEqual([{ count: 3, gross: "59970000" }]);
});
