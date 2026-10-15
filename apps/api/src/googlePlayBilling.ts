import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "@book-maker/core";
import type { GooglePlaySubscriptionGrantState, VerifiedGooglePlayPurchase } from "@book-maker/db/billing";
import {
  DEFAULT_GOOGLE_TOKEN_URI,
  parseServiceAccountCredentials,
  signServiceAccountJwt,
  type ServiceAccountCredentials
} from "./googleServiceAccount.js";

type FetchLike = typeof fetch;

const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

export type GooglePlayProductType = "ONE_TIME_UNLOCK" | "CREDIT_PACK" | "SUBSCRIPTION" | "INTERNAL_GRANT";

export type GooglePlayVerificationRequest = {
  packageName: string;
  productId: string;
  productType: GooglePlayProductType | string;
  purchaseToken: string;
};

export interface GooglePlayVerifier {
  verifyPurchase(request: GooglePlayVerificationRequest): Promise<VerifiedGooglePlayPurchase>;
  readRefundableQuantity?(request: { packageName: string; purchaseToken: string; orderId: string }):
    Promise<{ quantity: number; refundableQuantity: number }>;
  /**
   * Acknowledges a purchase with Google. Play refunds anything unacknowledged
   * after three days, and only the app used to do it — after the server had
   * already granted the credits — so an app killed in between left a refunded
   * payment and credits that stayed. Idempotent on Google's side.
   */
  acknowledgePurchase(request: GooglePlayVerificationRequest): Promise<void>;
  /**
   * Stops a subscription's future payments for good (Google's
   * `DEVELOPER_REQUESTED_STOP_PAYMENTS`): the paid period runs out and nothing
   * renews. Used when the account that owns it is deleted, because Google
   * otherwise keeps charging a tombstone. Idempotent on Google's side.
   */
  cancelSubscription(request: { packageName: string; purchaseToken: string }): Promise<void>;
}

/** Whether a verified purchase still needs acknowledging, read off what Google reported. */
export function purchaseNeedsAcknowledgement(verification: VerifiedGooglePlayPurchase): boolean {
  if (!verification.grantable) return false;
  const state = (verification.metadata as Record<string, unknown> | undefined)?.acknowledgementState;
  // Products report 0 for "yet to be acknowledged"; subscriptions v2 a string.
  return state === 0 || state === "ACKNOWLEDGEMENT_STATE_PENDING";
}

type GooglePlayVerifierOptions = {
  packageName?: string | undefined;
  accessToken?: string | undefined;
  serviceAccountJson?: string | undefined;
  serviceAccountFile?: string | undefined;
  fetchImpl?: FetchLike | undefined;
};

type AccessTokenCache = {
  token: string;
  expiresAt: number;
} | null;

export class GooglePlayBillingConfigError extends Error {
  readonly code = "GOOGLE_PLAY_BILLING_NOT_CONFIGURED";

  constructor(message = "Google Play Billing verification is not configured.") {
    super(message);
    this.name = "GooglePlayBillingConfigError";
  }
}

export class GooglePlayVerificationError extends Error {
  readonly code = "GOOGLE_PLAY_VERIFICATION_FAILED";
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "GooglePlayVerificationError";
    this.statusCode = statusCode;
  }
}

/**
 * The subscription token does not cover the plan the request named.
 *
 * Google's subscription endpoint is keyed by token alone, so the plan comes
 * from the purchase's own line items — and the verifier used to fall back to
 * the first line item when none matched, returning the *requested* SKU. A
 * token from the cheapest plan posted as the most expensive one was granted
 * the expensive plan's credits, and the hourly renewal sweep kept granting
 * them (2026-10-03 audit). One-time products are safe: their endpoint takes
 * the product id, so Google itself refuses a token for another product.
 */
export class GooglePlayProductMismatchError extends Error {
  readonly code = "GOOGLE_PLAY_PRODUCT_MISMATCH";

  constructor(readonly requestedSku: string) {
    super(`The Google Play purchase does not include ${requestedSku}.`);
    this.name = "GooglePlayProductMismatchError";
  }
}

export function createGooglePlayVerifierFromConfig(config: AppConfig): GooglePlayVerifier {
  if (config.MOCK_GOOGLE_PLAY_BILLING) {
    return createMockGooglePlayVerifier();
  }
  return createGooglePlayVerifier({
    packageName: config.GOOGLE_PLAY_PACKAGE_NAME,
    accessToken: config.GOOGLE_PLAY_ACCESS_TOKEN,
    serviceAccountJson: config.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
    serviceAccountFile: config.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE
  });
}

