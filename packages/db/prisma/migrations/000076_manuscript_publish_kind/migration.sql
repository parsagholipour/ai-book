-- The Writing Studio's publish: the author's working copy materialized into the
-- book's pages. Kept to the ALTER TYPE alone: Postgres refuses to *use* an enum
-- value in the same transaction that added it, and Prisma runs each migration in
-- one.
ALTER TYPE "BookEditOperationKind" ADD VALUE IF NOT EXISTS 'MANUSCRIPT_PUBLISH';
