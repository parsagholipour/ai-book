/**
 * What a reader's own stop or delete may give back, decided once, at the stop.
 *
 * A stop used to refund a paid run whole however much of it had been
 * delivered, so a book could be read in the app while it was written and then
 * deleted for every credit back — and a charge drawn on an allowance that had
 * since reset came back as permanent purchased credits. The stop transaction
 * (`stopProjectGenerationJobs` in `apps/api/src/queue.ts`) now calls
 * `recordUserStopSettlementTx` for every attempt it terminalizes, before the
 * project can be deleted, and the stamp it writes onto the *charge* is what
 * every later settlement of that charge obeys, whichever path runs it:
 *
 *  - `keptCredits` is the price of what was delivered, at the rates the charge
 *    was quoted at — a full book, a chat rebuild's copy (`BOOK_REPLAN`, priced
 *    against the copy it was writing) or a narration's READY chapters. The
 *    ledger never reverses more than the rest
 *    (`refundableCredits`), so a reconciler, a legacy fallback or a worker
 *    failure that reaches the same charge later cannot top it up to whole.
 *  - Its presence makes the refund user-initiated: a plan share whose period
 *    has ended lapses with that period instead of landing in the purchased
 *    pool (`refundPoolSplit` in `ledgerReversal.ts`).
 *
 * The stamp lives on the ledger entry rather than the attempt because the
 * attempt-less refund paths (`refundCreditLedgerEntry`,
 * `refundLatestProjectOperationCredits`) only ever see the entry.
 */
import { jsonRecord } from "@book-maker/core";
import { type BillingTx, jsonInput } from "./billingInternals.ts";

export const USER_STOP_CLAIM_PREFIX = "user-stop:";

/** How far back a paid retry's chain is walked to find the quote it re-charged. */
const MAX_RETRY_DEPTH = 8;

export type UserStopDelivered = {
  /** Page rows holding prose — every status, because the app shows all of them. */
  pages: number;
  interiorImages: number;
  /** A model-drawn cover; a designed one is free and never priced. */
  cover: boolean;
  /** A narration's READY chapters, each already downloadable in the app. */
  narratedChapters: number;
};

export type UserStopSettlement = {
  claimKey: string;
  chargedCredits: number;
  keptCredits: number;
  /**
   * `delivered`: priced from the delivered work. `not-priced`: an operation
   * this rule does not price by delivery (an edit, a plan — each delivers whole
   * or not at all), or a book, rebuild or narration charge whose quote could not
   * be read back; those refund whole, as before, but still as the reader's own.
   */
  basis: "delivered" | "not-priced";
  delivered: UserStopDelivered;
  stoppedAt: string;
};

const NOTHING_DELIVERED: UserStopDelivered = { pages: 0, interiorImages: 0, cover: false, narratedChapters: 0 };

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The stamp on a charge, or null when a user stop never settled it. */
export function userStopSettlement(metadata: unknown): UserStopSettlement | null {
  const stamp = jsonRecord(jsonRecord(metadata).userStopSettlement);
  const { claimKey, chargedCredits, keptCredits, basis, stoppedAt } = stamp;
  if (
    typeof claimKey !== "string" ||
    !claimKey.startsWith(USER_STOP_CLAIM_PREFIX) ||
    !isCount(chargedCredits) ||
    !isCount(keptCredits) ||
    keptCredits > chargedCredits
  ) {
    return null;
  }
  const delivered = jsonRecord(stamp.delivered);
  return {
    claimKey,
    chargedCredits,
    keptCredits,
    basis: basis === "delivered" ? "delivered" : "not-priced",
    delivered: {
      pages: isCount(delivered.pages) ? delivered.pages : 0,
      interiorImages: isCount(delivered.interiorImages) ? delivered.interiorImages : 0,
      cover: delivered.cover === true,
      narratedChapters: isCount(delivered.narratedChapters) ? delivered.narratedChapters : 0
    },
    stoppedAt: typeof stoppedAt === "string" ? stoppedAt : ""
  };
}

