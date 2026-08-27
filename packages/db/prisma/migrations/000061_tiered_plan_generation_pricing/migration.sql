-- Initial plan generation now follows the book's selected effort tier.
--
-- Pricing history is append-only, so an existing installation gets a new
-- head revision rather than having its last audited row rewritten. A database
-- with no pricing rows keeps the table empty and reads the new compiled
-- defaults from core.
WITH head AS (
  SELECT "version", "values"
  FROM "CreditPricingRevision"
  ORDER BY "version" DESC
  LIMIT 1
), migrated AS (
  SELECT
    "version" + 1 AS next_version,
    "values",
    CASE
      -- A nonzero value was an explicit operator override and remains so.
      WHEN jsonb_typeof("values" -> 'planGeneration') = 'number'
        AND ("values" ->> 'planGeneration')::numeric <> 0
      THEN "values" -> 'planGeneration'
      -- Missing and zero both meant the legacy compiled free rate.
      ELSE to_jsonb(40)
    END AS balanced_value,
    CASE
      WHEN jsonb_typeof("values" -> 'planGeneration') = 'number'
      THEN ("values" ->> 'planGeneration')::numeric
      ELSE 0
    END AS prior_balanced
  FROM head
)
INSERT INTO "CreditPricingRevision" (
  "id",
  "version",
  "values",
  "changed",
  "note",
  "updatedBy"
)
SELECT
  'tiered-plan-generation-' || next_version::text,
  next_version,
  "values" || jsonb_build_object(
    'planGeneration', balanced_value,
    'planGenerationFast', 20,
    'planGenerationPremium', 80,
    'planGenerationUltra', 120
  ),
  jsonb_strip_nulls(jsonb_build_object(
    'planGeneration', CASE
      WHEN prior_balanced = 0
      THEN jsonb_build_object('from', 0, 'to', 40)
      ELSE NULL
    END,
    'planGenerationFast', jsonb_build_object('from', 0, 'to', 20),
    'planGenerationPremium', jsonb_build_object('from', 0, 'to', 80),
    'planGenerationUltra', jsonb_build_object('from', 0, 'to', 120)
  )),
  'Seed effort-based initial planning prices',
  'migration-000061'
FROM migrated;
