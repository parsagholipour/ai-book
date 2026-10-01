-- Book sharing: a finished book published to an unlisted public link
-- (`/s/<slug>`), as a free preview or a paid full share. One share per book,
-- updated in place and revocable. `ShareSlug` records every slug ever issued
-- and is never pruned, so a revoked or deleted share's slug is never reissued.
-- Moderation reports gain a share target, and a creation draft records the
-- share its "Make a book like this" button came from. See
-- .scratch/book-sharing/prompt.md and apps/api/src/mobile/shares/.

-- CreateEnum
CREATE TYPE "BookShareMode" AS ENUM ('PREVIEW', 'FULL');

-- CreateEnum
CREATE TYPE "BookShareCaptionStatus" AS ENUM ('NONE', 'ALLOWED', 'PENDING_REVIEW', 'REMOVED');

-- CreateEnum
CREATE TYPE "BookShareStatus" AS ENUM ('ACTIVE', 'REVOKED', 'TAKEN_DOWN');

-- AlterEnum
ALTER TYPE "ModerationReportTargetType" ADD VALUE 'BOOK_SHARE';

-- AlterTable
ALTER TABLE "MobileCreationDraft" ADD COLUMN     "originShareId" TEXT;

-- AlterTable
ALTER TABLE "ModerationReport" ADD COLUMN     "bookShareId" TEXT;

-- CreateTable
CREATE TABLE "BookShare" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "mode" "BookShareMode" NOT NULL,
    "previewPages" INTEGER,
    "caption" TEXT,
    "captionStatus" "BookShareCaptionStatus" NOT NULL DEFAULT 'NONE',
    "captionVerdict" JSONB,
    "showAuthorName" BOOLEAN NOT NULL DEFAULT false,
    "rightsConfirmedAt" TIMESTAMP(3) NOT NULL,
    "likenessConfirmedAt" TIMESTAMP(3),
    "status" "BookShareStatus" NOT NULL DEFAULT 'ACTIVE',
    "takedownReason" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareSlug" (
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShareSlug_pkey" PRIMARY KEY ("slug")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookShare_projectId_key" ON "BookShare"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "BookShare_slug_key" ON "BookShare"("slug");

-- CreateIndex
CREATE INDEX "BookShare_userId_idx" ON "BookShare"("userId");

-- CreateIndex
CREATE INDEX "BookShare_status_createdAt_idx" ON "BookShare"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MobileCreationDraft_originShareId_idx" ON "MobileCreationDraft"("originShareId");

-- CreateIndex
CREATE INDEX "ModerationReport_bookShareId_createdAt_idx" ON "ModerationReport"("bookShareId", "createdAt");

-- AddForeignKey
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_bookShareId_fkey" FOREIGN KEY ("bookShareId") REFERENCES "BookShare"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookShare" ADD CONSTRAINT "BookShare_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookShare" ADD CONSTRAINT "BookShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

