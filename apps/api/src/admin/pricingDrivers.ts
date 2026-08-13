/**
 * What the last N days of real traffic would earn at any set of prices.
 *
 * Every credit charge in the product is a **linear** function of the price list:
 * a book costs `base×1 + perPage×pages + image×images + …`. So instead of
 * replaying the pricing formulas once per candidate price vector, this extracts
 * the *quantities* — how many books, how many pages, how many billable voice
 * minutes — once. Revenue at any prices is then a dot product, which is cheap
 * enough for the dashboard to recompute on every keystroke without asking the
 * server again.
 *
 * The quantities come from what was actually charged, not from what exists: a
 * book counts when a `FULL_BOOK_GENERATION` entry was written for it in the
 * window, so drafts nobody paid for never inflate the projection. A charge that
 * was later refunded does not count either — it is still a `SPEND`/`SETTLED`
 * row, which is why every query here goes through `CHARGE_KEPT`.
 *
 * `coverage` is the honesty check. Re-pricing the drivers at the *current* list
 * should reproduce what was really charged; when it doesn't, the model is
 * missing something (a price changed mid-window, a project was edited after the
 * fact) and the dashboard says so rather than projecting with false confidence.
 */

import {
  CREDIT_PRICE_KEYS,
  type CreditPriceKey,
  type CreditPricing,
  type ModelTier,
  coverArtSourceFor,
  createProjectSchema,
  estimateInteriorImageCount,
  isPremiumProject,
  modelTierForInput,
  modelTierFromMediaSettings,
  settleVoiceCall,
  tierPriceKey
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { inputSnapshotFromProject } from "../mobile/projectSerializers.js";
import { CHARGE_KEPT, round2, type AdminWindow } from "./metrics.js";

/** Quantities only for the keys that are prices — see `PLAN_ALLOWANCE_KEYS`. */
export type PricingDrivers = Record<CreditPriceKey, number>;

export type PricingDriverReport = {
  window: { days: number; since: string; until: string };
  drivers: PricingDrivers;
  providerUsd: number;
  books: number;
  voiceMinutes: number;
  edits: number;
  coverage: {
    /** What the ledger says was actually charged in the window. */
    chargedCredits: number;
    /** What these drivers reproduce at the price list in force now. */
    modelledCredits: number;
    /** 100 = the model reproduces the ledger exactly. */
    accuracyPercent: number | null;
  };
};

const projectSelect = {
  id: true,
  title: true,
  subtitle: true,
  authorName: true,
  coverTagline: true,
  prompt: true,
  category: true,
  subcategory: true,
  targetPages: true,
  complexity: true,
  temperature: true,
  language: true,
  mediaSettings: true
} as const;

/**
 * Built from the key list rather than written out, so a new price — a tier rate
 * above all — cannot be added without a driver bucket to count it into. A key
 * missing here would silently project zero revenue for whatever drives it.
 */
function emptyDrivers(): PricingDrivers {
  return Object.fromEntries(CREDIT_PRICE_KEYS.map((key) => [key, 0])) as PricingDrivers;
}

function audiobookPageCount(metadata: unknown): number {
  const value = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).pageCount : undefined;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function revenueAtPricing(drivers: PricingDrivers, pricing: CreditPricing): number {
  return (Object.keys(drivers) as CreditPriceKey[]).reduce(
    (total, key) => total + drivers[key] * pricing[key],
    0
  );
}

export async function loadPricingDrivers(
  window: AdminWindow,
  currentPricing: CreditPricing
): Promise<PricingDriverReport> {
  const inWindow = { gte: window.since, lte: window.until };
  // A refunded charge earned nothing, so it must not become a driver quantity
  // either — projecting revenue from it would price against work we gave away.
  const spend = { ...CHARGE_KEPT, createdAt: inWindow };

  const [bookCharges, replanCharges, flatCounts, chargedTotal, providerTotal, voiceCalls, edits, audiobookCharges] = await Promise.all([
    prisma.creditLedgerEntry.groupBy({
      by: ["projectId"],
      _count: { _all: true },
      where: { ...spend, operation: "FULL_BOOK_GENERATION", projectId: { not: null } }
    }),
    prisma.creditLedgerEntry.groupBy({
      by: ["projectId"],
      _count: { _all: true },
      where: { ...spend, operation: "BOOK_REPLAN", projectId: { not: null } }
    }),
    prisma.creditLedgerEntry.groupBy({ by: ["operation"], _count: { _all: true }, where: spend }),
    prisma.creditLedgerEntry.aggregate({ _sum: { amountCredits: true }, where: spend }),
    prisma.providerCallLog.aggregate({ _sum: { costHint: true }, where: { costHint: { not: null }, createdAt: inWindow } }),
    prisma.voiceCall.findMany({ where: { startedAt: inWindow }, select: { elapsedSeconds: true } }),
    prisma.bookEditOperation.findMany({
      where: { createdAt: inWindow, creditsCharged: { gt: 0 } },
      // The book's settings come along because the per-page edit rates follow
      // its quality tier. Without them every edit lands in the balanced bucket
      // and `coverage` drifts the first time a premium book is edited — which
      // is the one number here whose job is to notice that.
      select: { kind: true, affectedPageIndexes: true, project: { select: { mediaSettings: true } } }
    }),
    // The per-page half of an audiobook charge is only recoverable from the
    // reservation metadata — the ledger row holds a total, not a page count.
    prisma.creditLedgerEntry.findMany({
      where: { ...spend, operation: "AUDIOBOOK_GENERATION" },
      select: { metadata: true }
    })
  ]);

  const projectIds = [
    ...new Set([...bookCharges, ...replanCharges].map((row) => row.projectId).filter((id): id is string => Boolean(id)))
  ];
  const projects = projectIds.length
    ? await prisma.project.findMany({ where: { id: { in: projectIds } }, select: projectSelect })
    : [];

  // How much a single generation of each book contributes, at quantity 1.
  // The tier rides along because the rates it drove differ per tier, so a
  // premium book counted into the balanced buckets would project revenue at
  // prices nobody was charged.
  const bookShapes = new Map<string, { tier: ModelTier; pages: number; images: number; premium: number }>();
  for (const project of projects) {
    try {
      const input = createProjectSchema.parse(inputSnapshotFromProject(project));
      bookShapes.set(project.id, {
        tier: modelTierForInput(input),
        pages: input.targetPages,
        // Initial covers share the image-generation price. Cover regeneration
        // remains a separate, standalone operation counted from its own ledger rows.
        images: estimateInteriorImageCount(input) + (coverArtSourceFor(input.mediaSettings) === "ai" ? 1 : 0),
        premium: isPremiumProject(input) ? 1 : 0
      });
    } catch {
      // A project whose stored settings no longer parse is skipped rather than
      // failing the whole projection; `coverage` will show the shortfall.
    }
  }

  const drivers = emptyDrivers();
  const addBook = (projectId: string | null, times: number) => {
    const shape = projectId ? bookShapes.get(projectId) : undefined;
    if (!shape) {
      return;
    }
    drivers[tierPriceKey("fullBookBase", shape.tier)] += times;
    drivers[tierPriceKey("fullBookPerPage", shape.tier)] += shape.pages * times;
    drivers[tierPriceKey("imageGeneration", shape.tier)] += shape.images * times;
    drivers.premiumReview += shape.premium * times;
    // A full generation bundles the export unlock.
    drivers.exportUnlock += times;
  };

  for (const charge of bookCharges) {
    addBook(charge.projectId, charge._count._all);
  }
  for (const charge of replanCharges) {
    drivers.bookReplanBase += charge._count._all;
    // A replan is priced as its base plus a fresh full-book estimate.
    addBook(charge.projectId, charge._count._all);
  }

  const countOf = (operation: string) =>
    flatCounts.find((row) => row.operation === operation)?._count._all ?? 0;
  // Standalone unlocks only — the bundled ones are already counted above.
  drivers.exportUnlock += countOf("EXPORT_UNLOCK");
  drivers.planRevision += countOf("PLAN_REVISION");
  drivers.planGeneration += countOf("PLAN_GENERATION");
  drivers.previewGeneration += countOf("PREVIEW_GENERATION");
  drivers.coverRegeneration += countOf("COVER_REGENERATION");
  drivers.characterPortraitGeneration += countOf("CHARACTER_PORTRAIT_GENERATION");

  for (const call of voiceCalls) {
    drivers.voiceCallPerMinute += settleVoiceCall(call.elapsedSeconds).billableMinutes;
  }

  for (const charge of audiobookCharges) {
    drivers.audiobookBase += 1;
    drivers.audiobookPerPage += audiobookPageCount(charge.metadata);
  }

  for (const edit of edits) {
    const pages = Math.max(1, edit.affectedPageIndexes.length);
    const tier = modelTierFromMediaSettings(edit.project?.mediaSettings);
    if (edit.kind === "LOCAL_PATCH") {
      drivers.bookTextEditBase += 1;
      drivers[tierPriceKey("bookTextEditPerPage", tier)] += pages;
    } else if (edit.kind === "PAGE_REWRITE" || edit.kind === "CHAPTER_REGENERATE" || edit.kind === "CONTINUE_BOOK") {
      drivers[tierPriceKey("pageRegenerationPerPage", tier)] += pages;
    }
    // BOOK_REPLAN edits are already priced through the ledger above.
  }

  const chargedCredits = Math.abs(chargedTotal._sum.amountCredits ?? 0);
  const modelledCredits = revenueAtPricing(drivers, currentPricing);

  return {
    window: { days: window.days, since: window.since.toISOString(), until: window.until.toISOString() },
    drivers,
    providerUsd: round2(providerTotal._sum.costHint ?? 0),
    // One book is one base charge, whichever tier's base it drove.
    books: drivers.fullBookBaseFast + drivers.fullBookBase + drivers.fullBookBasePremium,
    voiceMinutes: drivers.voiceCallPerMinute,
    edits: edits.length,
    coverage: {
      chargedCredits,
      modelledCredits,
      accuracyPercent: chargedCredits > 0 ? Math.round((modelledCredits / chargedCredits) * 1000) / 10 : null
    }
  };
}
