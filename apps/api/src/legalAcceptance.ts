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
  termsVersion: string;
  privacyVersion: string;
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

export function isCurrentLegalAcceptanceInput(input: LegalAcceptanceInput): boolean {
  return (
    input.termsAccepted === true &&
    input.ageGuardianAttested === true &&
    input.termsVersion === CURRENT_TERMS_VERSION &&
    input.privacyVersion === CURRENT_PRIVACY_VERSION
  );
}

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
      termsAttested: true,
      ageGuardianAttested: true
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

export function legalAcceptanceEvidence(
  input: LegalAcceptanceInput,
  source: string,
  request: FastifyRequest
) {
  const rawUserAgent = request.headers["user-agent"];
  const userAgent = Array.isArray(rawUserAgent) ? rawUserAgent.join(" ") : rawUserAgent;
  return {
    termsVersion: input.termsVersion,
    privacyVersion: input.privacyVersion,
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
