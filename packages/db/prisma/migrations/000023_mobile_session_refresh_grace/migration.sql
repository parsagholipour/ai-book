-- Refresh-token rotation grace window: keep the previous refresh token hash so
-- a retried or racing refresh shortly after rotation does not brick the session.
ALTER TABLE "MobileSession" ADD COLUMN "previousRefreshTokenHash" TEXT;
ALTER TABLE "MobileSession" ADD COLUMN "refreshTokenRotatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "MobileSession_previousRefreshTokenHash_key" ON "MobileSession"("previousRefreshTokenHash");
