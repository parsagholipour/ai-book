-- Retained history for a character's pictures.
--
-- Until now a character held exactly two files, both named from its id alone,
-- so every re-upload and every redraw truncated the previous one in place and
-- two `rm` calls closed the remaining escape hatches. Each version now gets its
-- own row and its own tokenised filename.
--
-- `LibraryCharacter.photoPath`/`portraitPath` stay as the pointers, so nothing
-- that reads them — `usedInBooks`, the build snapshot, both asset routes, the
-- worker's reference seeding — changes meaning. The backfill names the two
-- files that already exist *exactly as they are*: renaming one would silently
-- unseed every book whose `PlanVersion.inputSnapshot` holds the old string,
-- because `libraryPortraitSeedForName` skips a missing file with no error.

CREATE TYPE "LibraryCharacterImageSource" AS ENUM ('UPLOAD', 'GENERATED');

CREATE TABLE "LibraryCharacterImage" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "LibraryCharacterImageSource" NOT NULL,
    "fileName" TEXT NOT NULL,
    "byteSize" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "photoKind" "LibraryCharacterPhotoKind",
    "referenceEligible" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryCharacterImage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LibraryCharacterImage_userId_fileName_key"
    ON "LibraryCharacterImage"("userId", "fileName");
CREATE INDEX "LibraryCharacterImage_characterId_createdAt_idx"
    ON "LibraryCharacterImage"("characterId", "createdAt");

ALTER TABLE "LibraryCharacterImage" ADD CONSTRAINT "LibraryCharacterImage_characterId_fkey"
    FOREIGN KEY ("characterId") REFERENCES "LibraryCharacter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill 1: the stored photo.
--
-- `referenceEligible` is a literal false, not a derivation. `portraitSource`
-- only ever says that *some* upload was adopted, never that the current
-- `photoPath` is the one — an upload that landed while a redraw held the row
-- loses the reference claim silently, so a photograph can sit under an
-- ADOPTED_UPLOAD source. The confidence and subject count that
-- `canAdoptCharacterPhoto` weighed were never stored, and the safe side of that
-- unknown is a priced redraw rather than a real face promoted straight into
-- "reproduce exactly, do not restyle". Nothing is lost: a photo that really was
-- adopted still has its eligible *reference* row from backfill 2.
INSERT INTO "LibraryCharacterImage"
    ("id", "characterId", "userId", "source", "fileName", "photoKind", "referenceEligible", "createdAt")
SELECT
    gen_random_uuid()::text,
    c."id",
    c."userId",
    'UPLOAD',
    c."photoPath",
    c."photoKind",
    false,
    c."createdAt"
FROM "LibraryCharacter" c
WHERE c."photoPath" IS NOT NULL;

-- Backfill 2: the reference image.
--
-- An adopted reference is a second file holding the same bytes as the photo:
-- `adoptUploadAsPortrait` wrote them twice so the two columns could be deleted
-- independently. Both files are on disk, so both get a row — hiding one would
-- leave a file nothing in the system can reach, and nothing sweeps this tree.
-- The duplicate tile self-heals, because deleting either entry now clears the
-- pointer it holds and unlinks its own file.
INSERT INTO "LibraryCharacterImage"
    ("id", "characterId", "userId", "source", "fileName", "photoKind", "referenceEligible", "createdAt")
SELECT
    gen_random_uuid()::text,
    c."id",
    c."userId",
    CASE
        WHEN c."portraitSource" = 'ADOPTED_UPLOAD' THEN 'UPLOAD'::"LibraryCharacterImageSource"
        ELSE 'GENERATED'::"LibraryCharacterImageSource"
    END,
    c."portraitPath",
    CASE
        WHEN c."portraitSource" = 'ADOPTED_UPLOAD' THEN 'ILLUSTRATION'::"LibraryCharacterPhotoKind"
        ELSE NULL
    END,
    true,
    c."updatedAt"
FROM "LibraryCharacter" c
WHERE c."portraitPath" IS NOT NULL
  AND c."portraitPath" IS DISTINCT FROM c."photoPath";