export function createMockGooglePlayVerifier(): GooglePlayVerifier {
  return {
    async acknowledgePurchase() {},
    async cancelSubscription() {},
    async verifyPurchase(request) {
      const now = new Date();
      // Google issues a fresh order id every renewal, and the credit grant is
      // idempotent on it. Varying the mock's by month gives dev the same
      // behaviour — otherwise a renewal here could never grant a second period.
      const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const externalPurchaseId = `MOCK.${createHash("sha256")
        .update(`${request.productId}:${request.purchaseToken}:${period}`)
        .digest("hex")
        .slice(0, 16)}`;

      if (request.productType === "SUBSCRIPTION") {
        const currentPeriodEnd = new Date(now);
        currentPeriodEnd.setUTCMonth(currentPeriodEnd.getUTCMonth() + 1);
        return {
          productSku: request.productId,
          purchaseToken: request.purchaseToken,
          kind: "subscription",
          grantable: true,
          providerStatus: "MOCK_SUBSCRIPTION_ACTIVE",
          externalPurchaseId,
          purchasedAt: now,
          subscription: {
            status: "ACTIVE",
            currentPeriodStart: now,
            currentPeriodEnd
          },
          metadata: {
            mockGooglePlayBilling: true,
            packageName: request.packageName || null
          }
        };
      }

      return {
        productSku: request.productId,
        purchaseToken: request.purchaseToken,
        kind: "one_time",
        grantable: true,
        providerStatus: "MOCK_PURCHASED",
        externalPurchaseId,
        purchasedAt: now,
        quantity: 1,
        metadata: {
          mockGooglePlayBilling: true,
          packageName: request.packageName || null
        }
      };
    }
  };
}

export function createGooglePlayVerifier(options: GooglePlayVerifierOptions): GooglePlayVerifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  let cache: AccessTokenCache = null;

  async function accessToken(): Promise<string> {
    if (options.accessToken?.trim()) {
      return options.accessToken.trim();
    }
    const now = Date.now();
    if (cache && cache.expiresAt - 60_000 > now) {
      return cache.token;
    }
    const credentials = await loadServiceAccountCredentials(options);
    const tokenUri = credentials.token_uri ?? DEFAULT_GOOGLE_TOKEN_URI;
    const assertion = signServiceAccountJwt(credentials, ANDROID_PUBLISHER_SCOPE, tokenUri);
    const response = await fetchImpl(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      })
    });
    if (!response.ok) {
      throw new GooglePlayVerificationError("Google Play service account token request failed.", response.status);
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new GooglePlayVerificationError("Google Play service account token response did not include an access token.", 502);
    }
    cache = {
      token: body.access_token,
      expiresAt: now + Math.max(60, body.expires_in ?? 3600) * 1000
    };
    return cache.token;
  }

  async function googlePost(url: string, body: unknown = {}, failure = "Google Play purchase acknowledgement failed."): Promise<void> {
    const token = await accessToken();
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new GooglePlayVerificationError(failure, response.status);
    }
  }

  async function googleJson<T>(url: string): Promise<T> {
    const token = await accessToken();
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      throw new GooglePlayVerificationError("Google Play purchase verification failed.", response.status);
    }
    return (await response.json()) as T;
  }

  return {
    async readRefundableQuantity(request) {
      const purchase = await googleJson<{
        orderId?: string;
        productLineItem?: Array<{ productOfferDetails?: { quantity?: number; refundableQuantity?: number } }>;
      }>(androidPublisherUrl(request.packageName,
        `/purchases/productsv2/tokens/${encodeURIComponent(request.purchaseToken)}`));
      const details = purchase.productLineItem?.[0]?.productOfferDetails;
      const quantity = details?.quantity;
      const refundableQuantity = details?.refundableQuantity;
      if (purchase.orderId !== request.orderId || purchase.productLineItem?.length !== 1 ||
        !Number.isSafeInteger(quantity) || !Number.isSafeInteger(refundableQuantity) ||
        quantity! < 1 || refundableQuantity! < 0 || refundableQuantity! >= quantity!) {
        throw new GooglePlayVerificationError("Google Play refund quantity is unavailable or inconsistent.", 502);
      }
      return { quantity: quantity!, refundableQuantity: refundableQuantity! };
    },
    async verifyPurchase(request) {
      const packageName = request.packageName || options.packageName;
      if (!packageName) {
        throw new GooglePlayBillingConfigError();
      }
      if (request.productType === "SUBSCRIPTION") {
        const url = androidPublisherUrl(
          packageName,
          `/purchases/subscriptionsv2/tokens/${encodeURIComponent(request.purchaseToken)}`
        );
        const purchase = await googleJson<GooglePlaySubscriptionPurchaseV2>(url);
        return mapSubscriptionPurchase(request.productId, request.purchaseToken, purchase);
      }

      const url = androidPublisherUrl(
        packageName,
        `/purchases/products/${encodeURIComponent(request.productId)}/tokens/${encodeURIComponent(request.purchaseToken)}`
      );
      const purchase = await googleJson<GooglePlayProductPurchase>(url);
      return mapOneTimePurchase(request.productId, request.purchaseToken, purchase);
    },
    async acknowledgePurchase(request) {
      const packageName = request.packageName || options.packageName;
      if (!packageName) {
        throw new GooglePlayBillingConfigError();
      }
      const kind = request.productType === "SUBSCRIPTION" ? "subscriptions" : "products";
      await googlePost(
        androidPublisherUrl(
          packageName,
          `/purchases/${kind}/${encodeURIComponent(request.productId)}/tokens/${encodeURIComponent(request.purchaseToken)}:acknowledge`
        )
      );
    },
    async cancelSubscription(request) {
      const packageName = request.packageName || options.packageName;
      if (!packageName) {
        throw new GooglePlayBillingConfigError();
      }
      await googlePost(
        androidPublisherUrl(packageName, `/purchases/subscriptionsv2/tokens/${encodeURIComponent(request.purchaseToken)}:cancel`),
        // The developer's stop, not the reader's: it cannot be restored from the
        // Play subscription centre, which is right for an account that is gone.
        { cancellationContext: { cancellationType: "DEVELOPER_REQUESTED_STOP_PAYMENTS" } },
        "Google Play subscription cancellation failed."
      );
    }
  };
}

