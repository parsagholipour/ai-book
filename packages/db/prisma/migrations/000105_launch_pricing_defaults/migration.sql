-- Launch pricing defaults (pre-launch review, 2026-10-13):
--   * Voice calls 60 → 120 credits a minute, until a call is measured
--     (they are also a plan perk now; that is code, not a price).
--   * Paid plans' free daily chat messages: Creator 150 → 60, Pro 300 → 120,
--     Max 600 → 300. The free plan's 50 is unchanged.
--   * `addedPagesBase` joins the price list at 100: a chat continuation or a
--     page insert is priced like the book it joins — this base, then the tier's
--     `fullBookPerPage` per page added — instead of the page-rewrite rate.
--   * `paidMaxBookPages` joins at 200: the longest book any account may have
--     generated, a plan included (before, the schemas' 600).
--   * `ultraTierEnabled` joins at 0: new books may not start on Ultra effort
--     until an operator switches it on (before, Ultra was always offered).
--
-- Pricing history is append-only, so an installation that already has a price
-- list gets a new head revision rather than having its last audited row
-- rewritten (as 000061, 000086 and 000095 did). Each existing key moves only
-- while the head still holds the old compiled default or does not name it, and
-- each new key is added only when the head does not name it: a value an
-- operator chose is theirs and stays. Nothing is written when nothing moves. A
-- database with no pricing rows keeps the table empty and reads the new
-- compiled defaults from core.
WITH head AS (
  SELECT "version", "values"
  FROM "CreditPricingRevision"
  ORDER BY "version" DESC
  LIMIT 1
), decided AS (
  SELECT
    "version" + 1 AS next_version,
    "values",
    COALESCE(("values" ->> 'voiceCallPerMinute')::numeric, 60) = 60 AS move_voice,
    COALESCE(("values" ->> 'messageDailyLimitCreator')::numeric, 150) = 150 AS move_creator,
    COALESCE(("values" ->> 'messageDailyLimitPro')::numeric, 300) = 300 AS move_pro,
    COALESCE(("values" ->> 'messageDailyLimitMax')::numeric, 600) = 600 AS move_max,
    NOT ("values" ? 'addedPagesBase') AS add_added_pages,
    NOT ("values" ? 'paidMaxBookPages') AS add_paid_max,
    NOT ("values" ? 'ultraTierEnabled') AS add_ultra
  FROM head
)
INSERT INTO "CreditPricingRevision" ("id", "version", "values", "changed", "note", "updatedBy")
SELECT
  'launch-pricing-defaults-' || next_version::text,
  next_version,
  "values"
    || CASE WHEN move_voice THEN jsonb_build_object('voiceCallPerMinute', 120) ELSE '{}'::jsonb END
    || CASE WHEN move_creator THEN jsonb_build_object('messageDailyLimitCreator', 60) ELSE '{}'::jsonb END
    || CASE WHEN move_pro THEN jsonb_build_object('messageDailyLimitPro', 120) ELSE '{}'::jsonb END
    || CASE WHEN move_max THEN jsonb_build_object('messageDailyLimitMax', 300) ELSE '{}'::jsonb END
    || CASE WHEN add_added_pages THEN jsonb_build_object('addedPagesBase', 100) ELSE '{}'::jsonb END
    || CASE WHEN add_paid_max THEN jsonb_build_object('paidMaxBookPages', 200) ELSE '{}'::jsonb END
    || CASE WHEN add_ultra THEN jsonb_build_object('ultraTierEnabled', 0) ELSE '{}'::jsonb END,
  jsonb_strip_nulls(jsonb_build_object(
    'voiceCallPerMinute', CASE WHEN move_voice THEN jsonb_build_object('from', 60, 'to', 120) END,
    'messageDailyLimitCreator', CASE WHEN move_creator THEN jsonb_build_object('from', 150, 'to', 60) END,
    'messageDailyLimitPro', CASE WHEN move_pro THEN jsonb_build_object('from', 300, 'to', 120) END,
    'messageDailyLimitMax', CASE WHEN move_max THEN jsonb_build_object('from', 600, 'to', 300) END,
    -- Before the key, added pages paid no base at all.
    'addedPagesBase', CASE WHEN add_added_pages THEN jsonb_build_object('from', 0, 'to', 100) END,
    -- Before the key, every plan could have the schemas' 600 pages.
    'paidMaxBookPages', CASE WHEN add_paid_max THEN jsonb_build_object('from', 600, 'to', 200) END,
    -- Before the switch, Ultra was always offered.
    'ultraTierEnabled', CASE WHEN add_ultra THEN jsonb_build_object('from', 1, 'to', 0) END
  )),
  'Launch defaults: voice 120/min, paid chat 60/120/300 a day, added pages priced like a book, 200-page ceiling, Ultra off',
  'migration-000105'
FROM decided
WHERE move_voice OR move_creator OR move_pro OR move_max OR add_added_pages OR add_paid_max OR add_ultra;
