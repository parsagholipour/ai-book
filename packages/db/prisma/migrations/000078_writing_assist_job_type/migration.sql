-- The Writing Studio's long assists run as one job type. Kept to the ALTER TYPE
-- alone: Postgres refuses to *use* an enum value in the same transaction that
-- added it, and Prisma runs each migration in one.
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'WRITING_ASSIST';
