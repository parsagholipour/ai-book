import { type MobileCreditLogDto, type MobileCreditLogEntryDto, type MobileCreditLogKind } from "./dto.js";
import { prisma } from "@book-maker/db";

/**
 * The reader's own credit history: what was added, what was taken, and why.
 *
 * It reads `CreditLedgerEntry` rows straight, but it never passes their words
 * on. `description` holds refund reasons written by the worker — often the raw
 * provider error — so every line here is built from `entryType`, `status` and
 * `operation` instead. Like the other serializers, this is the API contract.
 *
 * Three row shapes are easy to misread, and all three are load-bearing:
 *
 *  - A **hold** (`RESERVED`) has already left the balance. It is shown as a
 *    charge with `pending`, because hiding it would leave a dip in the balance
 *    that no line explains.
 *  - A **released hold** is the *same row* mutated to `RELEASE`/`REFUNDED`, and
 *    it keeps its negative amount. Its net effect is nothing, so it carries
 *    `refunded` and the app draws it struck through rather than counting it.
 *  - A **refunded charge** that had already settled is a second, positive row —
 *    so a spend and its refund correctly read as two lines.
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
};

/**
 * What each `CreditOperation` is called in the app. An operation with no entry
 * falls back to its own name in sentence case, so adding one to the schema
 * cannot leave the log showing `SCREAMING_SNAKE_CASE` to a reader.
 */
const OPERATION_TITLES: Record<string, string> = {
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
      project: { select: { title: true } }
    }
  });

  const page = rows.slice(0, limit);
  return {
    entries: page.map(serializeCreditLogEntry),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null
  };
}

export function serializeCreditLogEntry(row: CreditLogRow): MobileCreditLogEntryDto {
  const kind = creditLogKind(row);
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    direction: row.amountCredits < 0 ? "out" : "in",
    credits: Math.abs(row.amountCredits),
    kind,
    title: creditLogTitle(row, kind),
    pending: row.status === "RESERVED",
    refunded: row.status === "REFUNDED",
    projectId: row.projectId,
    projectTitle: row.project?.title ?? null
  };
}

function creditLogKind(row: CreditLogRow): MobileCreditLogKind {
  if (row.entryType === "REFUND") {
    return "refund";
  }
  // The only negative adjustment the ledger writes is an allowance being written
  // off at a period boundary. A positive one is an operator putting credits back.
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

function creditLogTitle(row: CreditLogRow, kind: MobileCreditLogKind): string {
  const operation = OPERATION_TITLES[row.operation] ?? sentenceCase(row.operation);
  switch (kind) {
    case "refund":
      return `${operation} refunded`;
    case "expired":
      return "Unused monthly credits expired";
    default:
      return operation;
  }
}

function sentenceCase(value: string): string {
  const words = value.toLowerCase().replaceAll("_", " ").trim();
  return words.length === 0 ? "Credits" : `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}
