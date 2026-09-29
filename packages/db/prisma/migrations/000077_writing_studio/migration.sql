-- The Writing Studio's working copy: what an author edits between publishes.
CREATE TABLE "Manuscript" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "settings" JSONB NOT NULL,
    "publishedOrder" JSONB,
    "firstPublishedAt" TIMESTAMP(3),
    "lastPublishedAt" TIMESTAMP(3),
    "lastPublishRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Manuscript_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ManuscriptChapter" (
    "id" TEXT NOT NULL,
    "manuscriptId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'DRAFTING',
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "publishedRevision" INTEGER,
    "publishedChapterId" TEXT,
    "publishedPages" JSONB,
    "conflictTitle" TEXT,
    "conflictMarkdown" TEXT,
    "conflictDetectedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManuscriptChapter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ManuscriptVersion" (
    "id" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManuscriptVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Manuscript_projectId_key" ON "Manuscript"("projectId");
CREATE INDEX "ManuscriptChapter_manuscriptId_position_idx" ON "ManuscriptChapter"("manuscriptId", "position");
CREATE INDEX "ManuscriptVersion_chapterId_createdAt_idx" ON "ManuscriptVersion"("chapterId", "createdAt");

ALTER TABLE "Manuscript" ADD CONSTRAINT "Manuscript_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManuscriptChapter" ADD CONSTRAINT "ManuscriptChapter_manuscriptId_fkey" FOREIGN KEY ("manuscriptId") REFERENCES "Manuscript"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManuscriptVersion" ADD CONSTRAINT "ManuscriptVersion_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "ManuscriptChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
