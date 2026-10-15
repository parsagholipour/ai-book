-- Operator moderation of an account (apps/api/src/accountModeration.ts): a
-- reversible suspension and a per-account sharing switch, each recorded with
-- the reason the operator gave. Until now only account deletion changed a
-- user's status, and a takedown blocked one book's share at a time.
--
-- SUSPENDED is distinct from DISABLED, which is a deleted account's tombstone:
-- the deletion, renewal and Play-cancellation sweeps read DISABLED. Nothing in
-- this file uses the new value — Postgres refuses to use an enum value in the
-- transaction that added it — and every existing reader asks for ACTIVE.
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'SUSPENDED';

-- Nullable with no default: a metadata-only change, no table rewrite.
ALTER TABLE "User" ADD COLUMN "sharingDisabledAt" TIMESTAMP(3);

CREATE TYPE "AccountModerationActionKind" AS ENUM ('SUSPEND', 'UNSUSPEND', 'DISABLE_SHARING', 'ENABLE_SHARING');

-- A new, empty table: nothing else reads or writes it, so it locks nothing in use.
CREATE TABLE "AccountModerationAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" "AccountModerationActionKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "operatorUserId" TEXT,
    "effects" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountModerationAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountModerationAction_userId_createdAt_idx" ON "AccountModerationAction"("userId", "createdAt");

ALTER TABLE "AccountModerationAction" ADD CONSTRAINT "AccountModerationAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
