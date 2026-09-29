-- One long or priced Writing Studio AI request (illustrate, draft a chapter,
-- margin notes, consistency, outline) or a free internal pass a publish queues
-- (style profile, re-embed). Run by a WRITING_ASSIST job; the result is a
-- suggestion the author applies by hand.
CREATE TABLE "ManuscriptAssist" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "chapterId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "input" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "creditsCharged" INTEGER NOT NULL DEFAULT 0,
    "ledgerEntryId" TEXT,
    "generationJobId" TEXT,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManuscriptAssist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ManuscriptAssist_generationJobId_key" ON "ManuscriptAssist"("generationJobId");
CREATE UNIQUE INDEX "ManuscriptAssist_projectId_requestId_key" ON "ManuscriptAssist"("projectId", "requestId");
CREATE INDEX "ManuscriptAssist_projectId_status_idx" ON "ManuscriptAssist"("projectId", "status");

ALTER TABLE "ManuscriptAssist" ADD CONSTRAINT "ManuscriptAssist_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
