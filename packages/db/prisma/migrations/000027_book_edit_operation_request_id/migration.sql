-- Migration 000025 was edited after it had already been applied to some
-- databases: the two BookEditOperation statements were appended post-apply,
-- so those databases are missing them even though 000025 is recorded as
-- applied. Re-issue them here with guards so this is a no-op on databases
-- where 000025 ran in its final form.
ALTER TABLE "BookEditOperation" ADD COLUMN IF NOT EXISTS "requestId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "BookEditOperation_projectId_requestId_key"
  ON "BookEditOperation"("projectId", "requestId");
