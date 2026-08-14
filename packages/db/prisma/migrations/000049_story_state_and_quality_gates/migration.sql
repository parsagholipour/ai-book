-- Live story state for the context pack, rebuilt from per-page deltas.
-- Quality gates are an append-only revision table (empty = compiled defaults).
ALTER TABLE "Project" ADD COLUMN "storyState" JSONB;
ALTER TABLE "Page" ADD COLUMN "storyDelta" JSONB;
ALTER TABLE "PageEditSnapshot" ADD COLUMN "storyDeltaBefore" JSONB;

CREATE TABLE "GenerationQualityRevision" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "settings" JSONB NOT NULL,
    "note" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationQualityRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GenerationQualityRevision_version_key" ON "GenerationQualityRevision"("version");
CREATE INDEX "GenerationQualityRevision_createdAt_idx" ON "GenerationQualityRevision"("createdAt");
