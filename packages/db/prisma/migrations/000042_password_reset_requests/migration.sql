-- Forgot-password verification codes. The emailed 6-digit code is stored only
-- as a scrypt hash; `attempts` caps guesses per code so the small keyspace
-- cannot be walked online, and the expiry bounds how long a leaked hash is
-- worth brute-forcing offline.
CREATE TABLE "PasswordResetRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "requestIpHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PasswordResetRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PasswordResetRequest_userId_consumedAt_expiresAt_idx"
    ON "PasswordResetRequest"("userId", "consumedAt", "expiresAt");

ALTER TABLE "PasswordResetRequest"
    ADD CONSTRAINT "PasswordResetRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
