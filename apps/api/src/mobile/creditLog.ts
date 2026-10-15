import { chargeActionTitle, retriedOperationId } from "./creditLogActions.js";
import { type MobileCreditLogDto, type MobileCreditLogEntryDto, type MobileCreditLogKind } from "./dto.js";
import { jsonRecord } from "./support.js";
import { prisma } from "@book-maker/db";

/**
 * The reader's own credit history: what was added, what was taken, and why.
 *
 * It reads `CreditLedgerEntry` rows straight, but it never passes their words
 * on. `description` holds refund reasons written by the worker — often the raw
 * provider error — so every line here is built from `entryType`, `status` and
 * `operation` instead. Like the other serializers, this is the API contract.
 *
 * Four row shapes are easy to misread, and all four are load-bearing:
 *
 *  - A **hold** (`RESERVED`) has already left the balance. It is shown as a
 *    charge with `pending`, because hiding it would leave a dip in the balance
 *    that no line explains.
 *  - A **released hold** is the *same row* mutated to `RELEASE`/`REFUNDED`, and
 *    it keeps its negative amount. Its net effect is nothing, so it carries
 *    `refunded` and the app draws it struck through rather than counting it.
 *  - A **refunded charge** that had already settled is a second, positive row —
 *    so a spend and its refund correctly read as two lines.
 *  - A **settled refund debt** is an adjustment of 0 that names, in its title,
 *    the monthly credits that paid it (`planDebtSettlementCredits`).
 *
 * A reader's own stop or delete refunds only what was not delivered, so its
 * refund is titled for that rather than as a whole refund; and when part of it
 * came from a month that has already ended, that part is a second, negative
 * line that expired (`packages/db/src/userStopSettlement.ts`).
 */

const DEFAULT_PAGE_SIZE = 30;

type CreditLogRow = {
  id: string;
  entryType: string;
  status: string;
  operation: string;
  amountCredits: number;
  createdAt: Date;
  projectId: string | null;
  project: { title: string } | null;
  /** What the charge recorded about itself; read for its label only (`creditLogActions.ts`). */
  metadata?: unknown;
  /** The charge a refund reverses, whose record names what was refunded. */
  reversesEntry?: { metadata: unknown } | null;
};

/**
 * What each `CreditOperation` is called in the app. An operation with no entry
 * falls back to its own name in sentence case, so adding one to the schema
 * cannot leave the log showing `SCREAMING_SNAKE_CASE` to a reader.
 */
const OPERATION_TITLES: Record<string, string> = {
  CHAT_MESSAGE: "Chat message",
  MESSAGE_LIMIT_RESET: "Message allowance reset",
  PLAN_GENERATION: "Book plan",
  PREVIEW_GENERATION: "Page preview",
  FULL_BOOK_GENERATION: "Book generation",
  IMAGE_GENERATION: "Illustration",
  COVER_REGENERATION: "New cover",
  PREMIUM_REVIEW: "Premium review",
  EXPORT_UNLOCK: "Export unlock",
  PLAN_REVISION: "Plan revision",
  BOOK_TEXT_EDIT: "Book edit",
  PAGE_REGENERATION: "Page rewrite",
  BOOK_REPLAN: "Book replan",
  VOICE_CALL_MINUTE: "Character call",
  AUDIOBOOK_GENERATION: "Audiobook",
  CHARACTER_PORTRAIT_GENERATION: "Character portrait",
  PURCHASE_CREDIT_GRANT: "Credits purchased",
  SUBSCRIPTION_CREDIT_GRANT: "Subscription credits",
  PLAN_ALLOWANCE_GRANT: "Monthly credits",
  WELCOME_GRANT: "Welcome credits",
  ADMIN_GRANT: "Credits from support"
};

export async function serializeMobileCreditLog(
  userId: string,
  options: { cursor?: string | undefined; limit?: number | undefined } = {}
): Promise<MobileCreditLogDto> {
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  // One extra row answers "is there more" without a second count query.
  const rows: CreditLogRow[] = await prisma.creditLedgerEntry.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      entryType: true,
      status: true,
      operation: true,
      amountCredits: true,
      createdAt: true,
      projectId: true,
      project: { select: { title: true } },
      metadata: true,
      reversesEntry: { select: { metadata: true } }
    }
  });

  const page = rows.slice(0, limit);
  const operationKinds = await retriedOperationKinds(page);
  return {
    entries: page.map((row) => serializeCreditLogEntry(row, operationKinds)),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null
  };
}

