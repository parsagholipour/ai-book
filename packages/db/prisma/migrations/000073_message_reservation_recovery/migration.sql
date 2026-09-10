ALTER TABLE "MessageUsageReservation"
  ADD COLUMN "leaseId" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "MessageUsageReservation" ALTER COLUMN "leaseId" DROP DEFAULT;
UPDATE "MessageUsageReservation" SET "expiresAt" = "updatedAt" + INTERVAL '10 minutes';
CREATE INDEX "MessageUsageReservation_status_expiresAt_idx" ON "MessageUsageReservation"("status", "expiresAt");