/** The most this charge may ever give back: all of it, or what a user stop left refundable. */
export function refundableCredits(entry: { amountCredits: number; metadata: unknown }): number {
  const charged = Math.abs(entry.amountCredits);
  const stop = userStopSettlement(entry.metadata);
  return stop ? Math.max(0, charged - Math.min(stop.keptCredits, charged)) : charged;
}

type QuotedRates = {
  baseCredits: number;
  perPageCredits: number;
  quotedPages: number;
  imageCredits: number;
  quotedInteriorImages: number;
  coverCredits: number;
  quotedCover: boolean;
};

type QuoteLine = { code: unknown; quantity: number; unitCredits: number; credits: number };

function quoteLine(value: unknown): QuoteLine | null {
  const line = jsonRecord(value);
  return isCount(line.quantity) && isCount(line.unitCredits) && isCount(line.credits)
    ? { code: line.code, quantity: line.quantity, unitCredits: line.unitCredits, credits: line.credits }
    : null;
}

/** A stored quote's line items, only when every line parses and they add up to the charge. */
function quoteLines(estimate: unknown, chargedCredits: number): QuoteLine[] | null {
  const record = jsonRecord(estimate);
  if (!Array.isArray(record.lineItems) || record.totalCredits !== chargedCredits) return null;
  const lines = record.lineItems.map(quoteLine);
  if (lines.some((line) => line === null)) return null;
  const items = lines as QuoteLine[];
  return items.reduce((total, line) => total + line.credits, 0) === chargedCredits ? items : null;
}

/**
 * The rates a full-book charge was quoted at, read back off the
 * `creditEstimate` the approval stored beside it (core's
 * `estimateFullBookCreditCost`): a base plus a per-page line, then the interior
 * and cover picture lines in that order, then premium review and the export
 * unlock. A chat rebuild's quote (`estimateBookReplanCreditCost`) leads with a
 * `BOOK_REPLAN` line, its re-planning fee, which counts as base. Null when the
 * stored quote does not add up to the charge, so a quote read wrongly can only
 * ever refund whole, never keep too much.
 */
export function quotedFullBookRates(estimate: unknown, chargedCredits: number): QuotedRates | null {
  const items = quoteLines(estimate, chargedCredits);
  if (!items) return null;
  const pages = items.find((line) => line.code === "FULL_BOOK_GENERATION");
  const [interior, cover] = items.filter((line) => line.code === "IMAGE_GENERATION");
  if (!pages) return null;
  const rebuildCredits = items
    .filter((line) => line.code === "BOOK_REPLAN")
    .reduce((total, line) => total + line.credits, 0);
  const baseCredits = pages.credits - pages.quantity * pages.unitCredits + rebuildCredits;
  if (baseCredits < rebuildCredits) return null;
  return {
    baseCredits,
    perPageCredits: pages.unitCredits,
    quotedPages: pages.quantity,
    imageCredits: interior?.unitCredits ?? 0,
    quotedInteriorImages: interior?.quantity ?? 0,
    coverCredits: cover?.unitCredits ?? 0,
    quotedCover: (cover?.quantity ?? 0) > 0
  };
}

/**
 * The delivered part of a full book at its quoted rates. The base fee is kept
 * once any page exists, never for pictures alone; counts are clamped to what
 * was quoted, and premium review and the export unlock are never delivered by
 * a run that was stopped, so they always come back.
 */
export function deliveredFullBookCredits(
  rates: QuotedRates,
  delivered: Pick<UserStopDelivered, "pages" | "interiorImages" | "cover">
): number {
  const pages = Math.min(delivered.pages, rates.quotedPages);
  const images = Math.min(delivered.interiorImages, rates.quotedInteriorImages);
  const cover = delivered.cover && rates.quotedCover;
  return (
    (pages > 0 ? rates.baseCredits : 0) +
    pages * rates.perPageCredits +
    images * rates.imageCredits +
    (cover ? rates.coverCredits : 0)
  );
}

