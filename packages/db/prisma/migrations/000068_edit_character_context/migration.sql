-- Mentioned library-character sheets are prompt context, not part of the
-- reader-approved edit contract. Keep them durable across queue recovery in a
-- dedicated column so workers can use them without reviewing them as requests.
ALTER TABLE "BookEditOperation"
  ADD COLUMN "characterContext" TEXT;
