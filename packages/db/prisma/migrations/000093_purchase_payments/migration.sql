CREATE TABLE "PurchasePayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purchaseRecordId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "orderId" TEXT,
    "amountMicros" BIGINT NOT NULL,
    "refundedAmountMicros" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "amountSource" TEXT NOT NULL DEFAULT 'catalog_snapshot',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchasePayment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchasePayment_amount_check" CHECK (
      "amountMicros" >= 0 AND "refundedAmountMicros" >= 0 AND "refundedAmountMicros" <= "amountMicros"
    ),
    CONSTRAINT "PurchasePayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PurchasePayment_purchaseRecordId_fkey" FOREIGN KEY ("purchaseRecordId") REFERENCES "PurchaseRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PurchasePayment_idempotencyKey_key" ON "PurchasePayment"("idempotencyKey");
CREATE INDEX "PurchasePayment_paidAt_idx" ON "PurchasePayment"("paidAt");
CREATE INDEX "PurchasePayment_userId_paidAt_idx" ON "PurchasePayment"("userId", "paidAt");
CREATE INDEX "PurchasePayment_purchaseRecordId_orderId_idx" ON "PurchasePayment"("purchaseRecordId", "orderId");

-- Grant keys retain renewal orders that the mutable PurchaseRecord overwrote.
-- The old code did not snapshot each order's cash price. Backfill with the last
-- recorded catalog price and label that limitation rather than invent a settlement.
INSERT INTO "PurchasePayment" (
  "id", "userId", "purchaseRecordId", "idempotencyKey", "orderId", "amountMicros", "currency", "paidAt", "amountSource"
)
SELECT DISTINCT ON (e."idempotencyKey")
  'legacy_' || md5(e."idempotencyKey"), p."userId", p.id, e."idempotencyKey",
  COALESCE(NULLIF(e.metadata->>'externalPurchaseId', ''), p."externalPurchaseId"),
  p."amountMicros" * CASE WHEN e.operation = 'PURCHASE_CREDIT_GRANT'
    AND p.metadata->>'quantity' ~ '^[1-9][0-9]{0,8}$' THEN (p.metadata->>'quantity')::bigint ELSE 1 END,
  p.currency,
  CASE WHEN e.operation = 'PURCHASE_CREDIT_GRANT' THEN COALESCE(p."purchasedAt", e."createdAt") ELSE e."createdAt" END,
  'legacy_catalog_estimate'
FROM "CreditLedgerEntry" e
JOIN "PurchaseRecord" p ON p.id = e."purchaseRecordId"
WHERE e."entryType" = 'GRANT' AND e.status = 'SETTLED'
  AND p.provider = 'GOOGLE_PLAY' AND p."amountMicros" IS NOT NULL
  AND (
    (e.operation = 'SUBSCRIPTION_CREDIT_GRANT' AND e."idempotencyKey" LIKE 'google-play:subscription:%'
      AND NULLIF(e.metadata->>'externalPurchaseId', '') IS NOT NULL)
    OR (e.operation = 'PURCHASE_CREDIT_GRANT' AND e."idempotencyKey" LIKE 'google-play:purchase:%')
  )
ORDER BY e."idempotencyKey", e."createdAt"
ON CONFLICT ("idempotencyKey") DO NOTHING;

-- Also preserve paid legacy/zero-credit products with no ledger grant. Pending
-- or failed-only attempts are not evidence of payment. Normal grants above win.
WITH legacy AS (
  SELECT p.*,
    p.metadata->>'purchaseKind' = 'subscription' AS subscription,
    CASE
      WHEN p.provider = 'GOOGLE_PLAY' AND p."purchaseTokenHash" IS NOT NULL THEN
        CASE WHEN p.metadata->>'purchaseKind' = 'subscription'
          THEN 'google-play:subscription:' || p."purchaseTokenHash" || ':' || p."externalPurchaseId"
          ELSE 'google-play:purchase:' || p."purchaseTokenHash" || ':credits' END
      ELSE 'legacy:purchase:' || p.id
    END AS payment_key
  FROM "PurchaseRecord" p
  WHERE p.status IN ('VERIFIED', 'GRANTED') AND p."amountMicros" IS NOT NULL
    AND (COALESCE(p.metadata->>'purchaseKind', '') <> 'subscription' OR p."externalPurchaseId" IS NOT NULL)
)
INSERT INTO "PurchasePayment" (
  "id", "userId", "purchaseRecordId", "idempotencyKey", "orderId", "amountMicros", "currency", "paidAt", "amountSource"
)
SELECT 'legacy_' || md5(payment_key), "userId", id, payment_key, "externalPurchaseId",
  "amountMicros" * CASE WHEN NOT COALESCE(subscription, false)
    AND metadata->>'quantity' ~ '^[1-9][0-9]{0,8}$' THEN (metadata->>'quantity')::bigint ELSE 1 END,
  currency, CASE WHEN subscription THEN COALESCE("verifiedAt", "createdAt") ELSE COALESCE("purchasedAt", "createdAt") END,
  'legacy_catalog_estimate'
FROM legacy
ON CONFLICT ("idempotencyKey") DO NOTHING;

-- Full and partial notices delivered before this migration must not reappear
-- as cash. A subscription refund names only one order; a one-time token is one payment.
UPDATE "PurchasePayment" payment
SET "refundedAmountMicros" = refunds.amount
FROM (
  SELECT payment.id, MAX(CASE WHEN r."refundableQuantity" = 0 THEN payment."amountMicros"
    ELSE floor(payment."amountMicros"::numeric * (r.quantity - r."refundableQuantity") / r.quantity)::bigint END) AS amount
  FROM "PurchasePayment" payment
  JOIN "PurchaseRecord" purchase ON purchase.id = payment."purchaseRecordId"
  JOIN "GooglePlayRefund" r ON r."purchaseTokenHash" = purchase."purchaseTokenHash"
    AND (r."productType" = 2 OR r."orderId" = payment."orderId")
  GROUP BY payment.id
) refunds
WHERE payment.id = refunds.id;
