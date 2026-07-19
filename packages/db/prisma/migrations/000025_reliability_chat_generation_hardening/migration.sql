ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'REVIEW_REQUIRED';
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'CANCELED';

ALTER TABLE "Project"
  ADD COLUMN "contentRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "MobileCreationDraft"
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "lastTurn" JSONB,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "MobileCreationOutput"
  ADD COLUMN "requestId" TEXT;

ALTER TABLE "GenerationJob"
  ADD COLUMN "dedupeKey" TEXT,
  ADD COLUMN "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextDispatchAt" TIMESTAMP(3),
  ADD COLUMN "dispatchedAt" TIMESTAMP(3),
  ADD COLUMN "contentRevision" INTEGER,
  ADD COLUMN "qualityReport" JSONB;

ALTER TABLE "ProjectChatMessage"
  ADD COLUMN "requestId" TEXT;

ALTER TABLE "BookEditOperation"
  ADD COLUMN "requestId" TEXT;

CREATE UNIQUE INDEX "MobileCreationOutput_draftId_requestId_key"
  ON "MobileCreationOutput"("draftId", "requestId");
CREATE UNIQUE INDEX "MobileCreationDraft_requestId_key"
  ON "MobileCreationDraft"("requestId");
CREATE UNIQUE INDEX "GenerationJob_dedupeKey_key"
  ON "GenerationJob"("dedupeKey");
CREATE UNIQUE INDEX "ProjectChatMessage_projectId_requestId_key"
  ON "ProjectChatMessage"("projectId", "requestId");
CREATE UNIQUE INDEX "BookEditOperation_projectId_requestId_key"
  ON "BookEditOperation"("projectId", "requestId");
CREATE INDEX "GenerationJob_projectId_type_status_idx"
  ON "GenerationJob"("projectId", "type", "status");
CREATE INDEX "GenerationJob_status_nextDispatchAt_idx"
  ON "GenerationJob"("status", "nextDispatchAt");
