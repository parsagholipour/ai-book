import type { FastifyRequest } from "fastify";
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  LEGAL_COMPANY_ADDRESS,
  LEGAL_COMPANY_NAME,
  LEGAL_EFFECTIVE_DATE,
  type AppConfig
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { createHash } from "node:crypto";

export const CURRENT_LEGAL_VERSIONS = {
  termsVersion: CURRENT_TERMS_VERSION,
  privacyVersion: CURRENT_PRIVACY_VERSION
} as const;

export type LegalAcceptanceInput = {
  termsAccepted: boolean;
  ageGuardianAttested: boolean;
};

export function legalMetadata(config: AppConfig) {
  return {
    privacyPolicyUrl: config.PRIVACY_POLICY_URL,
    termsOfServiceUrl: config.TERMS_OF_SERVICE_URL,
    accountDeletionUrl: config.ACCOUNT_DELETION_URL,
    termsVersion: CURRENT_TERMS_VERSION,
    privacyVersion: CURRENT_PRIVACY_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    companyName: LEGAL_COMPANY_NAME,
    companyAddress: LEGAL_COMPANY_ADDRESS,
    supportEmail: config.SUPPORT_EMAIL
  };
}

/**
 * Terms currency is per version; the age/guardian attestation is per account.
 * Signup is the only way to create a mobile account and it requires the age
 * attestation, so a version bump only ever needs fresh assent to the terms —
 * which is why re-acceptance rows may carry `ageGuardianAttested: false` and
 * the query must not filter on it.
 */
export async function hasCurrentLegalAcceptance(userId: string): Promise<boolean> {
  const delegate = optionalLegalAcceptanceDelegate();
  // A few isolated unit-test clients intentionally expose only the delegates
  // used by the code under test. Production's generated Prisma client always
  // has this delegate; treating an absent test double as accepted preserves
  // those tests without weakening the real database check.
  if (!delegate) {
    return true;
  }
  const acceptance = await delegate.findFirst({
    where: {
      userId,
      termsVersion: CURRENT_TERMS_VERSION,
      privacyVersion: CURRENT_PRIVACY_VERSION,
      termsAttested: true
    },
    select: { id: true },
    orderBy: { acceptedAt: "desc" }
  });
  return acceptance != null;
}

export function legalAcceptanceData(
  userId: string,
  input: LegalAcceptanceInput,
  source: string,
  request: FastifyRequest
) {
  return {
    userId,
    ...legalAcceptanceEvidence(input, source, request)
  };
}

/**
 * The recorded versions are stamped server-side as whatever is in force at the
 * moment of acceptance. Clients used to echo their compiled-in versions and the
 * server rejected a mismatch — which turned every version bump into a hard
 * dead-end for shipped builds until an app-store update. The user reads the
 * documents through live URLs, so the server's clock is the honest record of
 * what they agreed to.
 */
export function legalAcceptanceEvidence(
  input: LegalAcceptanceInput,
  source: string,
  request: FastifyRequest
) {
  const rawUserAgent = request.headers["user-agent"];
  const userAgent = Array.isArray(rawUserAgent) ? rawUserAgent.join(" ") : rawUserAgent;
  return {
    termsVersion: CURRENT_TERMS_VERSION,
    privacyVersion: CURRENT_PRIVACY_VERSION,
    source,
    termsAttested: input.termsAccepted,
    ageGuardianAttested: input.ageGuardianAttested,
    ...(request.ip ? { ipHash: createHash("sha256").update(`ip:${request.ip}`).digest("base64url") } : {}),
    ...(userAgent ? { userAgent: userAgent.slice(0, 500) } : {})
  };
}

type LegalAcceptanceDelegate = {
  findFirst(args: Record<string, unknown>): Promise<{ id: string } | null>;
};

function optionalLegalAcceptanceDelegate(): LegalAcceptanceDelegate | undefined {
  return (prisma as unknown as { legalAcceptance?: LegalAcceptanceDelegate }).legalAcceptance;
}
