-- Preserve the fully resolved instruction independently of ephemeral chat
-- context, and retain a compact audit of the publication gate.
ALTER TABLE "BookEditOperation"
  ADD COLUMN "editInstruction" TEXT,
  ADD COLUMN "adherenceAudit" JSONB;