/** The kinds of the edit operations a page's retry-lane charges re-ran, in one read. */
async function retriedOperationKinds(rows: CreditLogRow[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows
        .map((row) => retriedOperationId(row.reversesEntry?.metadata ?? row.metadata))
        .filter((id): id is string => id !== null)
    )
  ];
  if (ids.length === 0) {
    return new Map();
  }
  const operations = await prisma.bookEditOperation.findMany({
    where: { id: { in: ids } },
    select: { id: true, kind: true }
  });
  return new Map(operations.map((operation) => [operation.id, operation.kind]));
}

export function serializeCreditLogEntry(
  row: CreditLogRow,
  operationKinds: ReadonlyMap<string, string> = new Map()
): MobileCreditLogEntryDto {
  const kind = creditLogKind(row);
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    direction: row.amountCredits < 0 ? "out" : "in",
    credits: Math.abs(row.amountCredits),
    kind,
    title: creditLogTitle(row, kind, operationKinds),
    pending: row.status === "RESERVED",
    refunded: row.status === "REFUNDED",
    projectId: row.projectId,
    projectTitle: row.project?.title ?? null
  };
}

function creditLogKind(row: CreditLogRow): MobileCreditLogKind {
  if (isGooglePlayClawback(row)) return "spend";
  if (planDebtSettlementCredits(row) !== null) return "monthly";
  if (row.entryType === "REFUND") {
    return "refund";
  }
  // Other negative adjustments are unused allowances expiring at a period boundary.
  if (row.entryType === "ADJUSTMENT") {
    return row.amountCredits < 0 ? "expired" : "bonus";
  }
  if (row.amountCredits < 0) {
    return "spend";
  }
  switch (row.operation) {
    case "PURCHASE_CREDIT_GRANT":
      return "purchase";
    case "SUBSCRIPTION_CREDIT_GRANT":
      return "subscription";
    case "PLAN_ALLOWANCE_GRANT":
      return "monthly";
    default:
      return "bonus";
  }
}

function creditLogTitle(
  row: CreditLogRow,
  kind: MobileCreditLogKind,
  operationKinds: ReadonlyMap<string, string>
): string {
  if (isGooglePlayClawback(row)) return "Credits reversed after Google Play refund";
  const settled = planDebtSettlementCredits(row);
  if (settled !== null) {
    return settled > 0
      ? `Refunded purchase settled with ${settled.toLocaleString("en-US")} monthly credits`
      : "Refunded purchase settled from your monthly credits";
  }
  const operation =
    chargeActionTitle(kind === "refund" ? row.reversesEntry?.metadata : row.metadata, operationKinds) ??
    OPERATION_TITLES[row.operation] ??
    sentenceCase(row.operation);
  switch (kind) {
    case "refund":
      return stoppedByReader(row) ? `${operation} stopped: unused credits returned` : `${operation} refunded`;
    case "expired":
      return lapsedOnReturn(row) ? "Returned monthly credits expired" : "Unused monthly credits expired";
    default:
      return operation;
  }
}

/** A refund of a charge the reader stopped, which kept what had been delivered. */
function stoppedByReader(row: CreditLogRow): boolean {
  return jsonRecord(row.reversesEntry?.metadata).userStopSettlement !== undefined;
}

/** The part of a stop's refund that came from a month that had already ended. */
function lapsedOnReturn(row: CreditLogRow): boolean {
  return typeof jsonRecord(row.metadata).lapsedRefundOfEntryId === "string";
}

function isGooglePlayClawback(row: CreditLogRow): boolean {
  return row.entryType === "ADJUSTMENT" && row.amountCredits < 0 &&
    (row.operation === "PURCHASE_CREDIT_GRANT" || row.operation === "SUBSCRIPTION_CREDIT_GRANT") &&
    Boolean(row.reversesEntry);
}

/**
 * The monthly credits a period boundary used to pay off a store refund's debt
 * (`packages/db/src/planDebt.ts`), or null for any other row.
 *
 * The row moves credits from the allowance to the purchased pool, so its amount
 * is 0 and the line reads `+0`: the total did not change, because the refund's
 * own line already took the credits. What did change is the monthly meter,
 * which now reads short of the plan's size — and this line is what says why. The
 * number lives in the title because `credits` must stay the total's movement,
 * or a reader adding up the log would count the refund twice.
 */
function planDebtSettlementCredits(row: CreditLogRow): number | null {
  if (row.entryType !== "ADJUSTMENT") return null;
  const settlement = jsonRecord(row.metadata).planDebtSettlement;
  if (settlement === undefined) return null;
  const credits = jsonRecord(settlement).credits;
  return typeof credits === "number" && Number.isSafeInteger(credits) && credits > 0 ? credits : 0;
}

function sentenceCase(value: string): string {
  const words = value.toLowerCase().replaceAll("_", " ").trim();
  return words.length === 0 ? "Credits" : `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}
