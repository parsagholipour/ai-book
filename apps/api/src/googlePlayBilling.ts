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

  async function googlePost(url: string): Promise<void> {
    const token = await accessToken();
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}"
    });
    if (!response.ok) {
      throw new GooglePlayVerificationError("Google Play purchase acknowledgement failed.", response.status);
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
    }
  };
}

type GooglePlayProductPurchase = {
  orderId?: string;
  purchaseTimeMillis?: string;
  purchaseState?: number;
  acknowledgementState?: number;
  consumptionState?: number;
  quantity?: number;
  regionCode?: string;
};

type GooglePlaySubscriptionPurchaseV2 = {
  latestOrderId?: string;
  startTime?: string;
  subscriptionState?: string;
  acknowledgementState?: string;
  regionCode?: string;
  linkedPurchaseToken?: string;
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    latestSuccessfulOrderId?: string;
    autoRenewingPlan?: {
      autoRenewEnabled?: boolean;
    };
  }>;
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
  const matchingLineItem = purchase.lineItems?.find((item) => item.productId === productSku);
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
      autoRenewing: matchingLineItem?.autoRenewingPlan?.autoRenewEnabled ?? null
    },
    metadata: {
      acknowledgementState: purchase.acknowledgementState ?? null,
      regionCode: purchase.regionCode ?? null,
      linkedPurchaseToken: purchase.linkedPurchaseToken ?? null,
      autoRenewEnabled: matchingLineItem?.autoRenewingPlan?.autoRenewEnabled ?? null
    }
  };
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
