/**
 * Plumbing shared by the billing modules: the transaction wrapper every credit
 * mutation runs inside, the row shapes the ledger returns, and the small query
 * fragments both the ledger and the entitlement helpers need.
 *
 * Nothing here is part of the public surface — import from `./billing.ts`.
 */
import { createHash } from "node:crypto";
import type { BillingOperation } from "@book-maker/core";
import { Prisma, prisma } from "./client.ts";
import type { CreditOperation } from "./generated/prisma/enums.ts";
import { activeCreditPricingVersion } from "./creditPricing.ts";

/**
 * What a credit operation is *here*: the generated type of the column itself,
 * so a row shape this package publishes describes the row its own client
 * returns. Core's `BillingOperation` is the wire-facing spelling of the same
 * set — core is the leaf of the dependency order and cannot import the Prisma
 * client, so the two have to be declared apart — and `CreditOperationsAgree`
 * below is the only thing holding them together.
 */
export type CreditOperationName = CreditOperation;

type AssertTrue<T extends true> = T;
type SameMembers<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : "schema.prisma's CreditOperation has a member core's BillingOperation does not"
  : "core's BillingOperation has a member schema.prisma's CreditOperation does not";

/**
 * Fails to compile the moment `enum CreditOperation` in `prisma/schema.prisma`
 * and `BillingOperation` in `packages/core/src/billing.ts` stop naming the same
 * members — the one place either declaration is measured against the other.
 * Both directions used to be reported by whatever call site happened to compare
 * the two, which named the wrong fault: a value added to the Prisma enum alone
 * came back as this package's own record type rejecting a row its own client
 * returns, and one added to core's union alone as a `create` refusing the value
 * several statements away. Adding a priced operation fails here, by name, until
 * both are edited — the rest of that checklist is in the `add-priced-operation`
 * skill.
 */
export type CreditOperationsAgree = AssertTrue<SameMembers<BillingOperation, CreditOperationName>>;

export type CreditBalance = {
  /**
   * Total spendable — allowance plus purchased. Deliberately still called
   * `availableCredits` even though it is no longer one column: shipped clients
   * compare it against a quote before submitting, and splitting the meaning out
   * from under them would under-report what they can afford.
   */
  availableCredits: number;
  /** Bought outright, never expires. Negative means debt from a store refund. */
  purchasedCredits: number;
  /** This period's allowance, already zeroed if the period has run out. */
  planCredits: number;
  planCreditsPerPeriod: number;
  planPeriodEnd: Date | null;
  planPeriodKey: string | null;
  reservedCredits: number;
  lifetimeCreditsGranted: number;
  lifetimeCreditsSpent: number;
};

export type PlanAccountRow = {
  userId: string;
  availableCredits: number;
  reservedCredits: number;
  lifetimeCreditsGranted: number;
  lifetimeCreditsSpent: number;
  planCredits: number;
  planCreditsPerPeriod: number;
  planPeriodStart: Date | null;
  planPeriodEnd: Date | null;
  planPeriodKey: string | null;
};

export const accountSelect = {
  userId: true,
  availableCredits: true,
  reservedCredits: true,
  lifetimeCreditsGranted: true,
  lifetimeCreditsSpent: true,
  planCredits: true,
  planCreditsPerPeriod: true,
  planPeriodStart: true,
  planPeriodEnd: true,
  planPeriodKey: true
} as const;

/** Spendable allowance right now: an allowance past its period is already gone. */
export function effectivePlanCredits(
  account: Pick<PlanAccountRow, "planCredits" | "planPeriodEnd">,
  now: Date = new Date()
): number {
  if (!account.planPeriodEnd || account.planPeriodEnd <= now) {
    return 0;
  }
  return Math.max(0, account.planCredits);
}

/** Both pools, as a reservation is checked against them and every ledger stamp records them. */
export function spendableCredits(account: PlanAccountRow, now: Date = new Date()): number {
  return account.availableCredits + effectivePlanCredits(account, now);
}

export type CreditLedgerEntryRecord = {
  id: string;
  userId: string;
  projectId: string | null;
  operation: string;
  amountCredits: number;
  /** How much of `amountCredits` this row moved in the allowance pool. */
  planCreditsDelta: number;
  entryType: string;
  status: string;
  idempotencyKey: string;
};

export type UserEntitlementRecord = {
  id: string;
  userId: string;
  projectId: string | null;
  type: string;
  status: string;
  source: string;
  creditsCost: number;
  startsAt: Date;
  expiresAt: Date | null;
};

export class InsufficientCreditsError extends Error {
  readonly code = "INSUFFICIENT_CREDITS";
  readonly requiredCredits: number;
  readonly availableCredits: number;
  readonly reservedCredits: number;

