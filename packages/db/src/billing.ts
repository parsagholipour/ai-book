/**
 * Public billing surface — `@book-maker/db/billing`.
 *
 * The implementation is split across these modules; this file is the only entry
 * point callers (and the `vi.mock("@book-maker/db/billing")` in the API suites)
 * should ever name:
 *
 *   billingInternals.ts     transaction wrapper, row shapes, shared fragments
 *   billingLedger.ts        balances and every credit mutation
 *   billingEntitlements.ts  the durable unlocks credits buy
 *   billingSubscriptions.ts Google Play purchases and subscription state
 *   planPeriods.ts          allowances and quotas
 *   welcomeCredits.ts       one-time welcome grant
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
  refundCreditLedgerEntryPortion,
  refundLatestProjectOperationCredits,
  refundedLedgerEntryIds,
  releaseReservationsByKeyPrefix,
  reserveCredits,
  spendCredits
} from "./billingLedger.ts";

export {
  type ProjectEntitlementType,
  ensureProjectExportEntitlementOrSpend,
  grantProjectEntitlement,
  hasActiveProjectEntitlement,
  hasActiveSubscriptionEntitlement,
  listActiveUserEntitlements
} from "./billingEntitlements.ts";

export { WELCOME_CREDITS_IP_WINDOW_DAYS, ensureWelcomeCreditsTx, getWelcomeCreditsGranted } from "./welcomeCredits.ts";

export {
  type ConsumeUsageResult,
  type ImageQuota,
  type MonthlyQuota,
  type PlanAccountRow,
  type PlanSummary,
  ILLUSTRATED_BOOK_COUNTER,
  MANUSCRIPT_IMPORT_COUNTER,
  calendarPeriodKey,
  consumeIllustratedBookUse,
  consumeManuscriptImportUse,
  consumeManuscriptImportUseTx,
  ensureCurrentPlanPeriod,
  getBookPageLimit,
  getImageQuota,
  getImportQuota,
  getPlanSummary,
  releaseIllustratedBookUse,
  releaseManuscriptImportUse,
  resolvePlanTier
} from "./planPeriods.ts";

export {
  type EndSubscriptionResult,
  type GooglePlayPurchaseKind,
  type GooglePlayPurchaseRecordResult,
  type GooglePlaySubscriptionGrantState,
  type VerifiedGooglePlayPurchase,
  endSubscriptionNow,
  ensureDefaultProductCatalog,
  hashPurchaseToken,
  recordVerifiedGooglePlayPurchase
} from "./billingSubscriptions.ts";

export { recordGooglePlayRefund, type GooglePlayRefundNotice } from "./googlePlayRefunds.ts";

export {
  GenerationAttemptConflictError,
  GenerationAttemptJobClaimError,
  GenerationQuotaExceededError,
  type GenerationAttemptDomainResult,
  type GenerationAttemptRecord,
  type StartGenerationAttemptOptions,
  type StartGenerationAttemptResult,
  failGenerationAttempt,
  failGenerationAttemptTx,
  getGenerationAttempt,
  markGenerationAttemptActive,
  markGenerationAttemptSucceeded,
  reconcileGenerationAttemptRefunds,
  settledGenerationAttemptIds,
  startGenerationAttempt
} from "./generationAttempts.ts";

export {
  MessageAllowanceError,
  type MessageAllowance,
  getMessageAllowance,
  reserveMessageUsage,
  consumeAiProcessingUsageTx,
  refundAiProcessingUsageTx,
  type MessageUsageLease,
  completeMessageUsage,
  renewMessageUsage,
  recoverMessageUsage,
  settleMessageUsage,
  resetMessageAllowance
} from "./messageUsage.ts";

export {
  VOICE_RELAY_LEASE_MS, VOICE_RELAY_RECOVERY_GRACE_MS, VoiceRelayError,
  startVoiceRelayCall, saveVoiceRelaySession, claimVoiceRelayCall, authorizeVoiceRelay,
  readVoiceRelayMeter, requestVoiceRelayEnd, finishVoiceRelay, recoverVoiceRelayCalls,
  type VoiceRelaySession, type VoiceRelayLease, type VoiceRelayMeter
} from "./voiceRelayBilling.ts";
