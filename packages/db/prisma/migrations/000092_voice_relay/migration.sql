ALTER TABLE "VoiceCall"
  ADD COLUMN "relayTokenHash" TEXT,
  ADD COLUMN "relaySession" JSONB,
  ADD COLUMN "relayLeaseId" TEXT,
  ADD COLUMN "relayLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "relayConnectedAt" TIMESTAMP(3),
  ADD COLUMN "relayFundedSeconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "relayReservedMinutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "voiceCreditsPerMinute" INTEGER;