type GooglePlayProductPurchase = {
  obfuscatedExternalAccountId?: string;
  orderId?: string;
  purchaseTimeMillis?: string;
  purchaseState?: number;
  acknowledgementState?: number;
  consumptionState?: number;
  quantity?: number;
  regionCode?: string;
};

type GooglePlayMoney = { currencyCode?: string; units?: string; nanos?: number };

type GooglePlaySubscriptionLineItem = {
  productId?: string;
  expiryTime?: string;
  latestSuccessfulOrderId?: string;
  autoRenewingPlan?: {
    autoRenewEnabled?: boolean;
    /** The base plan's recurring price in the buyer's currency, before tax and discounts. */
    recurringPrice?: GooglePlayMoney;
  };
  offerDetails?: { basePlanId?: string; offerId?: string };
  /** Exactly one key is present, naming the phase the current period is in. */
  offerPhase?: {
    freeTrial?: object;
    introductoryPrice?: object;
    basePrice?: object;
    /** A plan change's first period; it may have absorbed the new offer's first phase. */
    prorationPeriod?: { originalOfferPhaseType?: string };
  };
  /**
   * Set on the *replaced* item of a `ReplacementMode.DEFERRED` plan change:
   * this item runs to its expiry and is not renewed, and the named product
   * takes over then. The item for that product carries no expiry until it does.
   */
  deferredItemReplacement?: { productId?: string };
};

type GooglePlaySubscriptionPurchaseV2 = {
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  latestOrderId?: string;
  startTime?: string;
  subscriptionState?: string;
  acknowledgementState?: string;
  regionCode?: string;
  linkedPurchaseToken?: string;
  pausedStateContext?: { autoResumeTime?: string };
  lineItems?: GooglePlaySubscriptionLineItem[];
};

function mapOneTimePurchase(
  productSku: string,
  purchaseToken: string,
  purchase: GooglePlayProductPurchase
): VerifiedGooglePlayPurchase {
  const purchaseState = purchase.purchaseState ?? -1;
  const providerStatus = purchaseState === 0 ? "PURCHASED" : purchaseState === 2 ? "PENDING" : purchaseState === 1 ? "CANCELED" : "UNKNOWN";
  return {
    productSku,
    purchaseToken,
    kind: "one_time",
    grantable: purchaseState === 0,
    providerStatus,
    externalPurchaseId: purchase.orderId ?? null,
    purchasedAt: millisDate(purchase.purchaseTimeMillis),
    quantity: purchase.quantity ?? 1,
    metadata: {
      obfuscatedExternalAccountId: purchase.obfuscatedExternalAccountId ?? null,
      acknowledgementState: purchase.acknowledgementState ?? null,
      consumptionState: purchase.consumptionState ?? null,
      regionCode: purchase.regionCode ?? null
    }
  };
}

