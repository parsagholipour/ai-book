import { type CreditPricing, type PlanTier } from "@book-maker/core";

/**
 * Billing and credit-log response shapes.
 *
 * Split out of `dto.ts` so that file stays under the size budget. `dto.ts`
 * re-exports this module, so every existing `from "./dto.js"` import keeps
 * working.
 */

export type MobileBillingDto = {
  messageAllowance: import("@book-maker/db/billing").MessageAllowance;
  credits: {
    /** Everything the user can spend right now: allowance plus purchased. */
    available: number;
    /** The part of `available` that came from a purchase and never expires. */
    purchased: number;
    reserved: number;
    lifetimeGranted: number;
    lifetimeSpent: number;
  };
  plan: {
    tier: PlanTier;
    source: "free" | "google_play";
    /** Google Play subscription status, or null on the free tier. */
    status: string | null;
    /** Null once the plan has been cancelled — read `endsAt` instead. */
    renewsAt: string | null;
    /** The plan is running out its last paid period and then drops to free. */
    cancelAtPeriodEnd: boolean;
    /** When that drop happens. Null while the plan is still renewing. */
    endsAt: string | null;
    /**
     * Whether this backend can end the subscription itself. Only the mock Play
     * verifier can; against real Play the app has to send the reader to the Play
     * subscription centre, because that is where Google requires it to happen.
     */
    canCancelInApp: boolean;
    productSku: string | null;
  };
  /**
   * What the free tier grants, whether or not the reader is on it. Both
   * numbers are the *tier offer*, the same for every reader: the recurring
   * monthly allowance, plus an optional one-time welcome grant. An IP-skipped
   * welcome is silent — this object never identifies a skipped account.
   */
  freeTier: {
    monthlyCredits: number;
    welcomeCredits: number;
    illustratedBooksPerMonth: number;
    /** The longest book the free tier generates; plans go to 600. */
    maxBookPages: number;
  };
  /**
   * The longest book *this* reader may have generated. Null means no free-tier
   * cap — any paid plan, held only to the 600-page ceiling — never "unknown".
   */
  maxBookPages: number | null;
  allowance: {
    /** What this plan grants each period. */
    monthlyCredits: number;
    /** What is left of it. Resets rather than carrying over. */
    planCredits: number;
    resetsAt: string | null;
  };
  /** Null means no image limit on this plan — unlimited, not unknown. */
  imageQuota: {
    used: number;
    limit: number;
    resetsAt: string;
  } | null;
  entitlements: Array<{
    id: string;
    type: string;
    projectId: string | null;
    status: string;
    source: string;
    creditsCost: number;
    startsAt: string;
    expiresAt: string | null;
  }>;
  creditCosts: CreditPricing;
  products: Array<{
    sku: string;
    title: string;
    description: string;
    productType: string;
    creditAmount: number;
    priceMicros: number;
    currency: string;
  }>;
};

/**
 * What a ledger row meant to the reader, not what it meant to the ledger.
 * `spend` covers every charge; the rest say where credits came from or why they
 * left without being spent.
 */
export type MobileCreditLogKind =
  | "purchase"
  | "subscription"
  | "monthly"
  | "bonus"
  | "spend"
  | "refund"
  | "expired";

export type MobileCreditLogEntryDto = {
  id: string;
  createdAt: string;
  /** `in` added credits, `out` took them. */
  direction: "in" | "out";
  /** Whole credits moved, always positive — the sign is `direction`. */
  credits: number;
  kind: MobileCreditLogKind;
  /**
   * Already in the reader's words. Built here rather than in the app so a new
   * `CreditOperation` reads correctly without a client release — and because the
   * stored `description` can carry raw provider errors, which never ship.
   */
  title: string;
  /** Held against work still running: charged, but not yet settled. */
  pending: boolean;
  /** The charge came back. The row is history, not a movement. */
  refunded: boolean;
  projectId: string | null;
  /** The book this touched, when it still exists. */
  projectTitle: string | null;
};

export type MobileCreditLogDto = {
  entries: MobileCreditLogEntryDto[];
  /** Send back as `cursor` for the next page. Null at the end of the history. */
  nextCursor: string | null;
};

export type MobileBillingResponseDto = {
  billing: MobileBillingDto;
};

export type MobileGooglePlayVerificationResponseDto = {
  purchase: {
    id: string;
    status: string;
    creditsGranted: number;
    subscriptionStatus: string | null;
    entitlementType: string | null;
  };
  billing: MobileBillingDto;
};
