CREATE TYPE "BillingProductType" AS ENUM (
  'ONE_TIME_UNLOCK',
  'CREDIT_PACK',
  'SUBSCRIPTION',
  'INTERNAL_GRANT'
);

CREATE TYPE "BillingProvider" AS ENUM (
  'INTERNAL',
  'GOOGLE_PLAY'
);

CREATE TYPE "PurchaseStatus" AS ENUM (
  'PENDING',
  'VERIFIED',
  'GRANTED',
  'FAILED',
  'REVOKED'
);

CREATE TYPE "SubscriptionStatus" AS ENUM (
  'INACTIVE',
  'ACTIVE',
  'GRACE_PERIOD',
  'PAUSED',
  'CANCELED',
  'EXPIRED'
);

CREATE TYPE "UserEntitlementType" AS ENUM (
  'EXPORT_UNLOCK',
  'PREMIUM_PRESET',
  'PREMIUM_REVIEW',
  'EXTRA_IMAGES',
  'CREATOR_PLAN',
  'PRO_PLAN'
);

CREATE TYPE "UserEntitlementStatus" AS ENUM (
  'ACTIVE',
  'CONSUMED',
  'EXPIRED',
  'REVOKED'
);

CREATE TYPE "CreditLedgerEntryType" AS ENUM (
  'GRANT',
  'RESERVE',
  'SPEND',
  'REFUND',
  'RELEASE',
  'ADJUSTMENT'
);

CREATE TYPE "CreditLedgerEntryStatus" AS ENUM (
  'RESERVED',
  'SETTLED',
  'REFUNDED',
  'VOIDED'
);

CREATE TYPE "CreditOperation" AS ENUM (
  'PLAN_GENERATION',
  'PREVIEW_GENERATION',
  'FULL_BOOK_GENERATION',
  'IMAGE_GENERATION',
  'COVER_REGENERATION',
  'PREMIUM_REVIEW',
  'EXPORT_UNLOCK',
  'PURCHASE_CREDIT_GRANT',
  'SUBSCRIPTION_CREDIT_GRANT',
  'ADMIN_GRANT'
);