type QuotedNarrationRates = {
  /** The flat part of the price, kept once any chapter is READY. */
  baseCredits: number;
  /** Everything priced by the book's length: its words and pages. */
  lengthCredits: number;
};

/**
 * The rates a narration was quoted at, read back off the `creditEstimate` the
 * start route stored (core's `estimateAudiobookCreditCost`): the base folded
 * into the per-100-words line, then an optional per-page line. Null unless every
 * line is a narration line and the quote adds up to the charge.
 */
export function quotedAudiobookRates(estimate: unknown, chargedCredits: number): QuotedNarrationRates | null {
  const items = quoteLines(estimate, chargedCredits);
  const words = items?.[0];
  if (!items || !words || items.some((line) => line.code !== "AUDIOBOOK_GENERATION")) return null;
  const baseCredits = words.credits - words.quantity * words.unitCredits;
  if (baseCredits < 0) return null;
  return { baseCredits, lengthCredits: chargedCredits - baseCredits };
}

type NarrationDelivered = {
  readyChapters: number;
  /** The READY chapters' share of the narration, by the text each one reads. */
  readyShare: number;
};

/**
 * The delivered part of a narration: its base once a chapter is READY, plus
 * the READY chapters' share of the length-priced part, rounded down. A READY
 * chapter's audio and transcript are downloadable the moment it flips, so a
 * reader who listened and then deleted the book keeps paying for what they
 * heard; the chapters still to come are given back.
 */
export function deliveredAudiobookCredits(rates: QuotedNarrationRates, narration: NarrationDelivered): number {
  if (narration.readyChapters <= 0) return 0;
  const share = Math.min(1, Math.max(0, narration.readyShare));
  return rates.baseCredits + Math.floor(rates.lengthCredits * share);
}

/**
 * What the stopped narration had made READY. The audiobook row is matched by
 * the attempt's own job, so a narration this attempt did not start counts
 * nothing. The share is weighed by each chapter's estimated duration — the text
 * it reads aloud, which is what the per-word rate prices — and falls back to a
 * chapter count only when no chapter carries one.
 */
async function deliveredNarration(tx: BillingTx, projectId: string, primaryJobId: string): Promise<NarrationDelivered> {
  const audiobook = await tx.audiobook.findFirst({
    where: { projectId, generationJobId: primaryJobId },
    select: { chapters: { select: { status: true, estimatedDurationMs: true } } }
  });
  const chapters = audiobook?.chapters ?? [];
  const ready = chapters.filter((chapter) => chapter.status === "READY");
  if (ready.length === 0) return { readyChapters: 0, readyShare: 0 };
  const duration = (rows: typeof chapters) =>
    rows.reduce((total, chapter) => total + Math.max(0, chapter.estimatedDurationMs ?? 0), 0);
  const totalMs = duration(chapters);
  return {
    readyChapters: ready.length,
    readyShare: totalMs > 0 ? duration(ready) / totalMs : ready.length / chapters.length
  };
}

async function deliveredWork(tx: BillingTx, projectId: string): Promise<UserStopDelivered> {
  // Prose is the test, not `status`: the app's detail DTO previews every page
  // row, and a composed chapter's pages sit PENDING with their whole prose
  // until finalize. Only `generateBookSequential`'s placeholders are blank.
  const pages = await tx.page.count({ where: { projectId, markdown: { not: "" } } });
  const interiorImages = await tx.imageAsset.count({
    where: { projectId, pageId: { not: null }, type: { in: ["SCENE_ILLUSTRATION", "DIAGRAM"] } }
  });
  const covers = await tx.imageAsset.findMany({
    where: { projectId, type: "COVER" },
    select: { metadata: true }
  });
  return {
    pages,
    interiorImages,
    cover: covers.some((row) => jsonRecord(row.metadata).coverArtSource === "ai"),
    narratedChapters: 0
  };
}

