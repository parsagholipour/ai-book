-- Product analytics for the operator's funnel: app-reported events (a paywall
-- shown, and why) and one row per reader per day of use, for retention.
CREATE TABLE "ProductEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "properties" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserActiveDay" (
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,

    CONSTRAINT "UserActiveDay_pkey" PRIMARY KEY ("userId","day")
);

CREATE INDEX "ProductEvent_name_createdAt_idx" ON "ProductEvent"("name", "createdAt");
CREATE INDEX "ProductEvent_userId_createdAt_idx" ON "ProductEvent"("userId", "createdAt");
CREATE INDEX "UserActiveDay_day_idx" ON "UserActiveDay"("day");

ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserActiveDay" ADD CONSTRAINT "UserActiveDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