function mapSubscriptionPurchase(
  productSku: string,
  purchaseToken: string,
  purchase: GooglePlaySubscriptionPurchaseV2
): VerifiedGooglePlayPurchase {
  const lineItems = purchase.lineItems ?? [];
  const deferring = lineItems.find((item) => item.productId && item.deferredItemReplacement?.productId);
  if (deferring) {
    return mapDeferredReplacement(productSku, purchaseToken, purchase, deferring);
  }
  const matchingLineItem = lineItems.find((item) => item.productId === productSku);
  if (!matchingLineItem) {
    throw new GooglePlayProductMismatchError(productSku);
  }
  const status = mapSubscriptionStatus(purchase.subscriptionState);
  return {
    productSku,
    purchaseToken,
    kind: "subscription",
    grantable: subscriptionCanGrantCredits(status, matchingLineItem?.expiryTime),
    providerStatus: purchase.subscriptionState ?? "SUBSCRIPTION_STATE_UNSPECIFIED",
    // Refund RTDN identifies the paid order; the deprecated top-level field
    // can instead name a pending or failed renewal.
    externalPurchaseId: matchingLineItem.latestSuccessfulOrderId ?? purchase.latestOrderId ?? null,
    purchasedAt: dateValue(purchase.startTime),
    subscription: {
      status,
      currentPeriodStart: dateValue(purchase.startTime),
      currentPeriodEnd: dateValue(matchingLineItem?.expiryTime),
      // Promoted out of the metadata below because it is the difference between
      // "renews on the 12th" and "ends on the 12th". Google reports it before it
      // ever moves the subscription to CANCELED.
      autoRenewing: matchingLineItem?.autoRenewingPlan?.autoRenewEnabled ?? null,
      // A trial grants no credits and an introductory period is paid at the
      // offer's price, so the phase decides both the grant and the cash.
      offerPhase: subscriptionOfferPhase(matchingLineItem.offerPhase),
      offerId: matchingLineItem.offerDetails?.offerId ?? null,
      recurringPrice: moneyMicros(matchingLineItem.autoRenewingPlan?.recurringPrice),
      // Google resumes a paused (or on-hold) subscription on its own schedule
      // and tells nobody; this is when the renewal sweep should look again.
      resumesAt: dateValue(purchase.pausedStateContext?.autoResumeTime)
    },
    metadata: subscriptionMetadata(purchase, matchingLineItem)
  };
}

/**
 * A `ReplacementMode.DEFERRED` plan change — the app's downgrade — read off the
 * token Play issued for it.
 *
 * Play issues the new token at once, but it carries the *old* plan until that
 * plan's paid period ends: the old item has the expiry and a
 * `deferredItemReplacement`, the new item has no expiry and no order yet. So
 * this reports the plan the token renews into (the record's product, which is
 * what the renewal sweep asks about later) with the old item's expiry as the
 * end of the current period, no order id — nothing has been paid on this token
 * yet, and the old item's order belongs to the old token's payment — and the
 * change itself, which tells the recording path to grant nothing now and leave
 * the old plan's entitlement and allowance standing until it runs out.
 * Either product may be asked about: the app may file the purchase under the
 * old one, because that is the entitlement Play associates with it.
 */
function mapDeferredReplacement(
  productSku: string,
  purchaseToken: string,
  purchase: GooglePlaySubscriptionPurchaseV2,
  deferring: GooglePlaySubscriptionLineItem
): VerifiedGooglePlayPurchase {
  const fromProductSku = deferring.productId!;
  const toProductSku = deferring.deferredItemReplacement!.productId!;
  if (productSku !== fromProductSku && productSku !== toProductSku) {
    throw new GooglePlayProductMismatchError(productSku);
  }
  const incoming = (purchase.lineItems ?? []).find((item) => item.productId === toProductSku);
  const status = mapSubscriptionStatus(purchase.subscriptionState);
  const takesEffectAt = dateValue(deferring.expiryTime);
  return {
    productSku: toProductSku,
    purchaseToken,
    kind: "subscription",
    // On status alone: the token is live until the old item runs out, and it
    // must be acknowledged now or Play refunds it.
    grantable: subscriptionCanGrantCredits(status, undefined),
    providerStatus: purchase.subscriptionState ?? "SUBSCRIPTION_STATE_UNSPECIFIED",
    externalPurchaseId: null,
    purchasedAt: dateValue(purchase.startTime),
    subscription: {
      status,
      currentPeriodStart: dateValue(purchase.startTime),
      currentPeriodEnd: takesEffectAt,
      autoRenewing: incoming?.autoRenewingPlan?.autoRenewEnabled ?? null,
      offerPhase: null,
      offerId: incoming?.offerDetails?.offerId ?? null,
      recurringPrice: moneyMicros(incoming?.autoRenewingPlan?.recurringPrice),
      resumesAt: null,
      deferredReplacement: { fromProductSku, takesEffectAt }
    },
    metadata: { ...subscriptionMetadata(purchase, incoming ?? deferring), deferredFromProductSku: fromProductSku }
  };
}

