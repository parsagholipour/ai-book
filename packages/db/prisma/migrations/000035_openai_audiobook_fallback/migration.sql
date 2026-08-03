-- Persist the actual narrator backend so an interrupted fallback resumes on the
-- same provider, and version rendered media so mobile caches never mix voices.

ALTER TABLE "Audiobook"
    ADD COLUMN "speechProvider" TEXT,
    ADD COLUMN "speechModel" TEXT,
    ADD COLUMN "speechVoice" TEXT,
    ADD COLUMN "fallbackReason" TEXT,
    ADD COLUMN "renderVersion" INTEGER NOT NULL DEFAULT 1;

-- Used by the 24-hour Gemini narration budget preflight across all projects.
CREATE INDEX "ProviderCallLog_provider_model_purpose_createdAt_idx"
    ON "ProviderCallLog"("provider", "model", "purpose", "createdAt");
