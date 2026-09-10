ALTER TYPE "CreditOperation" ADD VALUE 'CHAT_MESSAGE';
ALTER TYPE "CreditOperation" ADD VALUE 'MESSAGE_LIMIT_RESET';
ALTER TABLE "UsageCounter" ADD COLUMN "resetCount" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "MessageUsageReservation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "requestKey" TEXT NOT NULL,
  "periodKey" TEXT NOT NULL,
  "resetCount" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RESERVED',
  "ledgerEntryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "MessageUsageReservation_userId_requestKey_key" ON "MessageUsageReservation"("userId", "requestKey");
CREATE INDEX "MessageUsageReservation_status_updatedAt_idx" ON "MessageUsageReservation"("status", "updatedAt");
