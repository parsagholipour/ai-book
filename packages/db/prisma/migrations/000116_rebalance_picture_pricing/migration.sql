-- A book's price follows what it costs to make (2026-10-17):
--   * fullBookBase 350 → 250, fullBookBaseFast 220 → 150
--   * imageGeneration and imageGenerationFast 45 → 70
--   * imageGenerationPremium and imageGenerationUltra 85 → 130
--   * welcomeCredits, welcomeCreditsHighIncome, welcomeCreditsLowMiddleIncome
--     1,250 → 1,500
-- Pictures are 80–99% of an illustrated book's provider spend and its text
-- almost none of it, yet the price was the other way round: a picture at 45
-- earned less than it cost on the Max plan once a book's unbilled reference
-- sheets were counted, while a 10-page story's 350 base paid for about a cent
-- of writing. The welcome grant moves so the largest free picture book (30
-- pages, twelve pictures and a drawn cover, 1,440 with its plan) still fits
-- with room for the creation chat (`welcomeCredits.test.ts` in core).
--
-- Pricing history is append-only, so an installation that already has a price
-- list gets a new head revision rather than having its last audited row
-- rewritten (the pattern of 000110). Each key moves only while the head still
-- holds the old compiled default or does not name it: a value an operator chose
-- is theirs and stays. A stored list that does not name `imageGenerationUltra`
-- reads its premium twin (`normalizeCreditPricing`), so that key moves only
-- while what it reads is the old 85. Nothing is written when nothing moves. A
-- database with no pricing rows keeps the table empty and reads the new compiled
-- defaults from core.
WITH head AS (
  SELECT "version", "values"
  FROM "CreditPricingRevision"
  ORDER BY "version" DESC
  LIMIT 1
), decided AS (
  SELECT
    "version" + 1 AS next_version,
    "values",
    COALESCE(("values" ->> 'fullBookBase')::numeric, 350) = 350 AS move_base,
    COALESCE(("values" ->> 'fullBookBaseFast')::numeric, 220) = 220 AS move_base_fast,
    COALESCE(("values" ->> 'imageGeneration')::numeric, 45) = 45 AS move_image,
    COALESCE(("values" ->> 'imageGenerationFast')::numeric, 45) = 45 AS move_image_fast,
    COALESCE(("values" ->> 'imageGenerationPremium')::numeric, 85) = 85 AS move_image_premium,
    COALESCE(("values" ->> 'imageGenerationUltra')::numeric, ("values" ->> 'imageGenerationPremium')::numeric, 85) = 85 AS move_image_ultra,
    COALESCE(("values" ->> 'welcomeCredits')::numeric, 1250) = 1250 AS move_welcome,
    COALESCE(("values" ->> 'welcomeCreditsHighIncome')::numeric, 1250) = 1250 AS move_welcome_high,
    COALESCE(("values" ->> 'welcomeCreditsLowMiddleIncome')::numeric, 1250) = 1250 AS move_welcome_low
  FROM head
)
INSERT INTO "CreditPricingRevision" ("id", "version", "values", "changed", "note", "updatedBy")
SELECT
  'rebalance-picture-pricing-' || next_version::text,
  next_version,
  "values"
    || CASE WHEN move_base THEN jsonb_build_object('fullBookBase', 250) ELSE '{}'::jsonb END
    || CASE WHEN move_base_fast THEN jsonb_build_object('fullBookBaseFast', 150) ELSE '{}'::jsonb END
    || CASE WHEN move_image THEN jsonb_build_object('imageGeneration', 70) ELSE '{}'::jsonb END
    || CASE WHEN move_image_fast THEN jsonb_build_object('imageGenerationFast', 70) ELSE '{}'::jsonb END
    || CASE WHEN move_image_premium THEN jsonb_build_object('imageGenerationPremium', 130) ELSE '{}'::jsonb END
    || CASE WHEN move_image_ultra THEN jsonb_build_object('imageGenerationUltra', 130) ELSE '{}'::jsonb END
    || CASE WHEN move_welcome THEN jsonb_build_object('welcomeCredits', 1500) ELSE '{}'::jsonb END
    || CASE WHEN move_welcome_high THEN jsonb_build_object('welcomeCreditsHighIncome', 1500) ELSE '{}'::jsonb END
    || CASE WHEN move_welcome_low THEN jsonb_build_object('welcomeCreditsLowMiddleIncome', 1500) ELSE '{}'::jsonb END,
  jsonb_strip_nulls(jsonb_build_object(
    'fullBookBase', CASE WHEN move_base THEN jsonb_build_object('from', 350, 'to', 250) END,
    'fullBookBaseFast', CASE WHEN move_base_fast THEN jsonb_build_object('from', 220, 'to', 150) END,
    'imageGeneration', CASE WHEN move_image THEN jsonb_build_object('from', 45, 'to', 70) END,
    'imageGenerationFast', CASE WHEN move_image_fast THEN jsonb_build_object('from', 45, 'to', 70) END,
    'imageGenerationPremium', CASE WHEN move_image_premium THEN jsonb_build_object('from', 85, 'to', 130) END,
    'imageGenerationUltra', CASE WHEN move_image_ultra THEN jsonb_build_object('from', 85, 'to', 130) END,
    'welcomeCredits', CASE WHEN move_welcome THEN jsonb_build_object('from', 1250, 'to', 1500) END,
    'welcomeCreditsHighIncome', CASE WHEN move_welcome_high THEN jsonb_build_object('from', 1250, 'to', 1500) END,
    'welcomeCreditsLowMiddleIncome', CASE WHEN move_welcome_low THEN jsonb_build_object('from', 1250, 'to', 1500) END
  )),
  'Prices follow cost: book base 250 (Fast 150), a picture 70 (Premium and Ultra 130), welcome grant 1,500',
  'migration-000116'
FROM decided
WHERE move_base OR move_base_fast OR move_image OR move_image_fast OR move_image_premium OR move_image_ultra
  OR move_welcome OR move_welcome_high OR move_welcome_low;
