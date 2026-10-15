import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CREDIT_COSTS,
  createProjectSchema,
  estimateAudiobookCreditCost,
  estimateBookReplanCreditCost,
  estimateFullBookCreditCost,
  resetCreditPricing
} from "@book-maker/core";

const fakeDb = await vi.hoisted(async () => (await import("./testing/billingTestDb.js")).createBillingTestDb());

/**
 * The rows a stop reads beside the ledger: the attempt it terminalizes, and
 * the pages and pictures that say what was delivered. `billingTestDb` models
 * only the billing tables, so these are attached here, as small as the stamp
 * and `failGenerationAttempt` need them.
 */
const generation = vi.hoisted(() => ({
  attempts: new Map<string, Record<string, any>>(),
  pages: [] as Array<{ projectId: string; markdown: string }>,
  images: [] as Array<{ projectId: string; pageId: string | null; type: string; metadata: unknown }>,
  audiobooks: [] as Array<{
    projectId: string;
    generationJobId: string;
    chapters: Array<{ status: string; estimatedDurationMs: number | null }>;
  }>
}));

Object.assign(fakeDb.prisma, {
  generationAttempt: {
    findUnique: vi.fn(async ({ where }: any) => generation.attempts.get(where.id) ?? null),
    update: vi.fn(async ({ where, data }: any) => Object.assign(generation.attempts.get(where.id)!, data)),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const row = generation.attempts.get(where.id);
      const statuses: string[] = where.status?.in ?? [where.status];
      if (!row || !statuses.includes(row.status)) return { count: 0 };
      if (where.refundPending !== undefined && row.refundPending !== where.refundPending) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
    findMany: vi.fn(async ({ where }: any) =>
      [...generation.attempts.values()].filter(
        (row) => row.refundPending === where.refundPending && where.status.in.includes(row.status)
      )
    )
  },
  page: {
    count: vi.fn(async ({ where }: any) =>
      generation.pages.filter((page) => page.projectId === where.projectId && page.markdown !== where.markdown.not).length
    )
  },
  imageAsset: {
    count: vi.fn(async ({ where }: any) =>
      generation.images.filter(
        (image) => image.projectId === where.projectId && image.pageId !== null && where.type.in.includes(image.type)
      ).length
    ),
    findMany: vi.fn(async ({ where }: any) =>
      generation.images.filter((image) => image.projectId === where.projectId && image.type === where.type)
    )
  },
  audiobook: {
    findFirst: vi.fn(async ({ where }: any) =>
      generation.audiobooks.find(
        (row) => row.projectId === where.projectId && row.generationJobId === where.generationJobId
      ) ?? null
    )
  }
});

vi.mock("./client.ts", () => ({
  prisma: fakeDb.prisma,
  Prisma: fakeDb.Prisma
}));

const {
  consumeIllustratedBookUse,
  ensureCurrentPlanPeriod,
  failGenerationAttempt,
  getCreditBalance,
  getImageQuota,
  reconcileGenerationAttemptRefunds,
  recordUserStopSettlementTx,
  refundCreditLedgerEntry,
  refundCreditLedgerEntryPortion,
  refundLatestProjectOperationCredits,
  spendCredits
} = await import("./billing.js");
const { deliveredAudiobookCredits, deliveredFullBookCredits, quotedAudiobookRates, quotedFullBookRates } = await import(
  "./userStopSettlement.js"
);

const STOPPED = "Stopped by user";
const JUNE = new Date("2026-06-15T12:00:00.000Z");
const JULY = new Date("2026-07-04T12:00:00.000Z");
const JUNE_START = new Date("2026-06-01T00:00:00.000Z");
const JULY_START = new Date("2026-07-01T00:00:00.000Z");
const PERIOD_KEY = "sub:test:2026-07-01";
const ALLOWANCE = 80_000;
const PROJECT = "project-1";

/**
 * A 10-page illustrated book quoted at 1,000 credits: a 200 base and 50 a page,
 * four interior pictures and a cover at 25 each, premium review 25, and the
 * export unlock 150 — the shape `estimateFullBookCreditCost` wrote before the
 * unlock was retired on 2026-10-15, which every charge from then still stores.
 */
