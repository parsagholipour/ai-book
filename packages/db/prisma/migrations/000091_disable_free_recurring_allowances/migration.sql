-- Preserve pricing history while retiring recurring free grants. Existing
-- positive message prices and all paid-plan/welcome settings are unchanged.
-- Unspent legacy free-month balances are retired with a ledger adjustment by
-- ensureCurrentPlanPeriodTx on the next balance read or reservation.
WITH head AS (
  SELECT "version", "values"
  FROM "CreditPricingRevision"
  ORDER BY "version" DESC
  LIMIT 1
), migrated AS (
  SELECT "version" + 1 AS next_version, "values",
    CASE WHEN jsonb_typeof("values" -> 'messageCreditsFree') = 'number'
      THEN GREATEST(1, ("values" ->> 'messageCreditsFree')::numeric)
      ELSE 1
    END AS message_price
  FROM head
)
INSERT INTO "CreditPricingRevision" ("id", "version", "values", "changed", "note", "updatedBy")
SELECT 'disable-free-recurring-' || next_version::text, next_version,
  "values" || jsonb_build_object('freeMonthlyCredits', 0, 'messageCreditsFree', message_price),
  jsonb_build_object(
    'freeMonthlyCredits', jsonb_build_object('from', COALESCE("values" -> 'freeMonthlyCredits', '1000'::jsonb), 'to', 0),
    'messageCreditsFree', jsonb_build_object('from', COALESCE("values" -> 'messageCreditsFree', '0'::jsonb), 'to', message_price)
  ),
  'Free accounts spend welcome or purchased credits; no monthly grants or free messages',
  'migration-000091'
FROM migrated;
