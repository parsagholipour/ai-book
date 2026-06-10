CREATE TABLE "VoiceConversation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "characterSnapshots" JSONB NOT NULL,
    "transcript" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "audioPath" TEXT NOT NULL,
    "durationMs" INTEGER,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceConversation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VoiceConversation_projectId_createdAt_idx" ON "VoiceConversation"("projectId", "createdAt");

ALTER TABLE "VoiceConversation" ADD CONSTRAINT "VoiceConversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
