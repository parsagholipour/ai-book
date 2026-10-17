-- Speculative composition prep (harness redesign H4): a composed book's stance,
-- brief inventory, episodes and chapter form plan, planned while its reader is
-- still reading the plan (apps/worker/src/handlers/prepareComposition.ts). Kept
-- to the ALTER TYPE alone: Postgres refuses to *use* an enum value in the same
-- transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'PREPARE_COMPOSITION';
