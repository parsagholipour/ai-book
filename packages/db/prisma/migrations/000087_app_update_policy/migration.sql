-- Operator-controlled app updates. Each revision is the whole list of store
-- releases and the policy each one sets for older builds (silent, prompt,
-- required). Empty table = no release has asked anything of anyone.
CREATE TABLE "AppUpdatePolicyRevision" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "releases" JSONB NOT NULL,
    "note" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppUpdatePolicyRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppUpdatePolicyRevision_version_key" ON "AppUpdatePolicyRevision"("version");
CREATE INDEX "AppUpdatePolicyRevision_createdAt_idx" ON "AppUpdatePolicyRevision"("createdAt");
