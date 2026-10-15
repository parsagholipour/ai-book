import { type CreditPricing, type PlanTier } from "@book-maker/core";

/**
 * Billing and credit-log response shapes.
 *
 * Split out of `dto.ts` so that file stays under the size budget. `dto.ts`
 * re-exports this module, so every existing `from "./dto.js"` import keeps
 * working.
 */

export type MobileBillingDto = {
  /** Opaque account identity attached to Play checkout and verified on claim. */
  purchaseAccountId: string;
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
    purchaseTokenHash: string | null;
    /**
     * A plan change Play deferred to the end of the paid period (a downgrade):
     * the plan the reader moves to and when. Until then `productSku` is the
     * plan being run out. Absent when nothing is scheduled.
     */
    pendingChange?: { productSku: string; startsAt: string | null };
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
    /** The longest book the free tier generates; plans go to `paidMaxBookPages`. */
    maxBookPages: number;
  };
  /**
   * True while this reader's one-time welcome grant is owed but not yet paid:
   * the AI spend breaker holds a free account's grant while the day is past the
   * soft cap, and the next balance read after it clears pays it. Says nothing
   * about the amount, which is decided when the grant settles.
   */
  welcomeCreditsPending: boolean;
  /**
   * Why a pending grant waits, so the app can say what to do. `email_unverified`
   * — confirm the emailed code (`/api/mobile/auth/email/verification`);
   * `spend_hold` — nothing to do, the spend breaker releases it. Null when
   * nothing is pending. Older builds read only the boolean above.
   */
  welcomeCreditsPendingReason: "email_unverified" | "spend_hold" | null;
  /**
   * What the pending grant would pay if it settled now (the signup country's
   * amount on the price list). Null when nothing is pending. Read it rather than
   * a constant: the amount is an operator setting.
   */
  welcomeCreditsPendingCredits: number | null;
  /**
   * The longest book *this* reader may have generated under the free tier's
   * cap. Null means no free-tier cap — any paid plan, held only to
   * `paidMaxBookPages` — never "unknown".
   */
  maxBookPages: number | null;
  /**
   * The longest book *any* account may have generated right now, a plan
   * included (operator `paidMaxBookPages`, at most 600). The app's page pickers
   * stop here; a longer request is 403 `BOOK_LENGTH_UNAVAILABLE`. An older
   * server never sends it, which the app reads as 600.
   */
  paidMaxBookPages: number;
  /**
   * Whether a new book may start on the Ultra effort (operator `ultraTierEnabled`).
   * The app hides Ultra while it is false; the server refuses it with 422
   * `QUALITY_TIER_UNAVAILABLE` regardless. An older server never sends it.
   */
  ultraTierEnabled: boolean;
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
    /** What one purchase buys in all: a pack's credits, or a plan's credits for one billing period. */
    creditAmount: number;
    /**
     * What a plan grants at the start of each month of its paid time, which is
     * what a subscriber can spend at once: every plan's allowance is granted a
     * month at a time, so the yearly plan's 72,000 a year is 6,000 every month.
     * Null for a credit pack.
     */
    monthlyCreditAmount: number | null;
    priceMicros: number;
    currency: string;
    /** ISO 8601 period a subscription renews on ("P1M", "P1Y"); null for a one-time product. */
    billingPeriod: string | null;
    /** Whether the paywall lists it for this reader; every product stays restorable. */
    offered: boolean;
    /**
     * The Play offer the app buys this plan through when Play lists it for the
     * device's account; Play alone decides who is eligible. Null for none.
     */
    introOfferId: string | null;
    /**
     * Credits the intro offer's discounted period grants, which is less than
     * `creditAmount`: the offer is priced at the floor every per-page rate
     * rests on. Null when there is no intro offer.
     */
    introOfferCredits: number | null;
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
    /** A downgrade Play deferred to renewal; nothing was granted for it now. */
    scheduledChange?: { productSku: string; startsAt: string | null };
  };
  billing: MobileBillingDto;
};
