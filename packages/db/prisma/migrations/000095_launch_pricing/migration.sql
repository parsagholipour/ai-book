-- Launch pricing (2026-10-12):
--   * Ultra's per-page rate 71 → 130, cleared against the one measured ultra
--     book on the Max plan rather than an assumed page cost.
--   * Narration priced by the words read aloud: `audiobookPer100Words` 6 joins
--     the price list and the flat `audiobookPerPage` 12 becomes 0.
--   * The welcome grant 1,000 → 1,150, enough for the largest book a free
--     account may generate on Balanced plus its plan.
--
-- Pricing history is append-only, so an installation that already has a price
-- list gets a new head revision rather than having its last audited row
-- rewritten (as 000061 and 000086 did). Each key moves only while the head still
-- holds the old compiled default or does not name it; a value an operator chose
-- is theirs and stays. A database with no pricing rows keeps the table empty and
-- reads the new compiled defaults.
WITH head AS (
  SELECT "version", "values"
  FROM "CreditPricingRevision"
  ORDER BY "version" DESC
  LIMIT 1
), decided AS (
  SELECT
    "version" + 1 AS next_version,
    "values",
    COALESCE(("values" ->> 'fullBookPerPageUltra')::numeric, 71) = 71 AS move_ultra,
    COALESCE(("values" ->> 'audiobookPerPage')::numeric, 12) = 12 AS move_audio_page,
    NOT ("values" ? 'audiobookPer100Words') AS add_audio_words,
    COALESCE(("values" ->> 'welcomeCredits')::numeric, 1000) = 1000 AS move_welcome,
    COALESCE(("values" ->> 'welcomeCreditsHighIncome')::numeric, 1000) = 1000 AS move_welcome_high,
    COALESCE(("values" ->> 'welcomeCreditsLowMiddleIncome')::numeric, 1000) = 1000 AS move_welcome_low
  FROM head
)
INSERT INTO "CreditPricingRevision" ("id", "version", "values", "changed", "note", "updatedBy")
SELECT
  'launch-pricing-' || next_version::text,
  next_version,
  "values"
    || CASE WHEN move_ultra THEN jsonb_build_object('fullBookPerPageUltra', 130) ELSE '{}'::jsonb END
    || CASE WHEN move_audio_page THEN jsonb_build_object('audiobookPerPage', 0) ELSE '{}'::jsonb END
    || CASE WHEN add_audio_words THEN jsonb_build_object('audiobookPer100Words', 6) ELSE '{}'::jsonb END
    || CASE WHEN move_welcome THEN jsonb_build_object('welcomeCredits', 1150) ELSE '{}'::jsonb END
    || CASE WHEN move_welcome_high THEN jsonb_build_object('welcomeCreditsHighIncome', 1150) ELSE '{}'::jsonb END
    || CASE WHEN move_welcome_low THEN jsonb_build_object('welcomeCreditsLowMiddleIncome', 1150) ELSE '{}'::jsonb END,
  jsonb_strip_nulls(jsonb_build_object(
    'fullBookPerPageUltra', CASE WHEN move_ultra THEN jsonb_build_object('from', 71, 'to', 130) END,
    'audiobookPerPage', CASE WHEN move_audio_page THEN jsonb_build_object('from', 12, 'to', 0) END,
    'audiobookPer100Words', CASE WHEN add_audio_words THEN jsonb_build_object('from', 0, 'to', 6) END,
    'welcomeCredits', CASE WHEN move_welcome THEN jsonb_build_object('from', 1000, 'to', 1150) END,
    'welcomeCreditsHighIncome', CASE WHEN move_welcome_high THEN jsonb_build_object('from', 1000, 'to', 1150) END,
    'welcomeCreditsLowMiddleIncome', CASE WHEN move_welcome_low THEN jsonb_build_object('from', 1000, 'to', 1150) END
  )),
  'Launch pricing: ultra per page, narration by the word, welcome grant covers the first book',
  'migration-000095'
FROM decided
WHERE move_ultra OR move_audio_page OR add_audio_words OR move_welcome OR move_welcome_high OR move_welcome_low;
