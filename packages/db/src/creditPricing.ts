/**
 * Persistence for operator-set credit prices.
 *
 * `CreditPricingRevision` is append-only and the highest version *is* the price
 * list in force — there is no separate settings row that could drift from its
 * own history. An empty table means the defaults compiled into
 * `packages/core/src/creditPricing.ts`, which is also what a brand-new database
 * gets, so nothing has to be seeded.
 *
 * Reads apply the result to the process-local snapshot in core; that is how the
 * ~20 pricing call sites across `apps/api` see a change without any of them
 * knowing a database exists.
 */

import {
  type CreditPricing,
  type CreditPricingKey,
  DEFAULT_CREDIT_COSTS,
  creditPricing,
  diffCreditPricing,
  normalizeCreditPricing,
  setCreditPricing
} from "@book-maker/core";
import { Prisma, prisma } from "./client.ts";

export type CreditPricingRevisionSummary = {
  version: number;
  values: CreditPricing;
  changed: Partial<Record<CreditPricingKey, { from: number; to: number }>>;
  note: string | null;
  updatedBy: string | null;
  createdAt: Date;
};

export type CreditPricingState = {
  values: CreditPricing;
  version: number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date | null;
};

/** Raised when two operators save from stale views of the same price list. */
export class CreditPricingConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super("Pricing changed in another session. Reload before saving again.");
    this.name = "CreditPricingConflictError";
    this.currentVersion = currentVersion;
  }
}

/**
 * Which revision the live prices came from, stamped onto every ledger entry.
 *
 * The failure mode of a process-local price snapshot is a *silent default*, not
 * a crash — nothing about a charge would otherwise say which price list produced
 * it. With this, a disputed amount is answerable from the ledger alone, which is
 * most of the point of keeping a revision history.
 */
let activeVersion = 0;

export function activeCreditPricingVersion(): number {
  return activeVersion;
}

function applyPricing(values: CreditPricing, version: number): CreditPricing {
  activeVersion = version;
  return setCreditPricing(values);
}

const revisionSelect = {
  version: true,
  values: true,
  changed: true,
  note: true,
  updatedBy: true,
  createdAt: true
} as const;

type RevisionRow = {
  version: number;
  values: unknown;
  changed: unknown;
  note: string | null;
  updatedBy: string | null;
  createdAt: Date;
};

/**
 * Read the current prices and make them live.
 *
 * Called once at API boot and then on a timer, so a second API instance picks up
 * a change made through the first. Safe to call as often as you like — it is one
 * indexed row.
 */
export async function loadCreditPricing(): Promise<CreditPricingState> {
  const head = await readHead();
  const values = normalizeCreditPricing(head?.values);
  applyPricing(values, head?.version ?? 0);
  return stateFromHead(head, values);
}

/** The prices in force plus the metadata the dashboard needs to render them. */
export async function getCreditPricingState(): Promise<CreditPricingState> {
  const head = await readHead();
  return stateFromHead(head, normalizeCreditPricing(head?.values));
}

export async function listCreditPricingRevisions(limit = 20): Promise<CreditPricingRevisionSummary[]> {
  const rows = (await prisma.creditPricingRevision.findMany({
    orderBy: { version: "desc" },
    take: Math.max(1, Math.min(100, limit)),
    select: revisionSelect
  })) as RevisionRow[];
  return rows.map((row) => ({
    version: row.version,
    values: normalizeCreditPricing(row.values),
    changed: changedFromJson(row.changed),
    note: row.note,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt
  }));
}

export type SaveCreditPricingOptions = {
  values: CreditPricing;
  updatedBy?: string | null;
  note?: string | null;
  /** The version the editor was looking at. Omit to skip the staleness check. */
  expectedVersion?: number | null;
};

export type SaveCreditPricingResult = CreditPricingState & {
  changed: Partial<Record<CreditPricingKey, { from: number; to: number }>>;
  /** False when the submitted values matched what was already in force. */
  applied: boolean;
};

