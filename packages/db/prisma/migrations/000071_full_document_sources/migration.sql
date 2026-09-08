-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" TEXT NOT NULL,
    "draftId" TEXT,
    "userId" TEXT NOT NULL,
    "uploadKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageDraftId" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceExtraction" (
    "sourceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "extractionComplete" BOOLEAN NOT NULL DEFAULT false,
    "acceptedPartial" BOOLEAN NOT NULL DEFAULT false,
    "checkpoints" JSONB NOT NULL DEFAULT '[]',
    "usage" JSONB NOT NULL DEFAULT '{}',
    "fullContent" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "totalSections" INTEGER NOT NULL DEFAULT 0,
    "unreadable" JSONB NOT NULL DEFAULT '[]',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "retryKey" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SourceExtraction_pkey" PRIMARY KEY ("sourceId","version")
);

-- CreateTable
CREATE TABLE "SourceChunk" (
    "sourceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "section" INTEGER NOT NULL,
    "locator" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "embedding" JSONB,

    CONSTRAINT "SourceChunk_pkey" PRIMARY KEY ("sourceId","version","ordinal")
);

-- CreateTable
CREATE TABLE "ProjectSource" (
    "projectId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "acceptedPartial" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProjectSource_pkey" PRIMARY KEY ("projectId","sourceId","version")
);

-- CreateIndex
CREATE INDEX "SourceDocument_userId_draftId_idx" ON "SourceDocument"("userId", "draftId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_storageDraftId_uploadKey_key" ON "SourceDocument"("storageDraftId", "uploadKey");

-- CreateIndex
CREATE INDEX "SourceExtraction_status_leaseExpiresAt_idx" ON "SourceExtraction"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourceExtraction_sourceId_retryKey_key" ON "SourceExtraction"("sourceId", "retryKey");

-- CreateIndex
CREATE INDEX "SourceChunk_sourceId_version_section_idx" ON "SourceChunk"("sourceId", "version", "section");

-- AddForeignKey
ALTER TABLE "SourceDocument" ADD CONSTRAINT "SourceDocument_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "MobileCreationDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceExtraction" ADD CONSTRAINT "SourceExtraction_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SourceDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceChunk" ADD CONSTRAINT "SourceChunk_sourceId_version_fkey" FOREIGN KEY ("sourceId", "version") REFERENCES "SourceExtraction"("sourceId", "version") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSource" ADD CONSTRAINT "ProjectSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSource" ADD CONSTRAINT "ProjectSource_sourceId_version_fkey" FOREIGN KEY ("sourceId", "version") REFERENCES "SourceExtraction"("sourceId", "version") ON DELETE RESTRICT ON UPDATE CASCADE;
