-- What the buyer was charged in their own currency, before tax and Google's
-- cut. Recorded for analytics only (the admin dashboard); never decides a grant.
-- Every column is nullable: older app builds, purchases only Google reported,
-- and every row written before this migration carry none.

ALTER TABLE "PurchaseRecord"
  ADD COLUMN "localPriceMicros" BIGINT,
  ADD COLUMN "localCurrency" VARCHAR(3);

ALTER TABLE "PurchasePayment"
  ADD COLUMN "localPriceMicros" BIGINT,
  ADD COLUMN "localCurrency" VARCHAR(3),
  ADD COLUMN "localPriceSource" TEXT;
