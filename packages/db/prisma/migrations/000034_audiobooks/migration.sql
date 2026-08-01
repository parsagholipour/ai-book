-- Audiobooks: a narrated rendering of a finished book, synthesized chapter by
-- chapter so the reader can start listening while the tail is still being made.

ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'GENERATE_AUDIOBOOK';
ALTER TYPE "CreditOperation" ADD VALUE IF NOT EXISTS 'AUDIOBOOK_GENERATION';

CREATE TYPE "AudiobookStatus" AS ENUM ('GENERATING', 'COMPLETE', 'FAILED');
CREATE TYPE "AudiobookChapterStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

CREATE TABLE "Audiobook" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "status" "AudiobookStatus" NOT NULL DEFAULT 'GENERATING',
    "contentRevision" INTEGER,
    "totalDurationMs" INTEGER,
    "generationJobId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Audiobook_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Audiobook_projectId_key" ON "Audiobook"("projectId");

ALTER TABLE "Audiobook"
    ADD CONSTRAINT "Audiobook_projectId_fkey" FOREIGN KEY ("projectId")
    REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AudiobookChapter" (
    "id" TEXT NOT NULL,
    "audiobookId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" "AudiobookChapterStatus" NOT NULL DEFAULT 'PENDING',
    "durationMs" INTEGER,
    "estimatedDurationMs" INTEGER,
    "byteSize" INTEGER,
    "segmentCount" INTEGER,
    "pageStartIndex" INTEGER,
    "pageEndIndex" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudiobookChapter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AudiobookChapter_audiobookId_index_key"
    ON "AudiobookChapter"("audiobookId", "index");
CREATE INDEX "AudiobookChapter_audiobookId_index_idx"
    ON "AudiobookChapter"("audiobookId", "index");

ALTER TABLE "AudiobookChapter"
    ADD CONSTRAINT "AudiobookChapter_audiobookId_fkey" FOREIGN KEY ("audiobookId")
    REFERENCES "Audiobook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
