-- Rendering a plan's character reference sheets used to happen inside one
-- interactive transaction: `pg_advisory_xact_lock` was taken at the top and
-- every image call, every file write and every row write ran under it, with a
-- five-minute statement budget over the lot.
--
-- Tolerating a refused sheet made that budget reachable. The pass no longer
-- stops at the first refusal, and a copyright refusal additionally buys a text
-- call to rewrite the prompt plus a second full primary-then-fallback render,
-- so a cast with two or three of them can outrun 300s — and the abort rolled
-- back every sheet already rendered and paid for while every other image job
-- sat blocked on the lock for the whole window.
--
-- The renders now run between two short transactions instead, which needs a
-- durable stand-in for the lock they no longer sit under: one renderer per
-- plan version, expiring in database time so a worker that dies mid-render is
-- replaced rather than blocking the plan forever. Existing rows are NULL,
-- which reads as "nobody is rendering".
ALTER TABLE "PlanVersion" ADD COLUMN "characterReferenceLeaseToken" TEXT;
ALTER TABLE "PlanVersion" ADD COLUMN "characterReferenceLeaseExpiresAt" TIMESTAMP(3);
