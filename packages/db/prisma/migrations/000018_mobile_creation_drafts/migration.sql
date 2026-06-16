CREATE TABLE "MobileCreationDraft" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "advisorSnapshot" JSONB,
  "createdProjectId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MobileCreationDraft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MobileCreationDraft_userId_status_updatedAt_idx"
  ON "MobileCreationDraft"("userId", "status", "updatedAt");

CREATE INDEX "MobileCreationDraft_createdProjectId_idx"
  ON "MobileCreationDraft"("createdProjectId");

ALTER TABLE "MobileCreationDraft" ADD CONSTRAINT "MobileCreationDraft_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
