-- Inserting, deleting and reordering pages of a finished book. One kind for all
-- three, with the action inside BookEditOperation.classifier, because every list
-- that switches on the kind would otherwise gain three arms instead of one.
--
-- Kept to the ALTER TYPE alone: Postgres refuses to *use* an enum value in the
-- same transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "BookEditOperationKind" ADD VALUE IF NOT EXISTS 'RESTRUCTURE_PAGES';
