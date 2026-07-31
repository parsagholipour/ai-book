ALTER TYPE "CreditOperation" ADD VALUE 'VOICE_CALL_MINUTE';

CREATE TABLE "VoiceCall" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "reservationEntryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "heldCredits" INTEGER NOT NULL DEFAULT 0,
  "chargedCredits" INTEGER NOT NULL DEFAULT 0,
  "elapsedSeconds" INTEGER NOT NULL DEFAULT 0,
  "endReason" TEXT,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),

  CONSTRAINT "VoiceCall_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VoiceCall_userId_startedAt_idx" ON "VoiceCall"("userId", "startedAt");
CREATE INDEX "VoiceCall_projectId_startedAt_idx" ON "VoiceCall"("projectId", "startedAt");
CREATE INDEX "VoiceCall_status_lastHeartbeatAt_idx" ON "VoiceCall"("status", "lastHeartbeatAt");

ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "VoiceCharacter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
