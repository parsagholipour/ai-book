import { createHash } from "node:crypto";
import { prisma } from "@book-maker/db";
import type { VerifiedGooglePlayPurchase } from "@book-maker/db/billing";

/** Stable, non-PII Play checkout identity; never derive this from a session token. */
export function googlePlayAccountId(userId: string): string {
  return createHash("sha256").update(`tomeza:google-play:${userId}`).digest("hex");
}

export class GooglePlayAccountMismatchError extends Error {
  readonly code = "GOOGLE_PLAY_ACCOUNT_MISMATCH";

  constructor() {
    super("Sign in to the Tomeza account that started this purchase, then restore purchases. If it still cannot be restored, contact support.");
    this.name = "GooglePlayAccountMismatchError";
  }
}

/**
 * Check Google's receipt, never an account id supplied in the verification body.
 * Pending purchases can complete after logout, on another device, or after a
 * reinstall. Old receipts without an id can only restore an existing owner;
 * letting the current caller claim an unknown receipt recreates that race.
 */
export async function requireGooglePlayPurchaseOwner(
  userId: string,
  verification: VerifiedGooglePlayPurchase,
  mockBilling: boolean
): Promise<void> {
  const accountId = verification.metadata?.obfuscatedExternalAccountId;
  if (typeof accountId === "string" && accountId.length > 0) {
    if (accountId !== googlePlayAccountId(userId)) throw new GooglePlayAccountMismatchError();
    return;
  }
  // Only the configured dev verifier may mint purchases without a Play receipt.
  if (mockBilling) return;
  const existing = await prisma.purchaseRecord.findFirst({
    where: {
      provider: "GOOGLE_PLAY",
      purchaseTokenHash: createHash("sha256").update(verification.purchaseToken).digest("hex")
    },
    select: { userId: true }
  });
  if (existing?.userId !== userId) throw new GooglePlayAccountMismatchError();
}