  constructor(options: { requiredCredits: number; availableCredits: number; reservedCredits: number }) {
    super(`Insufficient credits: ${options.requiredCredits} required, ${options.availableCredits} available.`);
    this.name = "InsufficientCreditsError";
    this.requiredCredits = options.requiredCredits;
    this.availableCredits = options.availableCredits;
    this.reservedCredits = options.reservedCredits;
  }
}

export type BillingTx = Prisma.TransactionClient;

export type LedgerContext = {
  userId: string;
  projectId?: string | null | undefined;
  generationJobId?: string | null | undefined;
  productId?: string | null | undefined;
  purchaseRecordId?: string | null | undefined;
  description?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export function activeEntitlementWhere(userId: string, now: Date): Prisma.UserEntitlementWhereInput {
  return {
    userId,
    status: "ACTIVE",
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
  };
}

export async function revokeEntitlementsForLedgerEntryTx(tx: BillingTx, ledgerEntryId: string): Promise<void> {
  await tx.userEntitlement.updateMany({
    where: {
      relatedLedgerEntryId: ledgerEntryId,
      status: "ACTIVE"
    },
    data: {
      status: "REVOKED",
      consumedAt: new Date()
    }
  });
}

export function ledgerData(options: LedgerContext & {
  entryType: "GRANT" | "RESERVE" | "SPEND" | "REFUND" | "RELEASE" | "ADJUSTMENT";
  status: "RESERVED" | "SETTLED" | "REFUNDED" | "VOIDED";
  operation: BillingOperation;
  amountCredits: number;
  planCreditsDelta?: number | undefined;
  balanceAfterCredits: number;
  idempotencyKey: string;
}) {
  return {
    userId: options.userId,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.generationJobId ? { generationJobId: options.generationJobId } : {}),
    ...(options.productId ? { productId: options.productId } : {}),
    ...(options.purchaseRecordId ? { purchaseRecordId: options.purchaseRecordId } : {}),
    entryType: options.entryType,
    status: options.status,
    operation: options.operation,
    amountCredits: options.amountCredits,
    planCreditsDelta: options.planCreditsDelta ?? 0,
    balanceAfterCredits: options.balanceAfterCredits,
    idempotencyKey: options.idempotencyKey,
    ...(options.description ? { description: options.description } : {}),
    // Which price list produced this amount. Stamped here rather than at each
    // charge site so no future one can forget it. Callers may override.
    metadata: jsonInput({ pricingVersion: activeCreditPricingVersion(), ...options.metadata })
  };
}

export async function runSerializable<T>(callback: (tx: BillingTx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    } catch (error) {
      if (attempt >= 4 || !isSerializationConflict(error)) throw error;
    }
  }
}

/**
 * One aborted serializable transaction, whichever layer reported it. P2034 is Prisma's own name
 * for it; P2002 is a unique clash and is not retried here. The pg adapter can surface a
 * COMMIT-time failure directly, before Prisma wraps it in P2034, and a raw query inside the
 * transaction (a `$queryRaw ... FOR UPDATE`) that hits one arrives as P2010 with the adapter's
 * error in `meta` — the voice relay's hang-up settlement racing POST /end was answered 500.
 */
function isSerializationConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "P2034") return true;
  const adapterError = error instanceof Error && error.name === "DriverAdapterError" ? error
    : "code" in error && error.code === "P2010" && "meta" in error
      ? (error.meta as { driverAdapterError?: unknown } | null | undefined)?.driverAdapterError
      : undefined;
  const cause = adapterError && typeof adapterError === "object" && "cause" in adapterError ? adapterError.cause : null;
  return !!cause && typeof cause === "object" && "kind" in cause && cause.kind === "TransactionWriteConflict";
}

export function jsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export const ledgerSelect = {
  id: true,
  userId: true,
  projectId: true,
  operation: true,
  amountCredits: true,
  planCreditsDelta: true,
  entryType: true,
  status: true,
  idempotencyKey: true
} as const;

/** The refund path also needs the period the entry drew from, which is metadata. */
export const ledgerRefundSelect = {
  ...ledgerSelect,
  metadata: true
} as const;

export function planPeriodKeyFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).planPeriodKey;
  return typeof value === "string" ? value : null;
}

export function imageQuotaPeriodKeyFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const quota = (metadata as Record<string, unknown>).imageQuota;
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) {
    return null;
  }
  const value = (quota as Record<string, unknown>).periodKey;
  return typeof value === "string" ? value : null;
}

export const entitlementSelect = {
  id: true,
  userId: true,
  projectId: true,
  type: true,
  status: true,
  source: true,
  creditsCost: true,
  startsAt: true,
  expiresAt: true
} as const;

export function hashPurchaseToken(purchaseToken: string): string {
  return createHash("sha256").update(purchaseToken, "utf8").digest("hex");
}
