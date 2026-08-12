-- A character photo is read once at upload: it yields a suggested description
-- and a verdict on whether it is a real photograph or already an illustration.
-- An illustration is adopted as the character's reference verbatim, which is
-- what `portraitSource` records — a portrait nobody paid for and which belongs
-- to the photo rather than outliving it.

CREATE TYPE "LibraryCharacterPhotoKind" AS ENUM ('PHOTOGRAPH', 'ILLUSTRATION', 'UNKNOWN');
CREATE TYPE "LibraryCharacterPortraitSource" AS ENUM ('GENERATED', 'ADOPTED_UPLOAD');

ALTER TABLE "LibraryCharacter" ADD COLUMN "photoKind" "LibraryCharacterPhotoKind";
ALTER TABLE "LibraryCharacter" ADD COLUMN "suggestedDescription" TEXT;
ALTER TABLE "LibraryCharacter" ADD COLUMN "portraitSource" "LibraryCharacterPortraitSource";

-- Every portrait that exists today was drawn by GENERATE_CHARACTER_PORTRAIT —
-- adoption did not exist — so the backfill is exact rather than a guess.
UPDATE "LibraryCharacter" SET "portraitSource" = 'GENERATED' WHERE "portraitPath" IS NOT NULL;
