/**
 * Public billing surface — `@book-maker/db/billing`.
 *
 * The implementation is split across four modules; this file is the only entry
 * point callers (and the `vi.mock("@book-maker/db/billing")` in the API suites)
 * should ever name:
 *
 *   billingInternals.ts     transaction wrapper, row shapes, shared fragments
 *   billingLedger.ts        balances and every credit mutation
 *   billingEntitlements.ts  the durable unlocks credits buy
 *   billingSubscriptions.ts Google Play purchases and subscription state
 */
export {
  InsufficientCreditsError,
  type CreditBalance,
  type CreditLedgerEntryRecord,
  type UserEntitlementRecord
} from "./billingInternals.ts";

export {
  commitReservedCredits,
  getCreditBalance,
  grantCredits,
  refundCreditLedgerEntry,
  refundLatestProjectOperationCredits,
  reserveCredits,
  spendCredits
} from "./billingLedger.ts";

export {
  type ProjectEntitlementType,
  ensureProjectExportEntitlementOrSpend,
  grantProjectEntitlement,
  hasActiveProjectEntitlement,
  hasActiveSubscriptionEntitlement,
  listActiveUserEntitlements,
  revokeEntitlementsForLedgerEntry
} from "./billingEntitlements.ts";

export {
  type ConsumeUsageResult,
  type ImageQuota,
  type PlanAccountRow,
  type PlanSummary,
  ILLUSTRATED_BOOK_COUNTER,
  calendarPeriodKey,
  consumeIllustratedBookUse,
  ensureCurrentPlanPeriod,
  getImageQuota,
  getPlanSummary,
  releaseIllustratedBookUse,
  resolvePlanTier
} from "./planPeriods.ts";

export {
  type GooglePlayPurchaseKind,
  type GooglePlayPurchaseRecordResult,
  type GooglePlaySubscriptionGrantState,
  type VerifiedGooglePlayPurchase,
  ensureDefaultProductCatalog,
  hashPurchaseToken,
  recordVerifiedGooglePlayPurchase
} from "./billingSubscriptions.ts";