/** The quote behind a charge: its own, or — for a paid retry, which stores none — its source's. */
async function quotedEstimate(
  tx: BillingTx,
  chargeMetadata: unknown,
  retryOfAttemptId: string | null
): Promise<unknown> {
  let metadata = chargeMetadata;
  let retryOf = retryOfAttemptId;
  for (let depth = 0; depth < MAX_RETRY_DEPTH; depth += 1) {
    const estimate = jsonRecord(metadata).creditEstimate;
    if (estimate !== undefined || !retryOf) return estimate ?? null;
    const source = await tx.generationAttempt.findUnique({
      where: { id: retryOf },
      select: { ledgerEntryId: true, retryOfAttemptId: true }
    });
    if (!source?.ledgerEntryId) return null;
    const charge = await tx.creditLedgerEntry.findUnique({
      where: { id: source.ledgerEntryId },
      select: { metadata: true }
    });
    metadata = charge?.metadata;
    retryOf = source.retryOfAttemptId;
  }
  return null;
}

/**
 * Stamps a stopped attempt's settled charge with what the stop keeps. Called
 * inside the stop's own transaction, for an attempt that transaction just
 * terminalized, so the delivered work is counted before a delete can cascade
 * it away. Idempotent: a charge already stamped keeps its first stamp.
 */
export async function recordUserStopSettlementTx(
  tx: BillingTx,
  attemptId: string,
  now: Date = new Date()
): Promise<UserStopSettlement | null> {
  const attempt = await tx.generationAttempt.findUnique({
    where: { id: attemptId },
    select: { operation: true, ledgerEntryId: true, projectId: true, retryOfAttemptId: true, primaryJobId: true }
  });
  if (!attempt?.ledgerEntryId) return null;
  const charge = await tx.creditLedgerEntry.findUnique({
    where: { id: attempt.ledgerEntryId },
    select: { id: true, status: true, amountCredits: true, metadata: true }
  });
  // A hold has no delivered half; only a settled spend is stamped.
  if (!charge || charge.status !== "SETTLED" || charge.amountCredits >= 0) return null;
  const existing = userStopSettlement(charge.metadata);
  if (existing) return existing;

  const chargedCredits = Math.abs(charge.amountCredits);
  let basis: UserStopSettlement["basis"] = "not-priced";
  let delivered = NOTHING_DELIVERED;
  let keptCredits = 0;
  // A rebuild's attempt belongs to the copy it is writing, so its delivered
  // pages are the copy's — the same rule as a full book.
  if ((attempt.operation === "FULL_BOOK_GENERATION" || attempt.operation === "BOOK_REPLAN") && attempt.projectId) {
    const rates = quotedFullBookRates(
      await quotedEstimate(tx, charge.metadata, attempt.retryOfAttemptId),
      chargedCredits
    );
    if (rates) {
      basis = "delivered";
      delivered = await deliveredWork(tx, attempt.projectId);
      keptCredits = Math.min(chargedCredits, deliveredFullBookCredits(rates, delivered));
    }
  } else if (attempt.operation === "AUDIOBOOK_GENERATION" && attempt.projectId && attempt.primaryJobId) {
    const rates = quotedAudiobookRates(
      await quotedEstimate(tx, charge.metadata, attempt.retryOfAttemptId),
      chargedCredits
    );
    if (rates) {
      basis = "delivered";
      const narration = await deliveredNarration(tx, attempt.projectId, attempt.primaryJobId);
      delivered = { ...NOTHING_DELIVERED, narratedChapters: narration.readyChapters };
      keptCredits = Math.min(chargedCredits, deliveredAudiobookCredits(rates, narration));
    }
  }
  const settlement: UserStopSettlement = {
    claimKey: `${USER_STOP_CLAIM_PREFIX}${attemptId}`,
    chargedCredits,
    keptCredits,
    basis,
    delivered,
    stoppedAt: now.toISOString()
  };
  await tx.creditLedgerEntry.update({
    where: { id: charge.id },
    data: { metadata: jsonInput({ ...jsonRecord(charge.metadata), userStopSettlement: settlement }) }
  });
  return settlement;
}
