-- The free tier's longest book (`freeMaxBookPages`) joins the operator price
-- list at 30 pages, editable from the admin Pricing screen.
--
-- Pricing history is append-only, so an installation that already has a price
-- list gets a new head revision carrying the value rather than having its last
-- audited row rewritten (the same move as 000061). A head that already names the
-- key — an operator saved it before this ran — is left alone. A database with no
-- pricing rows keeps the table empty and reads the compiled default, 30.
WITH head AS (
  SELECT "version", "values"
  FROM "CreditPricingRevision"
  ORDER BY "version" DESC
  LIMIT 1
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
  'free-max-book-pages-' || ("version" + 1)::text,
  "version" + 1,
  "values" || jsonb_build_object('freeMaxBookPages', 30),
  -- Before the cap, a free book could be as long as any: the schema's 600.
  jsonb_build_object('freeMaxBookPages', jsonb_build_object('from', 600, 'to', 30)),
  'Free books are capped at 30 pages; longer books need a plan',
  'migration-000086'
FROM head
WHERE NOT ("values" ? 'freeMaxBookPages');