const QUOTE = {
  totalCredits: 1000,
  lineItems: [
    { code: "FULL_BOOK_GENERATION", label: "Full book generation", quantity: 10, unitCredits: 50, credits: 700 },
    { code: "IMAGE_GENERATION", label: "Interior image generation", quantity: 4, unitCredits: 25, credits: 100 },
    { code: "IMAGE_GENERATION", label: "Cover image generation", quantity: 1, unitCredits: 25, credits: 25 },
    { code: "PREMIUM_REVIEW", label: "Premium review", quantity: 1, unitCredits: 25, credits: 25 },
    { code: "EXPORT_UNLOCK", label: "PDF/EPUB export unlock", quantity: 1, unitCredits: 150, credits: 150 }
  ],
  assumptions: { estimatedInteriorImages: 4, includesCover: true, includesExportUnlock: true, includesPremiumReview: true }
};

function seedLivePaidPeriod(userId: string, options: { planCredits?: number; purchased?: number } = {}): void {
  const planCredits = options.planCredits ?? ALLOWANCE;
  const purchased = options.purchased ?? 0;
  fakeDb.state.accounts.set(userId, {
    userId,
    availableCredits: purchased,
    reservedCredits: 0,
    lifetimeCreditsGranted: planCredits + purchased,
    lifetimeCreditsSpent: 0,
    planCredits,
    planCreditsPerPeriod: ALLOWANCE,
    planPeriodStart: JUNE_START,
    planPeriodEnd: JULY_START,
    planPeriodKey: PERIOD_KEY
  });
}

/** What plan approval commits: a paid attempt whose charge carries the quote it was priced at. */
async function approveBook(
  attemptId: string,
  options: {
    amount?: number;
    imageQuotaPeriodKey?: string;
    retryOfAttemptId?: string;
    quote?: unknown;
    operation?: "FULL_BOOK_GENERATION" | "BOOK_REPLAN" | "AUDIOBOOK_GENERATION";
    projectId?: string;
    primaryJobId?: string;
  } = {}
) {
  const operation = options.operation ?? "FULL_BOOK_GENERATION";
  const projectId = options.projectId ?? PROJECT;
  const spend = await spendCredits({
    userId: "user-a",
    projectId,
    operation,
    amountCredits: options.amount ?? QUOTE.totalCredits,
    idempotencyKey: `generation-attempt:${attemptId}`,
    metadata: {
      generationAttemptId: attemptId,
      ...(options.quote === undefined ? { creditEstimate: QUOTE } : options.quote === null ? {} : { creditEstimate: options.quote }),
      ...(options.imageQuotaPeriodKey ? { imageQuota: { periodKey: options.imageQuotaPeriodKey } } : {})
    },
    now: new Date()
  });
  generation.attempts.set(attemptId, {
    id: attemptId,
    userId: "user-a",
    status: "ACTIVE",
    operation,
    projectId,
    primaryJobId: options.primaryJobId ?? null,
    ledgerEntryId: spend!.id,
    retryOfAttemptId: options.retryOfAttemptId ?? null,
    refundPending: false,
    error: null
  });
  return spend!;
}

function deliver(options: {
  pages?: number;
  placeholders?: number;
  images?: number;
  cover?: "ai" | "design";
  projectId?: string;
}): void {
  const projectId = options.projectId ?? PROJECT;
  for (let page = 0; page < (options.pages ?? 0); page += 1) {
    generation.pages.push({ projectId, markdown: `Page ${page + 1} prose.` });
  }
  for (let page = 0; page < (options.placeholders ?? 0); page += 1) {
    generation.pages.push({ projectId, markdown: "" });
  }
  for (let image = 0; image < (options.images ?? 0); image += 1) {
    generation.images.push({ projectId, pageId: `page-${image + 1}`, type: "SCENE_ILLUSTRATION", metadata: {} });
  }
  if (options.cover) {
    generation.images.push({ projectId, pageId: null, type: "COVER", metadata: { coverArtSource: options.cover } });
  }
}

/**
 * What `stopProjectGenerationJobs` does for a paid attempt: one transaction
 * terminalizes it with its refund obligation and stamps the charge with what
 * the stop keeps, and the serializable settlement runs after it.
 */
