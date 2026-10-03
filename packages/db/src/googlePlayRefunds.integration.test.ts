import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CREDIT_COSTS, setCreditPricing } from "@book-maker/core";
import { prisma } from "./client.ts";
import { hashPurchaseToken, recordGooglePlayRefund, recordVerifiedGooglePlayPurchase, spendCredits } from "./billing.ts";

// Run with DB_INTEGRATION=true against a database migrated through 000090.
// Uses only random fixture IDs and cleans up those rows afterwards.
const fixture = `refund-test-${randomUUID()}`;
let userId: string;
const userIds: string[] = [];
const sku = `${fixture}-credits`;
const tokens: string[] = [];
function purchase() {
  const token = `${fixture}-${tokens.length}`;
  tokens.push(token);
  return { productSku: sku, purchaseToken: token, externalPurchaseId: `GPA.${token}`,
    kind: "one_time" as const, grantable: true, providerStatus: "PURCHASED", quantity: 1 };
}

describe.skipIf(process.env.DB_INTEGRATION !== "true")("Google Play refunds on PostgreSQL", () => {
  beforeAll(async () => {
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 0, freeMonthlyCredits: 0 });
    await prisma.productCatalog.create({ data: { sku, title: "Refund test", productType: "CREDIT_PACK",
      creditAmount: 1000, priceMicros: 1000000n, metadata: {} } });
  });
  beforeEach(async () => {
    userId = `${fixture}-user-${userIds.length}`;
    userIds.push(userId);
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test` } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.productCatalog.deleteMany({ where: { sku } });
    await prisma.googlePlayRefund.deleteMany({ where: { purchaseTokenHash: { in: tokens.map(hashPurchaseToken) } } });
    await prisma.$disconnect();
  });

  it("serializes first claims racing refund delivery and its duplicates", async () => {
    for (let round = 0; round < 6; round++) {
      const verification = purchase();
      const notice = { purchaseToken: verification.purchaseToken, orderId: verification.externalPurchaseId, productType: 2 as const };
      await Promise.all([
        recordVerifiedGooglePlayPurchase({ userId, verification }),
        recordGooglePlayRefund(notice), recordGooglePlayRefund(notice),
        recordVerifiedGooglePlayPurchase({ userId, verification })
      ]);
      const account = await prisma.userCreditAccount.findUnique({ where: { userId } });
      expect(account?.availableCredits ?? 0).toBe(0);
      const record = await prisma.purchaseRecord.findUnique({ where: { purchaseTokenHash: hashPurchaseToken(verification.purchaseToken) } });
      expect(record?.status).toBe("REVOKED");
    }
  });

  it("records one full debt when duplicate refunds race after credits have been spent", async () => {
    const verification = purchase();
    await recordVerifiedGooglePlayPurchase({ userId, verification });
    await spendCredits({ userId, amountCredits: 800, operation: "FULL_BOOK_GENERATION", idempotencyKey: `${fixture}:book` });
    const notice = { purchaseToken: verification.purchaseToken, orderId: verification.externalPurchaseId, productType: 2 as const };
    await Promise.all(Array.from({ length: 4 }, () => recordGooglePlayRefund(notice)));
    expect(await prisma.userCreditAccount.findUnique({ where: { userId } })).toMatchObject({ availableCredits: -800 });
    expect(await prisma.creditLedgerEntry.count({ where: { userId, entryType: "ADJUSTMENT",
      purchaseRecord: { purchaseTokenHash: hashPurchaseToken(verification.purchaseToken) } } })).toBe(1);
  });

  it("rolls back the refund marker and balance together on a failed transaction", async () => {
    const verification = purchase();
    await recordVerifiedGooglePlayPurchase({ userId, verification });
    const { recordGooglePlayRefundTx } = await import("./googlePlayRefunds.ts");
    await expect(prisma.$transaction(async (tx) => {
      await recordGooglePlayRefundTx(tx, { purchaseToken: verification.purchaseToken,
        orderId: verification.externalPurchaseId, productType: 2 });
      throw new Error("forced failure before commit");
    })).rejects.toThrow("forced failure");
    expect(await prisma.googlePlayRefund.count({ where: { purchaseTokenHash: hashPurchaseToken(verification.purchaseToken) } })).toBe(0);
    expect(await prisma.userCreditAccount.findUnique({ where: { userId } })).toMatchObject({ availableCredits: 1000 });
    expect(await prisma.purchaseRecord.findUnique({ where: { purchaseTokenHash: hashPurchaseToken(verification.purchaseToken) } })).toMatchObject({ status: "GRANTED" });
  });
});