/**
 * Record a new price list and put it into effect.
 *
 * Three behaviours worth knowing:
 *
 * - **A no-op save writes nothing.** A double-clicked Save button must not fill
 *   the audit trail with revisions that changed nothing.
 * - **The snapshot is applied after the write commits, never inside it.** A
 *   transaction that fails late would otherwise leave this process charging
 *   prices no revision row can account for, until the next refresh silently
 *   undid them.
 * - **Revert is a forward write.** Restoring older values creates version N+1
 *   carrying them, so history is never rewritten.
 */
export async function saveCreditPricing(options: SaveCreditPricingOptions): Promise<SaveCreditPricingResult> {
  const values = normalizeCreditPricing(options.values);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const head = await readHead();
    const currentVersion = head?.version ?? 0;
    const current = normalizeCreditPricing(head?.values);

    if (typeof options.expectedVersion === "number" && options.expectedVersion !== currentVersion) {
      throw new CreditPricingConflictError(currentVersion);
    }

    const changed = diffCreditPricing(current, values);
    if (Object.keys(changed).length === 0) {
      applyPricing(current, currentVersion);
      return { ...stateFromHead(head, current), changed, applied: false };
    }

    try {
      const created = (await prisma.creditPricingRevision.create({
        data: {
          version: currentVersion + 1,
          values: jsonInput(values),
          changed: jsonInput(changed),
          ...(options.note ? { note: options.note } : {}),
          ...(options.updatedBy ? { updatedBy: options.updatedBy } : {})
        },
        select: revisionSelect
      })) as RevisionRow;

      // Committed — only now is it safe to charge these prices.
      applyPricing(values, created.version);
      return { ...stateFromHead(created, values), changed, applied: true };
    } catch (error) {
      // Someone else claimed this version between the read and the insert.
      // Re-read the head once and try again on top of their change.
      if (!isVersionConflict(error) || attempt === 1) {
        throw error;
      }
    }
  }

  throw new Error("Could not save credit pricing after a version conflict retry.");
}

/** Re-apply an older revision's values as a new revision. */
export async function revertCreditPricing(options: {
  version: number;
  updatedBy?: string | null;
  note?: string | null;
}): Promise<SaveCreditPricingResult> {
  const revision = (await prisma.creditPricingRevision.findUnique({
    where: { version: options.version },
    select: revisionSelect
  })) as RevisionRow | null;
  if (!revision) {
    throw new Error(`No pricing revision numbered ${options.version}.`);
  }
  return saveCreditPricing({
    values: normalizeCreditPricing(revision.values),
    ...(options.updatedBy ? { updatedBy: options.updatedBy } : {}),
    note: options.note ?? `Reverted to version ${options.version}`
  });
}

async function readHead(): Promise<RevisionRow | null> {
  return (await prisma.creditPricingRevision.findFirst({
    orderBy: { version: "desc" },
    select: revisionSelect
  })) as RevisionRow | null;
}

function stateFromHead(head: RevisionRow | null, values: CreditPricing): CreditPricingState {
  return {
    values,
    version: head?.version ?? 0,
    note: head?.note ?? null,
    updatedBy: head?.updatedBy ?? null,
    updatedAt: head?.createdAt ?? null
  };
}

function changedFromJson(raw: unknown): Partial<Record<CreditPricingKey, { from: number; to: number }>> {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const changed: Partial<Record<CreditPricingKey, { from: number; to: number }>> = {};
  for (const key of Object.keys(DEFAULT_CREDIT_COSTS) as CreditPricingKey[]) {
    const entry = record[key];
    if (entry && typeof entry === "object") {
      const { from, to } = entry as { from?: unknown; to?: unknown };
      if (typeof from === "number" && typeof to === "number") {
        changed[key] = { from, to };
      }
    }
  }
  return changed;
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export { creditPricing };
