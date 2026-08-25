ALTER TABLE "BookEditOperation"
ADD COLUMN "publicationRevision" INTEGER;

-- Do not infer ownership for every historical APPLIED row. Most of those edits
-- were published long ago, and neither an APPLIED verdict nor recency identifies
-- which Project.contentRevision they produced. The one upgrade window with
-- durable, unambiguous ownership is an edit whose own APPLY_BOOK_EDIT job is
-- still open: its mutation committed, but processJob has not terminalized the
-- delivery yet. Adopt only that row, only while no later operation or project
-- job exists, and never adopt the durable no-op/undo shapes whose handlers have
-- no publication tail. Runtime repeats this proof for rolling deployments where
-- an old worker can cross the migration after this statement has run.
UPDATE "BookEditOperation" AS operation
SET "publicationRevision" = project."contentRevision"
FROM "Project" AS project, "GenerationJob" AS owner_job
WHERE operation."projectId" = project."id"
  AND operation."generationJobId" = owner_job."id"
  AND owner_job."projectId" = operation."projectId"
  AND owner_job."type" = 'APPLY_BOOK_EDIT'
  AND owner_job."status" IN ('QUEUED', 'ACTIVE')
  AND operation."status" = 'APPLIED'
  AND operation."appliedAt" IS NOT NULL
  AND operation."kind" IN (
    'LOCAL_PATCH',
    'PAGE_REWRITE',
    'CHAPTER_REGENERATE',
    'ADD_IMAGE',
    'MOVE_IMAGE',
    'REMOVE_IMAGE',
    'RESTRUCTURE_PAGES'
  )
  AND project."status" IN ('EDITING', 'COMPLETE', 'REVIEW_REQUIRED')
  AND NOT (operation."classifier" ? 'undoneAt')
  AND NOT (operation."classifier" ? 'structuralRolledBackAt')
  AND NOT (operation."classifier" @> '{"textExactSkipped":true}'::jsonb)
  AND NOT (operation."classifier" @> '{"layoutMissing":true}'::jsonb)
  AND NOT (operation."classifier" ? 'structuralSkipped')
  AND NOT EXISTS (
    SELECT 1
    FROM "BookEditOperation" AS later_operation
    WHERE later_operation."projectId" = operation."projectId"
      AND (
        later_operation."createdAt" > operation."createdAt"
        OR (
          later_operation."createdAt" = operation."createdAt"
          AND later_operation."id" > operation."id"
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "GenerationJob" AS later_job
    WHERE later_job."projectId" = operation."projectId"
      AND later_job."id" <> owner_job."id"
      AND later_job."createdAt" >= operation."appliedAt"
  );