async function stopTransaction(attemptId: string): Promise<void> {
  await fakeDb.prisma.$transaction(async (tx: any) => {
    const claimed = await tx.generationAttempt.updateMany({
      where: { id: attemptId, status: { in: ["QUEUED", "ACTIVE"] } },
      data: { status: "CANCELED", error: STOPPED, finishedAt: new Date(), refundPending: true }
    });
    if (claimed.count === 1) await recordUserStopSettlementTx(tx, attemptId);
  });
}

async function userStops(attemptId: string): Promise<void> {
  await stopTransaction(attemptId);
  await failGenerationAttempt(attemptId, STOPPED, "CANCELED");
}

function reversalOf(entryId: string) {
  return [...fakeDb.state.ledger.values()].find((row) => row.reversesEntryId === entryId) ?? null;
}

function lapseRows() {
  return [...fakeDb.state.ledger.values()].filter(
    (row) => row.entryType === "ADJUSTMENT" && (row.metadata as Record<string, unknown>)?.lapsedRefundOfEntryId
  );
}

describe("pricing what a stopped book delivered", () => {
  it("reads back the quote core actually writes", () => {
    const input = createProjectSchema.parse({
      prompt: "Create a practical workbook about onboarding new managers.",
      category: "EDUCATION",
      subcategory: "Workbook or Study Guide",
      targetPages: 28,
      complexity: 5,
      temperature: 0.65,
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "minimal",
        finalReview: true,
        toneProfile: "neutral"
      }
    });
    const estimate = estimateFullBookCreditCost(input);
    const rates = quotedFullBookRates(JSON.parse(JSON.stringify(estimate)), estimate.totalCredits);
    expect(rates).not.toBeNull();
    const everything = {
      pages: input.targetPages,
      interiorImages: estimate.assumptions.estimatedInteriorImages,
      cover: true
    };
    const premium = estimate.lineItems.find((line) => line.code === "PREMIUM_REVIEW")?.credits ?? 0;

    expect(deliveredFullBookCredits(rates!, { pages: 0, interiorImages: 0, cover: false })).toBe(0);
    // Everything a run delivers is kept; review is not delivered by a stopped run.
    expect(deliveredFullBookCredits(rates!, everything)).toBe(estimate.totalCredits - premium);
    // More rows than were quoted are never priced past the quote.
    expect(deliveredFullBookCredits(rates!, { ...everything, pages: 400, interiorImages: 400 })).toBe(
      deliveredFullBookCredits(rates!, everything)
    );
  });

  it("reads a quote stored before the unlock was retired to the same delivered amount as one after", () => {
    // A charge from before 2026-10-15 stored a 150-credit export line beside
    // the book's lines; today's quote has none. A stop keeps exactly the same
    // for the same delivery, and the old charge's unlock always comes back.
    const input = createProjectSchema.parse({
      prompt: "A bedtime story about a rabbit who is afraid of the dark.",
      category: "KIDS",
      targetPages: 12,
      mediaSettings: { fullIllustrations: true, coverArtSource: "ai", mobile: { bookType: "short_story" } }
    });
    const today = estimateFullBookCreditCost(input);
    const legacy = {
      ...today,
      totalCredits: today.totalCredits + 150,
      lineItems: [
        ...today.lineItems,
        { code: "EXPORT_UNLOCK", label: "PDF/EPUB export unlock", quantity: 1, unitCredits: 150, credits: 150 }
      ],
      assumptions: { ...today.assumptions, includesExportUnlock: true }
    };
    const todayRates = quotedFullBookRates(JSON.parse(JSON.stringify(today)), today.totalCredits)!;
    const legacyRates = quotedFullBookRates(JSON.parse(JSON.stringify(legacy)), legacy.totalCredits)!;
    expect(today.lineItems.some((line) => line.code === "EXPORT_UNLOCK")).toBe(false);
    expect(legacyRates).toEqual(todayRates);
    const delivered = { pages: 6, interiorImages: 6, cover: true };
    expect(deliveredFullBookCredits(legacyRates, delivered)).toBe(deliveredFullBookCredits(todayRates, delivered));
    expect(deliveredFullBookCredits(todayRates, { pages: 12, interiorImages: 12, cover: true })).toBe(today.totalCredits);
  });

  it("keeps the base fee only once a page exists", () => {
    const rates = quotedFullBookRates(QUOTE, 1000)!;
    expect(deliveredFullBookCredits(rates, { pages: 0, interiorImages: 0, cover: true })).toBe(25);
    expect(deliveredFullBookCredits(rates, { pages: 4, interiorImages: 1, cover: false })).toBe(200 + 4 * 50 + 25);
  });

  it("refuses a quote that does not add up to the charge, so a misread can only refund whole", () => {
    expect(quotedFullBookRates(QUOTE, 999)).toBeNull();
    expect(quotedFullBookRates({ ...QUOTE, lineItems: QUOTE.lineItems.slice(1) }, 1000)).toBeNull();
    expect(quotedFullBookRates(undefined, 1000)).toBeNull();
  });

  it("reads a rebuild's quote as its re-planning fee on top of the copy's full-book base", () => {
    const input = createProjectSchema.parse({
      prompt: "Retell the lighthouse story for teenagers.",
      category: "STORY",
      targetPages: 12,
      mediaSettings: { fullIllustrations: true, includeCover: true }
    });
    const book = estimateFullBookCreditCost(input);
    const replan = estimateBookReplanCreditCost(input);
    const bookRates = quotedFullBookRates(JSON.parse(JSON.stringify(book)), book.totalCredits)!;
    const replanRates = quotedFullBookRates(JSON.parse(JSON.stringify(replan)), replan.totalCredits)!;

    expect(replanRates).toEqual({ ...bookRates, baseCredits: bookRates.baseCredits + DEFAULT_CREDIT_COSTS.bookReplanBase });
    expect(deliveredFullBookCredits(replanRates, { pages: 0, interiorImages: 0, cover: false })).toBe(0);
  });

  it("reads back a narration's quote and keeps its base only once a chapter is READY", () => {
    const estimate = estimateAudiobookCreditCost({ pageCount: 20, wordCount: 6_000 });
    const rates = quotedAudiobookRates(JSON.parse(JSON.stringify(estimate)), estimate.totalCredits)!;
    expect(rates.baseCredits).toBe(DEFAULT_CREDIT_COSTS.audiobookBase);
    expect(rates.baseCredits + rates.lengthCredits).toBe(estimate.totalCredits);

    expect(deliveredAudiobookCredits(rates, { readyChapters: 0, readyShare: 0.5 })).toBe(0);
    expect(deliveredAudiobookCredits(rates, { readyChapters: 3, readyShare: 1 })).toBe(estimate.totalCredits);
    expect(deliveredAudiobookCredits(rates, { readyChapters: 1, readyShare: 0.25 })).toBe(
      rates.baseCredits + Math.floor(rates.lengthCredits * 0.25)
    );
    expect(quotedAudiobookRates(estimate, estimate.totalCredits + 1)).toBeNull();
    expect(quotedAudiobookRates(QUOTE, 1000)).toBeNull();
  });
});

