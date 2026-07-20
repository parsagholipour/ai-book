-- Durable, bounded retry metadata for plan-revision edit operations.
ALTER TABLE "BookEditOperation"
  ADD COLUMN "automaticRetryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "automaticRetryLimit" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "nextRetryAt" TIMESTAMP(3),
  ADD COLUMN "lastRetryAt" TIMESTAMP(3),
  ADD COLUMN "lastRetryReason" TEXT,
  ADD COLUMN "retryRequestId" TEXT;

CREATE INDEX "BookEditOperation_status_nextRetryAt_idx"
  ON "BookEditOperation"("status", "nextRetryAt");

CREATE UNIQUE INDEX "BookEditOperation_retryRequestId_key"
  ON "BookEditOperation"("retryRequestId");
