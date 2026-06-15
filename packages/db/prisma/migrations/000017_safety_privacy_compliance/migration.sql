CREATE TYPE "ModerationReportTargetType" AS ENUM (
  'PROJECT',
  'IMAGE_ASSET'
);

CREATE TYPE "ModerationReportReason" AS ENUM (
  'OFFENSIVE',
  'HATE_OR_HARASSMENT',
  'SEXUAL_CONTENT',
  'VIOLENCE_OR_SELF_HARM',
  'CHILD_SAFETY',
  'DECEPTIVE_OR_MISLEADING',
  'PRIVACY_OR_COPYRIGHT',
  'OTHER'
);

CREATE TYPE "ModerationReportStatus" AS ENUM (
  'PENDING',
  'REVIEWED',
  'ACTIONED',
  'DISMISSED'
);

CREATE TYPE "AccountDeletionRequestStatus" AS ENUM (
  'PENDING',
  'COMPLETED',
  'CANCELED',
  'REJECTED'
);

CREATE TABLE "ModerationReport" (
  "id" TEXT NOT NULL,
  "reporterUserId" TEXT,
  "projectId" TEXT,
  "imageAssetId" TEXT,
  "targetType" "ModerationReportTargetType" NOT NULL,
  "reason" "ModerationReportReason" NOT NULL,
  "comment" TEXT,
  "status" "ModerationReportStatus" NOT NULL DEFAULT 'PENDING',
  "targetSnapshot" JSONB NOT NULL,
  "reviewerUserId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNotes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ModerationReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountDeletionRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "email" TEXT NOT NULL,
  "status" "AccountDeletionRequestStatus" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT,
  "metadata" JSONB NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AccountDeletionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ModerationReport_reporterUserId_createdAt_idx" ON "ModerationReport"("reporterUserId", "createdAt");
CREATE INDEX "ModerationReport_projectId_createdAt_idx" ON "ModerationReport"("projectId", "createdAt");
CREATE INDEX "ModerationReport_imageAssetId_createdAt_idx" ON "ModerationReport"("imageAssetId", "createdAt");
CREATE INDEX "ModerationReport_status_createdAt_idx" ON "ModerationReport"("status", "createdAt");
CREATE INDEX "AccountDeletionRequest_userId_status_idx" ON "AccountDeletionRequest"("userId", "status");
CREATE INDEX "AccountDeletionRequest_email_requestedAt_idx" ON "AccountDeletionRequest"("email", "requestedAt");

ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_reporterUserId_fkey"
  FOREIGN KEY ("reporterUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_reviewerUserId_fkey"
  FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_imageAssetId_fkey"
  FOREIGN KEY ("imageAssetId") REFERENCES "ImageAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AccountDeletionRequest" ADD CONSTRAINT "AccountDeletionRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
