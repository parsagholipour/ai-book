CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "TemplateCategory" AS ENUM ('KIDS', 'SCIENCE', 'STORY', 'CUSTOM');
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'PLANNING', 'PLAN_READY', 'GENERATING', 'COMPLETE', 'FAILED');
CREATE TYPE "PlanStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED');
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'ACTIVE', 'COMPLETED', 'FAILED');
CREATE TYPE "JobType" AS ENUM ('PLAN_BOOK', 'REVISE_PLAN', 'GENERATE_BOOK', 'GENERATE_PAGE', 'GENERATE_IMAGE', 'COMPILE_EXPORT', 'RESEARCH');
CREATE TYPE "AssetType" AS ENUM ('COVER', 'CHARACTER_REFERENCE', 'SCENE_ILLUSTRATION', 'DIAGRAM');

CREATE TABLE "Template" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" "TemplateCategory" NOT NULL,
  "description" TEXT NOT NULL,
  "defaultConfig" JSONB NOT NULL,
  "styleRules" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Project" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "category" "TemplateCategory" NOT NULL,
  "targetPages" INTEGER NOT NULL,
  "complexity" INTEGER NOT NULL,
  "temperature" DOUBLE PRECISION NOT NULL,
  "language" TEXT NOT NULL DEFAULT 'en',
  "mediaSettings" JSONB NOT NULL,
  "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
  "templateId" TEXT,
  "currentPlanId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlanVersion" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',
  "planningPackage" JSONB NOT NULL,
  "messages" JSONB NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlanVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Chapter" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "index" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "targetPages" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Chapter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Page" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "chapterId" TEXT,
  "index" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "markdown" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "imagePrompt" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Character" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "traits" JSONB NOT NULL,
  "visualRules" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Location" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "rules" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContinuityNote" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "tags" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContinuityNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchSource" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "url" TEXT,
  "summary" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImageAsset" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "pageId" TEXT,
  "type" "AssetType" NOT NULL,
  "prompt" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImageAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GenerationJob" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "type" "JobType" NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "message" TEXT,
  "error" TEXT,
  "bullJobId" TEXT,
  "payload" JSONB NOT NULL,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderCallLog" (
  "id" TEXT NOT NULL,
  "projectId" TEXT,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "promptTokens" INTEGER,
  "outputTokens" INTEGER,
  "cacheHitTokens" INTEGER,
  "costHint" DOUBLE PRECISION,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderCallLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Embedding" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "sourceId" TEXT,
  "text" TEXT NOT NULL,
  "vector" vector(768),
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Embedding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Template_slug_key" ON "Template"("slug");
CREATE UNIQUE INDEX "Project_currentPlanId_key" ON "Project"("currentPlanId");
CREATE UNIQUE INDEX "PlanVersion_projectId_version_key" ON "PlanVersion"("projectId", "version");
CREATE UNIQUE INDEX "Chapter_projectId_index_key" ON "Chapter"("projectId", "index");
CREATE UNIQUE INDEX "Page_projectId_index_key" ON "Page"("projectId", "index");
CREATE INDEX "Embedding_projectId_scope_idx" ON "Embedding"("projectId", "scope");
CREATE INDEX "Embedding_vector_idx" ON "Embedding" USING hnsw ("vector" vector_cosine_ops);

ALTER TABLE "Project" ADD CONSTRAINT "Project_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_currentPlanId_fkey" FOREIGN KEY ("currentPlanId") REFERENCES "PlanVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Chapter" ADD CONSTRAINT "Chapter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Page" ADD CONSTRAINT "Page_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Page" ADD CONSTRAINT "Page_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Character" ADD CONSTRAINT "Character_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Location" ADD CONSTRAINT "Location_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContinuityNote" ADD CONSTRAINT "ContinuityNote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchSource" ADD CONSTRAINT "ResearchSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImageAsset" ADD CONSTRAINT "ImageAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImageAsset" ADD CONSTRAINT "ImageAsset_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderCallLog" ADD CONSTRAINT "ProviderCallLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Embedding" ADD CONSTRAINT "Embedding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
