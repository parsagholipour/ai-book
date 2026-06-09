CREATE TABLE "VoiceCallEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "clientCallId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "attempt" INTEGER,
    "elapsedMs" INTEGER,
    "connectionState" TEXT,
    "iceConnectionState" TEXT,
    "iceGatheringState" TEXT,
    "candidatePairType" TEXT,
    "candidateProtocol" TEXT,
    "currentRoundTripTimeMs" INTEGER,
    "packetsLost" INTEGER,
    "jitterMs" INTEGER,
    "error" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceCallEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "VoiceCallEvent" ADD CONSTRAINT "VoiceCallEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceCallEvent" ADD CONSTRAINT "VoiceCallEvent_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "VoiceCharacter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "VoiceCallEvent_projectId_createdAt_idx" ON "VoiceCallEvent"("projectId", "createdAt");
CREATE INDEX "VoiceCallEvent_characterId_createdAt_idx" ON "VoiceCallEvent"("characterId", "createdAt");
CREATE INDEX "VoiceCallEvent_clientCallId_idx" ON "VoiceCallEvent"("clientCallId");
