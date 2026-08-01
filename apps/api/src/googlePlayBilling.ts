import { createHash, createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "@book-maker/core";
import type { GooglePlaySubscriptionGrantState, VerifiedGooglePlayPurchase } from "@book-maker/db/billing";

type FetchLike = typeof fetch;

export type GooglePlayProductType = "ONE_TIME_UNLOCK" | "CREDIT_PACK" | "SUBSCRIPTION" | "INTERNAL_GRANT";

export type GooglePlayVerificationRequest = {
  packageName: string;
  productId: string;
  productType: GooglePlayProductType | string;
  purchaseToken: string;
};

export interface GooglePlayVerifier {
  verifyPurchase(request: GooglePlayVerificationRequest): Promise<VerifiedGooglePlayPurchase>;
}

type GooglePlayVerifierOptions = {
  packageName?: string | undefined;
  accessToken?: string | undefined;
  serviceAccountJson?: string | undefined;
  serviceAccountFile?: string | undefined;
  fetchImpl?: FetchLike | undefined;
};

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  token_uri?: string | undefined;
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
    const tokenUri = credentials.token_uri ?? "https://oauth2.googleapis.com/token";
    const assertion = signServiceAccountJwt(credentials, tokenUri);
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
  const providerStatus = purchaseState === 0 ? "PURCHASED" : purchaseState === 2 ? "PENDING" : "CANCELED";
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
  const matchingLineItem = purchase.lineItems?.find((item) => item.productId === productSku) ?? purchase.lineItems?.[0] ?? null;
  const status = mapSubscriptionStatus(purchase.subscriptionState);
  return {
    productSku,
    purchaseToken,
    kind: "subscription",
    grantable: subscriptionCanGrantCredits(status, matchingLineItem?.expiryTime),
    providerStatus: purchase.subscriptionState ?? "SUBSCRIPTION_STATE_UNSPECIFIED",
    externalPurchaseId: purchase.latestOrderId ?? null,
    purchasedAt: dateValue(purchase.startTime),
    subscription: {
      status,
      currentPeriodStart: dateValue(purchase.startTime),
      currentPeriodEnd: dateValue(matchingLineItem?.expiryTime)
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
  const parsed = JSON.parse(raw) as Partial<ServiceAccountCredentials>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new GooglePlayBillingConfigError("Google Play service account JSON is missing client_email or private_key.");
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: parsed.token_uri
  };
}

function signServiceAccountJwt(credentials: ServiceAccountCredentials, tokenUri: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const claim = base64UrlJson({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: tokenUri,
    exp: nowSeconds + 3600,
    iat: nowSeconds
  });
  const unsigned = `${header}.${claim}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key);
  return `${unsigned}.${base64Url(signature)}`;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return base64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
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
