-- A structural page shift commits before its inserted pages can be drafted.
-- These columns make the one delivery allowed to finish that stamped edit a
-- durable, expiring database fact rather than an assumption about BullMQ's
-- lock. A crashed owner can be replaced after expiry; a live one heartbeats.
ALTER TABLE "BookEditOperation"
  ADD COLUMN "structuralLeaseToken" TEXT,
  ADD COLUMN "structuralLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "structuralLeaseCompletedAt" TIMESTAMP(3);
