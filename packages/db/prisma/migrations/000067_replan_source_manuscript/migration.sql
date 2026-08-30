-- A replan publishes into a new, initially empty project. Keep the manuscript
-- it is replacing on the durable operation so reconstructed GENERATE_BOOK
-- deliveries cannot accidentally compare the candidate against that target.
ALTER TABLE "BookEditOperation"
  ADD COLUMN "sourceProjectId" TEXT;

-- Replan-copy operations have always been owned by the source project. This
-- makes existing in-flight operations recover with the same provenance.
UPDATE "BookEditOperation"
SET "sourceProjectId" = "projectId"
WHERE "kind" = 'BOOK_REPLAN';
