/**
 * The closed vocabulary of app-reported events, kept apart from the writer so
 * the request schemas can name it without loading the database client.
 */

/** What opened a paywall. A closed list, so the funnel can name every bucket. */
export const PAYWALL_TRIGGERS = [
  "credits_needed",
  "image_limit",
  "page_limit",
  "export",
  "message_limit",
  "add_credits",
  "plans",
  "made_with_credit",
  // The one-time offer when a free reader's first book is ready.
  "first_book",
  "other"
] as const;

export type PaywallTrigger = (typeof PAYWALL_TRIGGERS)[number];

/**
 * Why a checkout the reader started ended without a purchase, as a class and
 * never as Play's or the server's own message. Mirrors `PurchaseFailureReason`
 * in `apps/mobile/lib/features/billing/data/purchase_funnel_reporter.dart`.
 */
export const PURCHASE_FAILURE_REASONS = [
  // Play is not reachable on this device, or gave no price for the product.
  "store_unavailable",
  // The billing account could not be read before the sheet opened.
  "account_unavailable",
  // The store client threw, or Play refused to open the sheet.
  "launch_failed",
  // Play's sheet closed with an error.
  "play_error",
  // Play said this Google account already holds the product.
  "already_owned",
  // Play closed the sheet with no purchase token.
  "no_token",
  // The server refused the purchase for good (another account, an unknown product).
  "refused",
  "other"
] as const;

export type PurchaseFailureReason = (typeof PURCHASE_FAILURE_REASONS)[number];

/**
 * Events only the app can see. Everything the server records is read from its
 * own tables — which is why a completed purchase has no event: it is a
 * `PurchasePayment` row.
 */
export const PRODUCT_EVENT_NAMES = [
  "paywall_viewed",
  "purchase_started",
  "purchase_cancelled",
  "purchase_failed",
  "install_attributed"
] as const;

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

/** A Play product id as the catalog spells them (`tomeza.creator_monthly`). */
export const PRODUCT_EVENT_SKU_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * One install-referrer field (`utm_source`, `utm_medium`, `utm_campaign`) as
 * the app normalises it: lower case, nothing but `[a-z0-9._-]`, at most 40
 * characters. Anyone can put any text on a Play link, so nothing freer reaches
 * the table.
 */
export const INSTALL_ATTRIBUTION_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;
