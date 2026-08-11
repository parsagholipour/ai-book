-- One row per purchase token, enforced by the schema instead of a racy
-- find-then-create.
--
-- The Play purchase listener and a "restore purchases" routinely verify the
-- same token concurrently; both used to findFirst nothing and both create.
-- The duplicate PurchaseRecord double-counted `amountMicros` in the revenue
-- dashboard and let a raced verification link one token to two accounts; the
-- duplicate SubscriptionState was worse — the upsert forever updated the row
-- findFirst happened to return while the renewal sweep polled the other,
-- re-verifying a closed subscription for good. Collapse existing duplicates
-- onto the earliest row, re-pointing the rows that reference them (the FK is
-- ON DELETE SET NULL, so a bare delete would erase provenance), then let
-- uniqueness turn the race into a conflict the writers now handle.

-- Re-point ledger entries and entitlements from duplicate purchase records to
-- the surviving (earliest) record for their token.
WITH keep AS (
  SELECT DISTINCT ON ("purchaseTokenHash") id, "purchaseTokenHash"
  FROM "PurchaseRecord"
  WHERE "purchaseTokenHash" IS NOT NULL
  ORDER BY "purchaseTokenHash", "createdAt" ASC, id ASC
)
UPDATE "CreditLedgerEntry" entry
SET "purchaseRecordId" = keep.id
FROM "PurchaseRecord" dupe
JOIN keep ON keep."purchaseTokenHash" = dupe."purchaseTokenHash"
WHERE entry."purchaseRecordId" = dupe.id
  AND dupe.id <> keep.id;

WITH keep AS (
  SELECT DISTINCT ON ("purchaseTokenHash") id, "purchaseTokenHash"
  FROM "PurchaseRecord"
  WHERE "purchaseTokenHash" IS NOT NULL
  ORDER BY "purchaseTokenHash", "createdAt" ASC, id ASC
)
UPDATE "UserEntitlement" entitlement
SET "purchaseRecordId" = keep.id
FROM "PurchaseRecord" dupe
JOIN keep ON keep."purchaseTokenHash" = dupe."purchaseTokenHash"
WHERE entitlement."purchaseRecordId" = dupe.id
  AND dupe.id <> keep.id;

WITH keep AS (
  SELECT DISTINCT ON ("purchaseTokenHash") id, "purchaseTokenHash"
  FROM "PurchaseRecord"
  WHERE "purchaseTokenHash" IS NOT NULL
  ORDER BY "purchaseTokenHash", "createdAt" ASC, id ASC
)
DELETE FROM "PurchaseRecord" dupe
USING keep
WHERE dupe."purchaseTokenHash" = keep."purchaseTokenHash"
  AND dupe.id <> keep.id;

DROP INDEX IF EXISTS "PurchaseRecord_purchaseTokenHash_idx";
CREATE UNIQUE INDEX "PurchaseRecord_purchaseTokenHash_key" ON "PurchaseRecord"("purchaseTokenHash");

-- Nothing references SubscriptionState, so duplicates are simply dropped;
-- the earliest row survives as the canonical state.
WITH keep AS (
  SELECT DISTINCT ON ("provider", "externalSubscriptionId") id, "provider", "externalSubscriptionId"
  FROM "SubscriptionState"
  WHERE "externalSubscriptionId" IS NOT NULL
  ORDER BY "provider", "externalSubscriptionId", "createdAt" ASC, id ASC
)
DELETE FROM "SubscriptionState" dupe
USING keep
WHERE dupe."provider" = keep."provider"
  AND dupe."externalSubscriptionId" = keep."externalSubscriptionId"
  AND dupe.id <> keep.id;

DROP INDEX IF EXISTS "SubscriptionState_provider_externalSubscriptionId_idx";
CREATE UNIQUE INDEX "SubscriptionState_provider_externalSubscriptionId_key"
  ON "SubscriptionState"("provider", "externalSubscriptionId");
