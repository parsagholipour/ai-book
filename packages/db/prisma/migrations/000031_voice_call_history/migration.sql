ALTER TABLE "VoiceCall" ADD COLUMN "transcript" JSONB;

-- Opening a call reads the reader's last few calls with that one character.
CREATE INDEX "VoiceCall_userId_characterId_startedAt_idx" ON "VoiceCall"("userId", "characterId", "startedAt");
