-- CreateEnum
CREATE TYPE "VoiceCharacterStatus" AS ENUM ('CANDIDATE', 'APPROVED', 'BUILDING', 'READY', 'REJECTED', 'FAILED');

-- AlterEnum
ALTER TYPE "AssetType" ADD VALUE 'CHARACTER_PROFILE';

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'PREPARE_CHARACTER_CANDIDATES';
ALTER TYPE "JobType" ADD VALUE 'BUILD_CHARACTER_PERSONA';

-- CreateTable
CREATE TABLE "VoiceCharacter" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "planVersionId" TEXT,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "traits" JSONB NOT NULL,
    "visualRules" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'PLAN',
    "status" "VoiceCharacterStatus" NOT NULL DEFAULT 'CANDIDATE',
    "persona" JSONB,
    "voiceProfile" JSONB NOT NULL,
    "voiceProvider" TEXT NOT NULL DEFAULT 'gemini_live',
    "voiceModel" TEXT,
    "voiceId" TEXT,
    "providerMetadata" JSONB NOT NULL,
    "profileImageAssetId" TEXT,
    "error" TEXT,
    "approvedAt" TIMESTAMP(3),
    "builtAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceCharacter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VoiceCharacter_projectId_status_idx" ON "VoiceCharacter"("projectId", "status");

-- CreateIndex
CREATE INDEX "VoiceCharacter_planVersionId_idx" ON "VoiceCharacter"("planVersionId");

-- AddForeignKey
ALTER TABLE "VoiceCharacter" ADD CONSTRAINT "VoiceCharacter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
