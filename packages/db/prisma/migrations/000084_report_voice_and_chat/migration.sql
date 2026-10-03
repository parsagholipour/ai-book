-- A reader can report a live voice call and a chat reply, as Google Play's
-- generative-AI policy requires of every surface that shows AI output.
-- Kept to the ALTER TYPE alone: Postgres refuses to *use* an enum value in the
-- same transaction that added it.
ALTER TYPE "ModerationReportTargetType" ADD VALUE IF NOT EXISTS 'VOICE_CALL';
ALTER TYPE "ModerationReportTargetType" ADD VALUE IF NOT EXISTS 'CHAT_MESSAGE';
