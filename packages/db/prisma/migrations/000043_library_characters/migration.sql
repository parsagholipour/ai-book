-- Account-wide user-defined characters ("consistent characters").
-- Books reference a library character by snapshot and by name, never by FK,
-- so nothing here touches existing project data.

ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'GENERATE_CHARACTER_PORTRAIT';
ALTER TYPE "CreditOperation" ADD VALUE IF NOT EXISTS 'CHARACTER_PORTRAIT_GENERATION' AFTER 'AUDIOBOOK_GENERATION';

CREATE TYPE "LibraryCharacterPortraitStatus" AS ENUM ('NONE', 'QUEUED', 'GENERATING', 'READY', 'FAILED');

CREATE TABLE "LibraryCharacter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "photoPath" TEXT,
    "portraitPath" TEXT,
    "portraitStatus" "LibraryCharacterPortraitStatus" NOT NULL DEFAULT 'NONE',
    "portraitError" TEXT,
    "portraitJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryCharacter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LibraryCharacter_userId_name_key" ON "LibraryCharacter"("userId", "name");
CREATE INDEX "LibraryCharacter_userId_createdAt_idx" ON "LibraryCharacter"("userId", "createdAt");

ALTER TABLE "LibraryCharacter" ADD CONSTRAINT "LibraryCharacter_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Portrait jobs belong to an account, not a book.
ALTER TABLE "GenerationJob" ALTER COLUMN "projectId" DROP NOT NULL;
