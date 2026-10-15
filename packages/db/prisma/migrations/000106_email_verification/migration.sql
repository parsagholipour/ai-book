-- Email verification gates the welcome grant (packages/db/src/welcomeCredits.ts).
-- Signup wrote a PENDING WelcomeCreditGrant that settled on the first balance
-- read, held back only by a per-address cap, so rotating addresses farmed the
-- welcome credits once per invented email (launch review, 2026-10-13). A grant
-- now settles GRANTED only for an account whose address is proven: a 6-digit
-- code mailed and confirmed (apps/api/src/mobileEmailVerification.ts), or a
-- Google sign-in, whose ID token must already say `email_verified`.

-- Nullable, no default: adding it rewrites nothing and locks "User" only for
-- the catalog change.
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

CREATE TABLE "EmailVerificationRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "requestIpHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailVerificationRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailVerificationRequest_userId_createdAt_idx"
    ON "EmailVerificationRequest"("userId", "createdAt");

ALTER TABLE "EmailVerificationRequest"
    ADD CONSTRAINT "EmailVerificationRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill. A Google-linked account proved its address through Google's
-- `email_verified` when it was created or linked.
UPDATE "User"
   SET "emailVerifiedAt" = CURRENT_TIMESTAMP
 WHERE "googleSubject" IS NOT NULL
   AND "emailVerifiedAt" IS NULL;

-- Grandfathered: an account already welcomed keeps what it has and is not
-- asked to verify for a grant it already received. Stamped with the grant's
-- own settlement time. A deleted account's tombstone is left unverified.
UPDATE "User" AS u
   SET "emailVerifiedAt" = COALESCE(g."settledAt", CURRENT_TIMESTAMP)
  FROM "WelcomeCreditGrant" AS g
 WHERE g."userId" = u."id"
   AND g."outcome" = 'GRANTED'
   AND u."emailVerifiedAt" IS NULL
   AND u."email" NOT LIKE 'deleted-%@deleted.invalid';

-- Everyone else, including every account whose grant is still PENDING, starts
-- unverified: that grant now waits for a confirmed code.
