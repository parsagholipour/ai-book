ALTER TYPE "JobType" ADD VALUE 'IMPORT_BOOK';
ALTER TYPE "JobType" ADD VALUE 'CONTINUE_BOOK';
ALTER TYPE "BookEditOperationKind" ADD VALUE 'CONTINUE_BOOK';

CREATE TABLE "BookImport" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "requestId" TEXT,
  "projectId" TEXT,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'UPLOADED',
  "error" TEXT,
  "stats" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookImport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookImport_projectId_key" ON "BookImport"("projectId");
CREATE UNIQUE INDEX "BookImport_userId_requestId_key" ON "BookImport"("userId", "requestId");
CREATE INDEX "BookImport_userId_createdAt_idx" ON "BookImport"("userId", "createdAt");

ALTER TABLE "BookImport" ADD CONSTRAINT "BookImport_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BookImport" ADD CONSTRAINT "BookImport_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
