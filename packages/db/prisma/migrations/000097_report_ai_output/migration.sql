-- Google Play's AI-generated content policy wants every surface that shows AI
-- output reportable in the app. These were not: a reply in the creation chat
-- (before any book exists), the book plan card, a drawn library-character
-- picture, and a Writing Studio suggestion.
-- Kept to the ALTER TYPE alone: Postgres refuses to *use* an enum value in the
-- same transaction that added it.
ALTER TYPE "ModerationReportTargetType" ADD VALUE IF NOT EXISTS 'CREATION_CHAT_MESSAGE';
ALTER TYPE "ModerationReportTargetType" ADD VALUE IF NOT EXISTS 'BOOK_PLAN';
ALTER TYPE "ModerationReportTargetType" ADD VALUE IF NOT EXISTS 'CHARACTER_IMAGE';
ALTER TYPE "ModerationReportTargetType" ADD VALUE IF NOT EXISTS 'STUDIO_SUGGESTION';
