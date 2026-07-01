CREATE TABLE "MobileCreationOutput" (
  "id" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MobileCreationOutput_pkey" PRIMARY KEY ("id")
);

INSERT INTO "MobileCreationOutput" (
  "id",
  "draftId",
  "projectId",
  "title",
  "sequence",
  "createdAt",
  "updatedAt"
)
SELECT
  concat('legacy_', md5(d."id" || ':' || d."createdProjectId")),
  d."id",
  d."createdProjectId",
  COALESCE(p."title", 'Book output'),
  1,
  d."updatedAt",
  d."updatedAt"
FROM "MobileCreationDraft" d
LEFT JOIN "Project" p ON p."id" = d."createdProjectId"
WHERE d."createdProjectId" IS NOT NULL;

CREATE UNIQUE INDEX "MobileCreationOutput_draftId_projectId_key"
  ON "MobileCreationOutput"("draftId", "projectId");

CREATE UNIQUE INDEX "MobileCreationOutput_draftId_sequence_key"
  ON "MobileCreationOutput"("draftId", "sequence");

CREATE INDEX "MobileCreationOutput_draftId_sequence_idx"
  ON "MobileCreationOutput"("draftId", "sequence");

CREATE INDEX "MobileCreationOutput_projectId_idx"
  ON "MobileCreationOutput"("projectId");

ALTER TABLE "MobileCreationOutput"
  ADD CONSTRAINT "MobileCreationOutput_draftId_fkey"
  FOREIGN KEY ("draftId") REFERENCES "MobileCreationDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MobileCreationOutput"
  ADD CONSTRAINT "MobileCreationOutput_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