function subscriptionMetadata(
  purchase: GooglePlaySubscriptionPurchaseV2,
  lineItem: GooglePlaySubscriptionLineItem
): Record<string, unknown> {
  return {
    obfuscatedExternalAccountId: purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
    acknowledgementState: purchase.acknowledgementState ?? null,
    regionCode: purchase.regionCode ?? null,
    linkedPurchaseToken: purchase.linkedPurchaseToken ?? null,
    autoRenewEnabled: lineItem.autoRenewingPlan?.autoRenewEnabled ?? null,
    basePlanId: lineItem.offerDetails?.basePlanId ?? null,
    offerId: lineItem.offerDetails?.offerId ?? null
  };
}

/** Google's `Money` as micros of its currency; null when it is missing or malformed. */
function moneyMicros(money: GooglePlayMoney | undefined): { micros: number; currency: string } | null {
  if (!money?.currencyCode || !/^[A-Z]{3}$/.test(money.currencyCode)) return null;
  const units = Number(money.units ?? "0");
  const nanos = money.nanos ?? 0;
  if (!Number.isSafeInteger(units) || !Number.isInteger(nanos)) return null;
  const micros = units * 1_000_000 + Math.trunc(nanos / 1_000);
  return Number.isSafeInteger(micros) && micros >= 0 ? { micros, currency: money.currencyCode } : null;
}

function subscriptionOfferPhase(
  phase: GooglePlaySubscriptionLineItem["offerPhase"] | undefined
): "free_trial" | "introductory" | "base" | "proration" | null {
  if (!phase) return null;
  if (phase.freeTrial) return "free_trial";
  if (phase.introductoryPrice) return "introductory";
  if (phase.prorationPeriod) {
    // A plan change charged at the new offer's first phase absorbs that phase
    // into its proration period (Google's `originalOfferPhaseType`). It was
    // still a trial or an intro, and is granted and priced as one.
    const original = phase.prorationPeriod.originalOfferPhaseType;
    if (original === "FREE_TRIAL") return "free_trial";
    if (original === "INTRODUCTORY") return "introductory";
    return "proration";
  }
  if (phase.basePrice) return "base";
  return null;
}

function mapSubscriptionStatus(status: string | undefined): GooglePlaySubscriptionGrantState {
  switch (status) {
    case "SUBSCRIPTION_STATE_ACTIVE":
      return "ACTIVE";
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
      return "GRACE_PERIOD";
    case "SUBSCRIPTION_STATE_CANCELED":
      return "CANCELED";
    case "SUBSCRIPTION_STATE_PAUSED":
    // On hold is a declined renewal Google keeps retrying: no access now, and
    // it may come back on its own exactly as a paused one does. As INACTIVE it
    // fell out of the renewal sweep, so a subscriber whose card recovered was
    // never granted again unless they opened the app.
    case "SUBSCRIPTION_STATE_ON_HOLD":
      return "PAUSED";
    case "SUBSCRIPTION_STATE_EXPIRED":
      return "EXPIRED";
    default:
      return "INACTIVE";
  }
}

function subscriptionCanGrantCredits(status: GooglePlaySubscriptionGrantState, expiryTime: string | undefined): boolean {
  if (status !== "ACTIVE" && status !== "GRACE_PERIOD" && status !== "CANCELED") {
    return false;
  }
  const expiry = dateValue(expiryTime);
  return !expiry || expiry > new Date();
}

function androidPublisherUrl(packageName: string, path: string): string {
  return `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}${path}`;
}

async function loadServiceAccountCredentials(options: GooglePlayVerifierOptions): Promise<ServiceAccountCredentials> {
  const raw = options.serviceAccountJson ?? (options.serviceAccountFile ? await readFile(options.serviceAccountFile, "utf8") : null);
  if (!raw) {
    throw new GooglePlayBillingConfigError();
  }
  const credentials = parseServiceAccountCredentials(raw);
  if (!credentials) {
    throw new GooglePlayBillingConfigError("Google Play service account JSON is missing client_email or private_key.");
  }
  return credentials;
}

function millisDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const millis = Number(value);
  return Number.isFinite(millis) ? new Date(millis) : null;
}

function dateValue(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
