-- Library characters can take calls too. A call names exactly one callee: a
-- book's VoiceCharacter (cascades with it, as before) or an account-level
-- LibraryCharacter. The library side is SET NULL rather than CASCADE so a
-- character the reader deletes leaves its metered rows behind — an ACTIVE one
-- included, which the stale-call sweep still has to settle and release.
ALTER TABLE "VoiceCall" ALTER COLUMN "projectId" DROP NOT NULL;
ALTER TABLE "VoiceCall" ALTER COLUMN "characterId" DROP NOT NULL;
ALTER TABLE "VoiceCall" ADD COLUMN "libraryCharacterId" TEXT;

ALTER TABLE "VoiceCall"
  ADD CONSTRAINT "VoiceCall_libraryCharacterId_fkey"
  FOREIGN KEY ("libraryCharacterId") REFERENCES "LibraryCharacter"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "VoiceCall_userId_libraryCharacterId_startedAt_idx"
  ON "VoiceCall"("userId", "libraryCharacterId", "startedAt");

-- A book callee is the project and the cast row together, never one without
-- the other, and no row names both a book callee and a library one. A row
-- naming neither is a library call whose character has since been deleted.
ALTER TABLE "VoiceCall"
  ADD CONSTRAINT "VoiceCall_one_callee"
  CHECK (
    ("projectId" IS NULL) = ("characterId" IS NULL)
    AND NOT ("characterId" IS NOT NULL AND "libraryCharacterId" IS NOT NULL)
  );
