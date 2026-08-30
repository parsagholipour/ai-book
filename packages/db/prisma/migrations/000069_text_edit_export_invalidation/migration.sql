-- A text-edit manuscript commit no longer holds a database transaction open
-- while deleting exports. This revision-scoped barrier keeps every compiler
-- away from the shared filenames until the idempotent filesystem tail finishes.
ALTER TABLE "Project"
  ADD COLUMN "exportInvalidationRevision" INTEGER;
