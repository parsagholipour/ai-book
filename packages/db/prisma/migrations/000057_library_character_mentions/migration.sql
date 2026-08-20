-- Durable directed links for @mentions inside library-character descriptions.
-- Existing prose is deliberately not backfilled: an old "@Name" was plain
-- text, and guessing an identity now could attach the wrong saved character.
CREATE TABLE "LibraryCharacterMention" (
  "sourceCharacterId" TEXT NOT NULL,
  "targetCharacterId" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL,

  CONSTRAINT "LibraryCharacterMention_pkey" PRIMARY KEY ("sourceCharacterId", "targetCharacterId"),
  CONSTRAINT "LibraryCharacterMention_not_self" CHECK ("sourceCharacterId" <> "targetCharacterId")
);

CREATE INDEX "LibraryCharacterMention_sourceCharacterId_sortOrder_idx"
  ON "LibraryCharacterMention"("sourceCharacterId", "sortOrder");

CREATE INDEX "LibraryCharacterMention_targetCharacterId_idx"
  ON "LibraryCharacterMention"("targetCharacterId");

ALTER TABLE "LibraryCharacterMention"
  ADD CONSTRAINT "LibraryCharacterMention_sourceCharacterId_fkey"
  FOREIGN KEY ("sourceCharacterId") REFERENCES "LibraryCharacter"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LibraryCharacterMention"
  ADD CONSTRAINT "LibraryCharacterMention_targetCharacterId_fkey"
  FOREIGN KEY ("targetCharacterId") REFERENCES "LibraryCharacter"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
