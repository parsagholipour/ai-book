-- Exactly-once billing boundary for priced asynchronous generation.
CREATE TYPE "GenerationAttemptStatus" AS ENUM ('QUEUED', 'ACTIVE', 'SUCCEEDED', 'FAILED', 'CANCELED');

CREATE TABLE "GenerationAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "commandKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "status" "GenerationAttemptStatus" NOT NULL DEFAULT 'QUEUED',
    "operation" "CreditOperation" NOT NULL,
    "quotedCredits" INTEGER NOT NULL,
    "projectId" TEXT,
    "editOperationId" TEXT,
    "ledgerEntryId" TEXT,
    "primaryJobId" TEXT,
    "retryOfAttemptId" TEXT,
    "error" TEXT,
    "refundPending" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationAttempt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GenerationJob" ADD COLUMN "attemptId" TEXT;

CREATE UNIQUE INDEX "GenerationAttempt_commandKey_key" ON "GenerationAttempt"("commandKey");
CREATE INDEX "GenerationAttempt_editOperationId_idx" ON "GenerationAttempt"("editOperationId");
CREATE UNIQUE INDEX "GenerationAttempt_ledgerEntryId_key" ON "GenerationAttempt"("ledgerEntryId");
CREATE UNIQUE INDEX "GenerationAttempt_primaryJobId_key" ON "GenerationAttempt"("primaryJobId");
CREATE UNIQUE INDEX "GenerationAttempt_retryOfAttemptId_key" ON "GenerationAttempt"("retryOfAttemptId");
CREATE INDEX "GenerationAttempt_userId_createdAt_idx" ON "GenerationAttempt"("userId", "createdAt");
CREATE INDEX "GenerationAttempt_projectId_status_idx" ON "GenerationAttempt"("projectId", "status");
CREATE INDEX "GenerationAttempt_status_refundPending_updatedAt_idx" ON "GenerationAttempt"("status", "refundPending", "updatedAt");
CREATE INDEX "GenerationJob_attemptId_idx" ON "GenerationJob"("attemptId");

ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "GenerationAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "GenerationAttempt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "GenerationAttempt_editOperationId_fkey" FOREIGN KEY ("editOperationId") REFERENCES "BookEditOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "GenerationAttempt_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "CreditLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "GenerationAttempt_primaryJobId_fkey" FOREIGN KEY ("primaryJobId") REFERENCES "GenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "GenerationAttempt_retryOfAttemptId_fkey" FOREIGN KEY ("retryOfAttemptId") REFERENCES "GenerationAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "GenerationAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