describe("a reader's own stop or delete", () => {
  beforeEach(() => {
    fakeDb.reset();
    resetCreditPricing();
    generation.attempts.clear();
    generation.pages.length = 0;
    generation.images.length = 0;
    generation.audiobooks.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(JUNE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refunds only what was not delivered, through the partial reversal under the stop's claim", async () => {
    seedLivePaidPeriod("user-a");
    const spend = await approveBook("attempt-1");
    deliver({ pages: 4, placeholders: 6, images: 1, cover: "design" });

    await userStops("attempt-1");

    // Kept: the 200 base, four pages at 50, one picture at 25. A designed cover is free.
    const kept = 200 + 4 * 50 + 25;
    expect(reversalOf(spend.id)).toMatchObject({ amountCredits: 1000 - kept, planCreditsDelta: 1000 - kept });
    expect((reversalOf(spend.id)!.metadata as Record<string, unknown>).refundClaimKeys).toEqual([
      "user-stop:attempt-1"
    ]);
    expect(await getCreditBalance("user-a")).toMatchObject({
      planCredits: ALLOWANCE - kept,
      purchasedCredits: 0,
      lifetimeCreditsSpent: kept
    });
    expect(generation.attempts.get("attempt-1")).toMatchObject({ status: "CANCELED", refundPending: false });
  });

  it("refunds everything, as before, when the stop came before the first page", async () => {
    seedLivePaidPeriod("user-a");
    const spend = await approveBook("attempt-1");
    deliver({ placeholders: 10 });

    await userStops("attempt-1");

    expect(reversalOf(spend.id)).toMatchObject({ amountCredits: 1000 });
    expect(await getCreditBalance("user-a")).toMatchObject({ planCredits: ALLOWANCE, lifetimeCreditsSpent: 0 });
  });

  it("keeps the free illustrated-book slot once anything was delivered, and returns it when nothing was", async () => {
    seedLivePaidPeriod("user-a");
    const limit = DEFAULT_CREDIT_COSTS.freeIllustratedBooksPerMonth;
    const kept = await consumeIllustratedBookUse({ userId: "user-a", limit, now: JUNE });
    await approveBook("attempt-kept", { imageQuotaPeriodKey: kept.periodKey });
    deliver({ pages: 2, images: 1 });
    await userStops("attempt-kept");
    expect(await getImageQuota("user-a", JUNE)).toMatchObject({ used: 1 });

    generation.pages.length = 0;
    generation.images.length = 0;
    const returned = await consumeIllustratedBookUse({ userId: "user-a", limit, now: JUNE });
    await approveBook("attempt-returned", { imageQuotaPeriodKey: returned.periodKey });
    await userStops("attempt-returned");
    expect(await getImageQuota("user-a", JUNE)).toMatchObject({ used: 1 });
  });

  it("is settled once, whichever path reaches the charge after the stop", async () => {
    seedLivePaidPeriod("user-a");
    const spend = await approveBook("attempt-1");
    deliver({ pages: 4, images: 1 });
    await userStops("attempt-1");
    const settled = { ...reversalOf(spend.id)! };
    const balance = await getCreditBalance("user-a");

    // The worker noticing the stop, the attempt reconciler, the attempt-less
    // fallbacks, and a later failure delivery all meet the same stamp.
    await failGenerationAttempt("attempt-1", STOPPED, "CANCELED");
    generation.attempts.get("attempt-1")!.refundPending = true;
    await reconcileGenerationAttemptRefunds();
    await refundCreditLedgerEntry(spend.id, "Generation failed");
    await refundLatestProjectOperationCredits({ projectId: PROJECT, operation: "FULL_BOOK_GENERATION", reason: "Fallback" });
    // A partial under a claim of its own is the one top-up that never passes
    // through the stop's claim key; only the ceiling stands in its way.
    await refundCreditLedgerEntryPortion({
      entryId: spend.id,
      amountCredits: 300,
      reason: "Shortfall",
      idempotencyKey: "another-claim"
    });
    await refundCreditLedgerEntryPortion({
      entryId: spend.id,
      amountCredits: 1000,
      reason: "Shortfall",
      idempotencyKey: "a-whole-claim"
    });

    expect(reversalOf(spend.id)).toMatchObject({ amountCredits: settled.amountCredits });
    expect(await getCreditBalance("user-a")).toEqual(balance);
  });

  it("no longer stands for the latest-charge fallback, which passes over it to the charge behind it", async () => {
    seedLivePaidPeriod("user-a");
    const older = await approveBook("attempt-older");
    const stopped = await approveBook("attempt-stopped");
    deliver({ pages: 4 });
    await userStops("attempt-stopped");

    await refundLatestProjectOperationCredits({ projectId: PROJECT, operation: "FULL_BOOK_GENERATION", reason: "Fallback" });

    expect(reversalOf(older.id)).toMatchObject({ amountCredits: 1000 });
    expect(reversalOf(stopped.id)).toMatchObject({ amountCredits: 1000 - 400 });
  });

  it("settles the stop's verdict when only the reconciler reaches it, even after more pages landed", async () => {
    seedLivePaidPeriod("user-a");
    const spend = await approveBook("attempt-1");
    deliver({ pages: 4 });
    // The settlement after the stop failed; the attempt sits CANCELED with
    // `refundPending`, and the run kept writing for a moment before it saw the stop.
    await stopTransaction("attempt-1");
    deliver({ pages: 3 });

    await reconcileGenerationAttemptRefunds();

    expect(reversalOf(spend.id)).toMatchObject({ amountCredits: 1000 - (200 + 4 * 50) });
    expect(generation.attempts.get("attempt-1")).toMatchObject({ status: "CANCELED", refundPending: false });
  });

  it("stamps a charge once, so a second stop cannot re-count the pages", async () => {
    seedLivePaidPeriod("user-a");
    const spend = await approveBook("attempt-1");
    deliver({ pages: 2 });
    const first = await recordUserStopSettlementTx(fakeDb.prisma as never, "attempt-1");
    deliver({ pages: 5 });
    const second = await recordUserStopSettlementTx(fakeDb.prisma as never, "attempt-1");

    expect(second).toEqual(first);
    expect(first).toMatchObject({ keptCredits: 300, basis: "delivered", delivered: { pages: 2 } });
    expect((fakeDb.state.ledger.get(spend.id)!.metadata as Record<string, unknown>).creditEstimate).toEqual(QUOTE);
  });

  it("prices a paid retry at the quote its source attempt was charged", async () => {
    seedLivePaidPeriod("user-a");
    await approveBook("attempt-source");
    generation.attempts.get("attempt-source")!.status = "FAILED";
    // The retry lane stores no quote of its own: `{ sourceAttemptId, retryRequestId }`.
    const retry = await approveBook("attempt-retry", { retryOfAttemptId: "attempt-source", quote: null });
    deliver({ pages: 1 });

    await userStops("attempt-retry");

    expect(reversalOf(retry.id)).toMatchObject({ amountCredits: 1000 - 250 });
  });

  it("refunds whole when the charge carries no quote it can be priced from", async () => {
    seedLivePaidPeriod("user-a");
    const spend = await approveBook("attempt-1", { quote: null });
    deliver({ pages: 9 });

    await userStops("attempt-1");

    expect(reversalOf(spend.id)).toMatchObject({ amountCredits: 1000 });
  });

  // H3: a rebuild's copy (a translation included) previewed page by page while
  // it was written, then deleted, used to come back whole with its slot.
  it("prices a rebuild's copy by what the copy delivered, re-planning fee kept once a page exists", async () => {
    seedLivePaidPeriod("user-a");
    const rebuildQuote = {
      ...QUOTE,
      totalCredits: 1120,
      lineItems: [
        { code: "BOOK_REPLAN", label: "Book rebuild", quantity: 1, unitCredits: 120, credits: 120 },
        ...QUOTE.lineItems
      ]
    };
    const limit = DEFAULT_CREDIT_COSTS.freeIllustratedBooksPerMonth;
    const slot = await consumeIllustratedBookUse({ userId: "user-a", limit, now: JUNE });
    const spend = await approveBook("attempt-replan", {
      operation: "BOOK_REPLAN",
      projectId: "project-copy",
      amount: 1120,
      quote: rebuildQuote,
      imageQuotaPeriodKey: slot.periodKey
    });
    // The source book's pages are not the copy's delivery.
    deliver({ pages: 10, images: 4, cover: "ai" });
    deliver({ projectId: "project-copy", pages: 3, placeholders: 7, images: 1 });

    await userStops("attempt-replan");

    const kept = 120 + 200 + 3 * 50 + 25;
    expect(reversalOf(spend.id)).toMatchObject({ amountCredits: 1120 - kept });
    expect(await getImageQuota("user-a", JUNE)).toMatchObject({ used: 1 });
  });

  it("refunds a rebuild charged before its quote was stored whole, as before", async () => {
    seedLivePaidPeriod("user-a");
    const spend = await approveBook("attempt-replan", {
      operation: "BOOK_REPLAN",
      projectId: "project-copy",
      amount: 1120,
      quote: null
    });
    deliver({ projectId: "project-copy", pages: 6 });

    await userStops("attempt-replan");

    expect(reversalOf(spend.id)).toMatchObject({ amountCredits: 1120 });
  });

  // H3: READY chapters are downloadable mid-run.
  it("keeps a stopped narration's READY chapters by the share of the book they read, and returns the rest", async () => {
    seedLivePaidPeriod("user-a");
    const quote = estimateAudiobookCreditCost({ pageCount: 20, wordCount: 6_000 });
    const spend = await approveBook("attempt-narration", {
      operation: "AUDIOBOOK_GENERATION",
      amount: quote.totalCredits,
      quote,
      primaryJobId: "job-narration"
    });
    generation.audiobooks.push({
      projectId: PROJECT,
      generationJobId: "job-narration",
      chapters: [
        { status: "READY", estimatedDurationMs: 60_000 },
        { status: "READY", estimatedDurationMs: 90_000 },
        { status: "PENDING", estimatedDurationMs: 150_000 },
        { status: "PENDING", estimatedDurationMs: 300_000 }
      ]
    });

    await userStops("attempt-narration");

    const lengthCredits = quote.totalCredits - DEFAULT_CREDIT_COSTS.audiobookBase;
    const kept = DEFAULT_CREDIT_COSTS.audiobookBase + Math.floor(lengthCredits * (150_000 / 600_000));
    expect(reversalOf(spend.id)).toMatchObject({ amountCredits: quote.totalCredits - kept });
    expect(
      (fakeDb.state.ledger.get(spend.id)!.metadata as Record<string, any>).userStopSettlement
    ).toMatchObject({ basis: "delivered", keptCredits: kept, delivered: { narratedChapters: 2 } });
  });

  it("refunds a narration whole when no chapter of its own run was READY", async () => {
    seedLivePaidPeriod("user-a");
    const quote = estimateAudiobookCreditCost({ pageCount: 20, wordCount: 6_000 });
    const spend = await approveBook("attempt-narration", {
      operation: "AUDIOBOOK_GENERATION",
      amount: quote.totalCredits,
      quote,
      primaryJobId: "job-narration"
    });
    // Another run's row (a replaced narration) is not this attempt's delivery.
    generation.audiobooks.push({
      projectId: PROJECT,
      generationJobId: "job-earlier",
      chapters: [{ status: "READY", estimatedDurationMs: 60_000 }]
    });

    await userStops("attempt-narration");

    expect(reversalOf(spend.id)).toMatchObject({ amountCredits: quote.totalCredits });
  });
});

// B3: a free recompile on a delivered book walked its plan to the book's charge.
describe("a delivered attempt's charge", () => {
  beforeEach(() => {
    fakeDb.reset();
    resetCreditPricing();
    generation.attempts.clear();
    generation.pages.length = 0;
    generation.images.length = 0;
    generation.audiobooks.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(JUNE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is never reversed by an attempt-less refund or the latest-charge fallback", async () => {
    seedLivePaidPeriod("user-a");
    const spend = await approveBook("attempt-1");
    generation.attempts.get("attempt-1")!.status = "SUCCEEDED";
    const balance = await getCreditBalance("user-a");

    expect(await refundCreditLedgerEntry(spend.id, "Stopped by user")).toBeNull();
    expect(
      await refundLatestProjectOperationCredits({ projectId: PROJECT, operation: "FULL_BOOK_GENERATION", reason: "Fallback" })
    ).toBeNull();

    expect(reversalOf(spend.id)).toBeNull();
    expect(await getCreditBalance("user-a")).toEqual(balance);
  });

  it("does not let the fallback reach past it to an older charge", async () => {
    seedLivePaidPeriod("user-a");
    const older = await approveBook("attempt-older");
    await approveBook("attempt-delivered");
    generation.attempts.get("attempt-delivered")!.status = "SUCCEEDED";

    await refundLatestProjectOperationCredits({ projectId: PROJECT, operation: "FULL_BOOK_GENERATION", reason: "Fallback" });

    expect(reversalOf(older.id)).toBeNull();
  });

  it("still refunds an attempt that failed, through the attempt", async () => {
    seedLivePaidPeriod("user-a");
    const spend = await approveBook("attempt-1");

    await failGenerationAttempt("attempt-1", "Provider failed");

    expect(reversalOf(spend.id)).toMatchObject({ amountCredits: 1000 });
  });
});

describe("plan credits from a period that has ended", () => {
  beforeEach(() => {
    fakeDb.reset();
    resetCreditPricing();
    generation.attempts.clear();
    generation.pages.length = 0;
    generation.images.length = 0;
    generation.audiobooks.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(JUNE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lapse on a user stop instead of becoming permanent purchased credits", async () => {
    // The reported exploit: books started on the allowance shortly before the
    // reset and deleted after it used to come back as purchased credits that
    // never expire. They now expire with the period they were drawn from.
    seedLivePaidPeriod("user-a");
    const spend = await approveBook("attempt-1", { amount: ALLOWANCE, quote: null });
    vi.setSystemTime(JULY);
    await ensureCurrentPlanPeriod("user-a", JULY);

    await userStops("attempt-1");

    expect(await getCreditBalance("user-a", JULY)).toMatchObject({ availableCredits: 0, purchasedCredits: 0 });
    // The charge is settled whole — the reversal counts the lapsed share — and
    // the lapse is its own expiry row, the shape a period boundary writes.
    expect(reversalOf(spend.id)).toMatchObject({ amountCredits: ALLOWANCE, planCreditsDelta: ALLOWANCE });
    expect(lapseRows()).toEqual([
      expect.objectContaining({
        amountCredits: -ALLOWANCE,
        planCreditsDelta: -ALLOWANCE,
        metadata: expect.objectContaining({ expiredPlanPeriodKey: PERIOD_KEY })
      })
    ]);
    // Nothing lands in a pool, so nothing has been spent either.
    expect(fakeDb.state.accounts.get("user-a")).toMatchObject({ lifetimeCreditsSpent: 0, planCredits: 0 });

    // The expiry row is not a charge any fallback may give back.
    await refundLatestProjectOperationCredits({ projectId: PROJECT, operation: "FULL_BOOK_GENERATION", reason: "Fallback" });
    expect(await getCreditBalance("user-a", JULY)).toMatchObject({ availableCredits: 0, purchasedCredits: 0 });
  });

  it("still return to the purchased pool on a failure the reader did not cause", async () => {
    seedLivePaidPeriod("user-a");
    const spend = await approveBook("attempt-1", { amount: 1000 });
    deliver({ pages: 4 });
    vi.setSystemTime(JULY);
    await ensureCurrentPlanPeriod("user-a", JULY);

    await failGenerationAttempt("attempt-1", "Provider failed");

    expect(await getCreditBalance("user-a", JULY)).toMatchObject({ purchasedCredits: 1000 });
    expect(reversalOf(spend.id)).toMatchObject({ amountCredits: 1000, planCreditsDelta: 0 });
    expect(lapseRows()).toEqual([]);
  });

  it("lapse only the allowance the kept work did not use, and return every purchased credit", async () => {
    seedLivePaidPeriod("user-a", { planCredits: 600, purchased: 400 });
    const spend = await approveBook("attempt-1");
    deliver({ pages: 4, images: 1 });
    vi.setSystemTime(JULY);
    await ensureCurrentPlanPeriod("user-a", JULY);

    await userStops("attempt-1");

    // 425 was kept, and spending draws the allowance first, so the kept pages
    // used 425 of June's 600. What comes back is the other 575: all 400
    // purchased credits, and the 175 of June's allowance that has now ended.
    expect(await getCreditBalance("user-a", JULY)).toMatchObject({ purchasedCredits: 400 });
    expect(lapseRows()).toEqual([expect.objectContaining({ amountCredits: -175, planCreditsDelta: -175 })]);
    expect(reversalOf(spend.id)).toMatchObject({ amountCredits: 575, planCreditsDelta: 175 });
  });

  it("return the same-period allowance share to the allowance it came from", async () => {
    seedLivePaidPeriod("user-a", { planCredits: 600, purchased: 400 });
    await approveBook("attempt-1");
    deliver({ pages: 4, images: 1 });

    await userStops("attempt-1");

    // The same split, but June is still live: nothing lapses, and the reader
    // holds exactly what a 425-credit run would have left them.
    expect(await getCreditBalance("user-a")).toMatchObject({ planCredits: 175, purchasedCredits: 400 });
    expect(lapseRows()).toEqual([]);
  });

  it("return the purchased share of a straddling charge to the purchased pool", async () => {
    seedLivePaidPeriod("user-a", { planCredits: 300, purchased: 700 });
    await approveBook("attempt-1");
    vi.setSystemTime(JULY);
    await ensureCurrentPlanPeriod("user-a", JULY);

    await userStops("attempt-1");

    expect(await getCreditBalance("user-a", JULY)).toMatchObject({ purchasedCredits: 700 });
    expect(lapseRows()).toEqual([expect.objectContaining({ amountCredits: -300 })]);
  });
});
