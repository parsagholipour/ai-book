ALTER TABLE "ProviderCallLog" ADD COLUMN "generationJobId" TEXT;

ALTER TABLE "ProviderCallLog" ADD CONSTRAINT "ProviderCallLog_generationJobId_fkey" FOREIGN KEY ("generationJobId") REFERENCES "GenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ProviderCallLog_generationJobId_idx" ON "ProviderCallLog"("generationJobId");
