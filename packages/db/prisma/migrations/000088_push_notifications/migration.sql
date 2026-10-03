-- Push notifications: the installs a user's books may be announced to, and
-- what the API's push sweep last told them about each generation in flight.
CREATE TYPE "PushPlatform" AS ENUM ('ANDROID', 'IOS');

CREATE TABLE "PushDevice" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushDevice_token_key" ON "PushDevice"("token");
CREATE INDEX "PushDevice_userId_idx" ON "PushDevice"("userId");
CREATE INDEX "PushDevice_sessionId_idx" ON "PushDevice"("sessionId");

ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MobileSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProjectPushState" (
    "projectId" TEXT NOT NULL,
    "percent" INTEGER NOT NULL,
    "detail" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3) NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectPushState_pkey" PRIMARY KEY ("projectId")
);

ALTER TABLE "ProjectPushState" ADD CONSTRAINT "ProjectPushState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
