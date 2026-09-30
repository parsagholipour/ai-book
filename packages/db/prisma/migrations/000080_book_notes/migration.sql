-- The owner's private notebook for one book: an optional title and a plain-text
-- body per note, pinned first, then most recently edited. Every kind of book has
-- one; nothing here is printed, exported, screened or sent to a model. Deleting
-- the book deletes its notes. See .scratch/book-notes/spec.md.
CREATE TABLE "BookNote" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookNote_projectId_requestId_key" ON "BookNote"("projectId", "requestId");
CREATE INDEX "BookNote_projectId_pinned_editedAt_idx" ON "BookNote"("projectId", "pinned", "editedAt");

ALTER TABLE "BookNote" ADD CONSTRAINT "BookNote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
