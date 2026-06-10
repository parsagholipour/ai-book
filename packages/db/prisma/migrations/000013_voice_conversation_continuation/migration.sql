ALTER TABLE "VoiceConversation"
  ADD COLUMN IF NOT EXISTS "parentConversationId" TEXT,
  ADD COLUMN IF NOT EXISTS "rootConversationId" TEXT;

CREATE INDEX IF NOT EXISTS "VoiceConversation_parentConversationId_idx" ON "VoiceConversation"("parentConversationId");
CREATE INDEX IF NOT EXISTS "VoiceConversation_rootConversationId_createdAt_idx" ON "VoiceConversation"("rootConversationId", "createdAt");
