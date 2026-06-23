ALTER TYPE "ProjectStatus" ADD VALUE 'EDITING';
ALTER TYPE "JobType" ADD VALUE 'APPLY_BOOK_EDIT';
ALTER TYPE "JobType" ADD VALUE 'REPLAN_BOOK';
ALTER TYPE "CreditOperation" ADD VALUE 'PLAN_REVISION';
ALTER TYPE "CreditOperation" ADD VALUE 'BOOK_TEXT_EDIT';
ALTER TYPE "CreditOperation" ADD VALUE 'PAGE_REGENERATION';
ALTER TYPE "CreditOperation" ADD VALUE 'BOOK_REPLAN';

CREATE TYPE "ProjectChatMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');
CREATE TYPE "BookEditOperationKind" AS ENUM ('PLAN_REVISION', 'LOCAL_PATCH', 'PAGE_REWRITE', 'BOOK_REPLAN');
CREATE TYPE "BookEditOperationStatus" AS ENUM ('QUEUED', 'ACTIVE', 'APPLIED', 'FAILED', 'CANCELED');

CREATE TABLE "ProjectChatMessage" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "role" "ProjectChatMessageRole" NOT NULL,
  "content" TEXT NOT NULL,
  "operationId" TEXT,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookEditOperation" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "userMessageId" TEXT,
  "assistantMessageId" TEXT,
  "generationJobId" TEXT,
  "ledgerEntryId" TEXT,
  "kind" "BookEditOperationKind" NOT NULL,
  "status" "BookEditOperationStatus" NOT NULL DEFAULT 'QUEUED',
  "request" TEXT NOT NULL,
  "classifier" JSONB NOT NULL,
  "affectedPageIndexes" INTEGER[] NOT NULL,
  "creditsCharged" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "appliedAt" TIMESTAMP(3),

  CONSTRAINT "BookEditOperation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PageEditSnapshot" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "pageIndex" INTEGER NOT NULL,
  "titleBefore" TEXT NOT NULL,
  "markdownBefore" TEXT NOT NULL,
  "summaryBefore" TEXT NOT NULL,
  "revisionBefore" INTEGER NOT NULL,
  "titleAfter" TEXT,
  "markdownAfter" TEXT,
  "summaryAfter" TEXT,
  "revisionAfter" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PageEditSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProjectChatMessage_projectId_createdAt_idx" ON "ProjectChatMessage"("projectId", "createdAt");
CREATE INDEX "ProjectChatMessage_operationId_idx" ON "ProjectChatMessage"("operationId");

CREATE INDEX "BookEditOperation_projectId_createdAt_idx" ON "BookEditOperation"("projectId", "createdAt");
CREATE INDEX "BookEditOperation_generationJobId_idx" ON "BookEditOperation"("generationJobId");
CREATE INDEX "BookEditOperation_ledgerEntryId_idx" ON "BookEditOperation"("ledgerEntryId");

CREATE INDEX "PageEditSnapshot_projectId_pageIndex_idx" ON "PageEditSnapshot"("projectId", "pageIndex");
CREATE INDEX "PageEditSnapshot_operationId_idx" ON "PageEditSnapshot"("operationId");
CREATE INDEX "PageEditSnapshot_pageId_idx" ON "PageEditSnapshot"("pageId");

ALTER TABLE "ProjectChatMessage"
  ADD CONSTRAINT "ProjectChatMessage_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectChatMessage"
  ADD CONSTRAINT "ProjectChatMessage_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "BookEditOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BookEditOperation"
  ADD CONSTRAINT "BookEditOperation_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookEditOperation"
  ADD CONSTRAINT "BookEditOperation_generationJobId_fkey"
  FOREIGN KEY ("generationJobId") REFERENCES "GenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BookEditOperation"
  ADD CONSTRAINT "BookEditOperation_ledgerEntryId_fkey"
  FOREIGN KEY ("ledgerEntryId") REFERENCES "CreditLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PageEditSnapshot"
  ADD CONSTRAINT "PageEditSnapshot_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PageEditSnapshot"
  ADD CONSTRAINT "PageEditSnapshot_pageId_fkey"
  FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PageEditSnapshot"
  ADD CONSTRAINT "PageEditSnapshot_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "BookEditOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
