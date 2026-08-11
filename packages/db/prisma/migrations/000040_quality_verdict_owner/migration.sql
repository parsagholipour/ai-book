-- Which compile's quality report is the book's verdict, asked of the schema
-- rather than of the newest few job rows.
--
-- `compile-export` is two different jobs wearing one name, and only one of them
-- reviews the manuscript. A detached export repair and a presentation-only
-- recompile both run with `skipFinalReview`, so their reports are the
-- deterministic checks alone; reading either as the project's verdict erases
-- every model finding a real QA pass earned. Both are payload flags, and
-- negating a JSON-path predicate in SQL drops every row whose payload simply
-- lacks the key — which is all of them but the flagged ones — so the read side
-- used to filter in JS over an arbitrary window of recent jobs (8 compiles, or
-- 25 jobs of any type) and lost the verdict entirely once it aged out.
ALTER TABLE "GenerationJob" ADD COLUMN "ownsQualityVerdict" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from the payload the rows already carry. Presentation-only
-- recompiles predate their flag and cannot be told apart here, so they stay
-- owners exactly as they were before this column existed: the fix applies to
-- everything queued from now on, and nothing historical changes meaning.
UPDATE "GenerationJob"
SET "ownsQualityVerdict" = true
WHERE "type" = 'COMPILE_EXPORT'
  AND ("payload" ->> 'detachedFromProjectLifecycle') IS DISTINCT FROM 'true';

-- The verdict is read on the status poll, so the owning compile has to be one
-- index seek: a book whose exports keep going missing accumulates a repair row
-- every five minutes, and sorting all of them by createdAt on every read is the
-- cost this replaces.
CREATE INDEX "GenerationJob_projectId_type_ownsQualityVerdict_createdAt_idx"
  ON "GenerationJob"("projectId", "type", "ownsQualityVerdict", "createdAt");
