-- Welcome-grant launch defaults (launch review, 2026-10-13):
--   * welcomeCreditsAccountsPerIpHighIncome 2 → 3
--   * welcomeCreditsAccountsPerIpLowMiddleIncome 1 → 2
--   * welcomeCredits, welcomeCreditsHighIncome, welcomeCreditsLowMiddleIncome
--     1,150 → 1,250
-- The welcome grant now waits for a verified email (migration 000106), so the
-- per-address cap only has to stop an account farm. At one, every reader behind
-- a carrier NAT or a shared router after the first was welcomed with nothing,
-- silently.
--
-- The grant itself moves because a children's picture book now draws
-- min(pages, 12) pictures (`pictureBookIllustrationCap` in core): the largest
-- free one, 30 pages with twelve pictures and a drawn cover, is 1,175 plus its
-- 40-credit plan on Balanced, and 1,150 left every picture book of 22 pages or
-- more unaffordable on the grant alone.
--
-- The other half of that launch decision — a free reader's book priced without
-- its export unlock — is code, not a price: `exportUnlock` stays 150.
--
-- Pricing history is append-only, so an installation that already has a price
-- list gets a new head revision rather than having its last audited row
-- rewritten (as 000105 does). Each key moves only while the head still holds
-- the old compiled default or does not name it: a value an operator chose is
-- theirs and stays. Nothing is written when nothing moves. A database with no
-- pricing rows keeps the table empty and reads the new compiled defaults from
-- core.
WITH head AS (
  SELECT "version", "values"
  FROM "CreditPricingRevision"
  ORDER BY "version" DESC
  LIMIT 1
), decided AS (
  SELECT
    "version" + 1 AS next_version,
    "values",
    COALESCE(("values" ->> 'welcomeCreditsAccountsPerIpHighIncome')::numeric, 2) = 2 AS move_high,
    COALESCE(("values" ->> 'welcomeCreditsAccountsPerIpLowMiddleIncome')::numeric, 1) = 1 AS move_low,
    COALESCE(("values" ->> 'welcomeCredits')::numeric, 1150) = 1150 AS move_welcome,
    COALESCE(("values" ->> 'welcomeCreditsHighIncome')::numeric, 1150) = 1150 AS move_welcome_high,
    COALESCE(("values" ->> 'welcomeCreditsLowMiddleIncome')::numeric, 1150) = 1150 AS move_welcome_low
  FROM head
)
INSERT INTO "CreditPricingRevision" ("id", "version", "values", "changed", "note", "updatedBy")
SELECT
  'welcome-ip-caps-' || next_version::text,
  next_version,
  "values"
    || CASE WHEN move_high THEN jsonb_build_object('welcomeCreditsAccountsPerIpHighIncome', 3) ELSE '{}'::jsonb END
    || CASE WHEN move_low THEN jsonb_build_object('welcomeCreditsAccountsPerIpLowMiddleIncome', 2) ELSE '{}'::jsonb END
    || CASE WHEN move_welcome THEN jsonb_build_object('welcomeCredits', 1250) ELSE '{}'::jsonb END
    || CASE WHEN move_welcome_high THEN jsonb_build_object('welcomeCreditsHighIncome', 1250) ELSE '{}'::jsonb END
    || CASE WHEN move_welcome_low THEN jsonb_build_object('welcomeCreditsLowMiddleIncome', 1250) ELSE '{}'::jsonb END,
  jsonb_strip_nulls(jsonb_build_object(
    'welcomeCreditsAccountsPerIpHighIncome', CASE WHEN move_high THEN jsonb_build_object('from', 2, 'to', 3) END,
    'welcomeCreditsAccountsPerIpLowMiddleIncome', CASE WHEN move_low THEN jsonb_build_object('from', 1, 'to', 2) END,
    'welcomeCredits', CASE WHEN move_welcome THEN jsonb_build_object('from', 1150, 'to', 1250) END,
    'welcomeCreditsHighIncome', CASE WHEN move_welcome_high THEN jsonb_build_object('from', 1150, 'to', 1250) END,
    'welcomeCreditsLowMiddleIncome', CASE WHEN move_welcome_low THEN jsonb_build_object('from', 1150, 'to', 1250) END
  )),
  'Launch defaults: welcome grant 1,250 credits, three accounts per address (high income), two elsewhere, now that a verified email gates it',
  'migration-000110'
FROM decided
WHERE move_high OR move_low OR move_welcome OR move_welcome_high OR move_welcome_low;