CREATE TABLE "ProductCatalog" (
  "id" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "productType" "BillingProductType" NOT NULL,
  "provider" "BillingProvider" NOT NULL DEFAULT 'GOOGLE_PLAY',
  "creditAmount" INTEGER NOT NULL DEFAULT 0,
  "priceMicros" BIGINT,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductCatalog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserCreditAccount" (
  "userId" TEXT NOT NULL,
  "availableCredits" INTEGER NOT NULL DEFAULT 0,
  "reservedCredits" INTEGER NOT NULL DEFAULT 0,
  "lifetimeCreditsGranted" INTEGER NOT NULL DEFAULT 0,
  "lifetimeCreditsSpent" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserCreditAccount_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "UserEntitlement" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT,
  "type" "UserEntitlementType" NOT NULL,
  "status" "UserEntitlementStatus" NOT NULL DEFAULT 'ACTIVE',
  "source" TEXT NOT NULL,
  "creditsCost" INTEGER NOT NULL DEFAULT 0,
  "relatedLedgerEntryId" TEXT,
  "purchaseRecordId" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditLedgerEntry" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT,
  "generationJobId" TEXT,
  "productId" TEXT,
  "purchaseRecordId" TEXT,
  "entryType" "CreditLedgerEntryType" NOT NULL,
  "status" "CreditLedgerEntryStatus" NOT NULL DEFAULT 'SETTLED',
  "operation" "CreditOperation" NOT NULL,
  "amountCredits" INTEGER NOT NULL,
  "balanceAfterCredits" INTEGER,
  "idempotencyKey" TEXT NOT NULL,
  "reversesEntryId" TEXT,
  "description" TEXT,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreditLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseRecord" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "productId" TEXT,
  "provider" "BillingProvider" NOT NULL DEFAULT 'GOOGLE_PLAY',
  "externalPurchaseId" TEXT,
  "purchaseTokenHash" TEXT,
  "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING',
  "creditsGranted" INTEGER NOT NULL DEFAULT 0,
  "amountMicros" BIGINT,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "purchasedAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PurchaseRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SubscriptionState" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "productId" TEXT,
  "provider" "BillingProvider" NOT NULL DEFAULT 'GOOGLE_PLAY',
  "externalSubscriptionId" TEXT,
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'INACTIVE',
  "creditsPerPeriod" INTEGER NOT NULL DEFAULT 0,
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "nextCreditGrantAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductCatalog_sku_key" ON "ProductCatalog"("sku");
CREATE INDEX "UserEntitlement_userId_type_status_idx" ON "UserEntitlement"("userId", "type", "status");
CREATE INDEX "UserEntitlement_projectId_type_status_idx" ON "UserEntitlement"("projectId", "type", "status");
CREATE INDEX "UserEntitlement_relatedLedgerEntryId_idx" ON "UserEntitlement"("relatedLedgerEntryId");
CREATE UNIQUE INDEX "CreditLedgerEntry_idempotencyKey_key" ON "CreditLedgerEntry"("idempotencyKey");
CREATE UNIQUE INDEX "CreditLedgerEntry_reversesEntryId_key" ON "CreditLedgerEntry"("reversesEntryId");
CREATE INDEX "CreditLedgerEntry_userId_createdAt_idx" ON "CreditLedgerEntry"("userId", "createdAt");
CREATE INDEX "CreditLedgerEntry_projectId_operation_idx" ON "CreditLedgerEntry"("projectId", "operation");
CREATE INDEX "CreditLedgerEntry_generationJobId_idx" ON "CreditLedgerEntry"("generationJobId");
CREATE INDEX "CreditLedgerEntry_purchaseRecordId_idx" ON "CreditLedgerEntry"("purchaseRecordId");
CREATE INDEX "PurchaseRecord_userId_createdAt_idx" ON "PurchaseRecord"("userId", "createdAt");
CREATE INDEX "PurchaseRecord_provider_externalPurchaseId_idx" ON "PurchaseRecord"("provider", "externalPurchaseId");
CREATE INDEX "PurchaseRecord_purchaseTokenHash_idx" ON "PurchaseRecord"("purchaseTokenHash");
CREATE INDEX "SubscriptionState_userId_status_idx" ON "SubscriptionState"("userId", "status");
CREATE INDEX "SubscriptionState_provider_externalSubscriptionId_idx" ON "SubscriptionState"("provider", "externalSubscriptionId");

ALTER TABLE "UserCreditAccount" ADD CONSTRAINT "UserCreditAccount_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserEntitlement" ADD CONSTRAINT "UserEntitlement_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserEntitlement" ADD CONSTRAINT "UserEntitlement_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserEntitlement" ADD CONSTRAINT "UserEntitlement_relatedLedgerEntryId_fkey"
  FOREIGN KEY ("relatedLedgerEntryId") REFERENCES "CreditLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UserEntitlement" ADD CONSTRAINT "UserEntitlement_purchaseRecordId_fkey"
  FOREIGN KEY ("purchaseRecordId") REFERENCES "PurchaseRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_generationJobId_fkey"
  FOREIGN KEY ("generationJobId") REFERENCES "GenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "ProductCatalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_purchaseRecordId_fkey"
  FOREIGN KEY ("purchaseRecordId") REFERENCES "PurchaseRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_reversesEntryId_fkey"
  FOREIGN KEY ("reversesEntryId") REFERENCES "CreditLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PurchaseRecord" ADD CONSTRAINT "PurchaseRecord_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchaseRecord" ADD CONSTRAINT "PurchaseRecord_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "ProductCatalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SubscriptionState" ADD CONSTRAINT "SubscriptionState_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SubscriptionState" ADD CONSTRAINT "SubscriptionState_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "ProductCatalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
