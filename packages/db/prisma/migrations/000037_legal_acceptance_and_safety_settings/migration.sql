CREATE TABLE "LegalAcceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "privacyVersion" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "termsAttested" BOOLEAN NOT NULL,
    "ageGuardianAttested" BOOLEAN NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "LegalAcceptance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SafetySettingsRevision" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "copyrightRestrictionsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SafetySettingsRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SafetySettingsRevision_version_key" ON "SafetySettingsRevision"("version");
CREATE INDEX "SafetySettingsRevision_createdAt_idx" ON "SafetySettingsRevision"("createdAt");
CREATE INDEX "LegalAcceptance_userId_termsVersion_privacyVersion_acceptedAt_idx"
    ON "LegalAcceptance"("userId", "termsVersion", "privacyVersion", "acceptedAt");
CREATE INDEX "LegalAcceptance_acceptedAt_idx" ON "LegalAcceptance"("acceptedAt");

ALTER TABLE "LegalAcceptance"
    ADD CONSTRAINT "LegalAcceptance_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
