/**
 * Business metrics for the operator dashboard.
 *
 * Two things are worth knowing before reading a number off this page.
 *
 * **Provider spend is exact, not estimated.** `ProviderCallLog.costHint` is
 * written as `null` for every provisional, in-flight, or failed call and set to
 * the priced cost only once a call settles with real token counts
 * (`apps/worker/src/providers/usageAccounting.ts`). So a non-null `costHint`
 * *is* a settled priced call, and `SUM(costHint)` is the money actually spent —
 * no rate cards need replaying here. Calls the rate card could not price are
 * counted separately as `unpricedCalls` so the total is never quietly short.
 *
 * **"Revenue" means two different things and the dashboard shows both.** Cash
 * collected (the net of `PurchasePayment` amounts and refunds) is cash during the
 * window, shown both at catalog price and net of Google's fee (`cashRevenue.ts`).
 * Credits delivered is the value of work done in the window, each credit valued
 * by where it came from (`creditValuation.ts`) — welcome credits at nothing —
 * which is what actually pairs against provider spend for unit economics.
 * They diverge because a reader buys credits on one day and spends them on
 * another; reporting either alone would misstate a margin.
 *
 * **A refunded charge is still a `SPEND`/`SETTLED` row.** Its linked positive
 * reversal is cumulative and may be smaller than the charge, so every revenue
 * figure is gross spend minus the actual reversal amount. Presence alone is
 * not a whole-refund predicate.
 */

import { Prisma, prisma } from "@book-maker/db";
import { loadWindowPayments, summarizePayments, type CashSummary, type CurrencyRevenue } from "./cashRevenue.js";
import {
  creditValuationSummary,
  loadOutstandingPaidCredits,
  loadValuedSpends,
  type CreditValuationSummary,
  type ValuedSpend
} from "./creditValuation.js";
import { loadShareFunnel, type ShareFunnel } from "./shareFunnel.js";

export type AdminWindow = { days: number; since: Date; until: Date };

/** Original charge rows; their linked REFUND amount determines the net. */
export const SETTLED_CHARGE = {
  entryType: "SPEND",
  status: "SETTLED"
} satisfies Prisma.CreditLedgerEntryWhereInput;

/** Reversal rows are positive and retain the source operation. */
export const SETTLED_REFUND = {
  entryType: "REFUND",
  status: "SETTLED"
} satisfies Prisma.CreditLedgerEntryWhereInput;

/** Gross settled SPEND minus its cumulative REFUND, floored at zero. SPEND is stored negative. */
export function netSettledCredits(spendCredits: number, refundCredits: number): number {
  return Math.max(Math.abs(spendCredits) - Math.max(refundCredits, 0), 0);
}

export type MoneySeriesPoint = {
  date: string;
  /** Catalog USD less refunds, before Google's fee. */
  cashUsd: number;
  /** `cashUsd` less Google's fee. */
  cashNetUsd: number;
  providerUsd: number;
  creditsDeliveredUsd: number;
  newUsers: number;
  booksCompleted: number;
};

export type NamedTotal = { key: string; label: string; value: number; secondary?: number };

export type AdminOverview = {
  window: { days: number; since: string; until: string };
  /** How every credit figure below was turned into dollars (`creditValuation.ts`). */
  valuation: CreditValuationSummary;
  money: {
    /** Catalog USD less refunds — what readers were charged, before Google's fee. */
    cashCollectedUsd: number;
    /** Google's service fee on `cashCollectedUsd`. */
    playFeeUsd: number;
    /** What reaches us: `cashCollectedUsd` less Google's fee. */
    cashNetUsd: number;
    providerSpendUsd: number;
    /** Net cash less provider spend. */
    cashMarginUsd: number;
    cashMarginPercent: number | null;
    creditsDelivered: number;
    /** Delivered credits valued by source; welcome and operator credits are worth $0. */
    creditsDeliveredUsd: number;
    /** The delivered credits someone paid for; the rest were free. */
    paidCreditsDelivered: number;
    /** Charges made in the window that were later given back. Not in the above. */
    creditsRefunded: number;
    creditsRefundedUsd: number;
    unitMarginUsd: number;
    unitMarginPercent: number | null;
    /** Credits held but not yet spent — an obligation, not income. Welcome credits included. */
    creditsOutstanding: number;
    /** The bought-and-paid-for part of the bought pools, and what it was bought for. */
    paidCreditsOutstanding: number;
    creditsOutstandingUsd: number;
    unpricedCalls: number;
  };
  /** The window's orders in the buyer's own currency, never converted. */
  revenueByCurrency: CurrencyRevenue[];
  people: {
    totalUsers: number;
    newUsers: number;
    activeUsers: number;
    disabledUsers: number;
    activeSubscriptions: number;
    payingUsers: number;
  };
  work: {
    projectsCreated: number;
    projectsCompleted: number;
    projectsFailed: number;
    booksInFlight: number;
    jobsRun: number;
    jobsFailed: number;
    jobFailureRate: number | null;
    voiceCalls: number;
    voiceMinutes: number;
    pendingModerationReports: number;
  };
  /** The book-sharing funnel for shares created in the window (`shareFunnel.ts`). */
  sharing: ShareFunnel;
  series: MoneySeriesPoint[];
  creditsByOperation: NamedTotal[];
  spendByProvider: NamedTotal[];
  projectsByStatus: NamedTotal[];
  jobsByType: NamedTotal[];
};

export function resolveWindow(days: number): AdminWindow {
  const safeDays = Math.max(1, Math.min(365, Math.round(days)));
  const until = new Date();
  const since = new Date(until.getTime() - safeDays * 24 * 60 * 60 * 1000);
  return { days: safeDays, since, until };
}

export async function loadAdminOverview(window: AdminWindow): Promise<AdminOverview> {
  const inWindow = { gte: window.since, lte: window.until };
  // Read once, shared by the totals and the daily series so the two cannot disagree.
  const [payments, valued] = await Promise.all([
    loadWindowPayments(window).then(summarizePayments),
    loadValuedSpends({ kind: "window", since: window.since, until: window.until })
  ]);

  const [money, people, work, sharing, series, creditsByOperation, spendByProvider, projectsByStatus, jobsByType] =
    await Promise.all([
      loadMoney(window, payments, valued),
      loadPeople(window),
      loadWork(window),
      loadShareFunnel(window),
      loadSeries(window, payments, valued),
      loadCreditsByOperation(inWindow),
      loadSpendByProvider(inWindow),
      loadProjectsByStatus(),
      loadJobsByType(inWindow)
    ]);

  return {
    window: { days: window.days, since: window.since.toISOString(), until: window.until.toISOString() },
    valuation: creditValuationSummary(),
    money,
    revenueByCurrency: payments.byCurrency,
    people,
    work,
    sharing,
    series,
    creditsByOperation,
    spendByProvider,
    projectsByStatus,
    jobsByType
  };
}

async function loadMoney(window: AdminWindow, cash: CashSummary, valued: readonly ValuedSpend[]): Promise<AdminOverview["money"]> {
  const inWindow = { gte: window.since, lte: window.until };
  const [provider, unpriced, delivered, refunded, accounts, outstandingPaid] = await Promise.all([
    prisma.providerCallLog.aggregate({
      _sum: { costHint: true },
      where: { costHint: { not: null }, createdAt: inWindow }
    }),
    prisma.providerCallLog.count({ where: { costHint: null, createdAt: inWindow } }),
    prisma.creditLedgerEntry.aggregate({
      _sum: { amountCredits: true },
      where: { ...SETTLED_CHARGE, createdAt: inWindow }
    }),
    prisma.creditLedgerEntry.aggregate({
      _sum: { amountCredits: true },
      where: {
        ...SETTLED_REFUND,
        reversesEntry: { is: { ...SETTLED_CHARGE, createdAt: inWindow } }
      }
    }),
    prisma.userCreditAccount.aggregate({ _sum: { availableCredits: true, reservedCredits: true } }),
    loadOutstandingPaidCredits()
  ]);

  const providerSpendUsd = round2(provider._sum.costHint ?? 0);
  const creditsRefunded = Math.max(refunded._sum.amountCredits ?? 0, 0);
  const creditsDelivered = netSettledCredits(delivered._sum.amountCredits ?? 0, refunded._sum.amountCredits ?? 0);
  // Only paying readers' charges come back valued; everyone else's are worth $0.
  const creditsDeliveredUsd = round2(valued.reduce((sum, spend) => sum + spend.usd, 0));
  // Charges from this window that a refund has since reversed. Their provider
  // calls are still real spend, which is why the unit margin below reads them
  // as cost with no revenue behind them rather than netting both away.
  const creditsRefundedUsd = round2(valued.reduce((sum, spend) => sum + spend.refundedUsd, 0));
  const creditsOutstanding = (accounts._sum.availableCredits ?? 0) + (accounts._sum.reservedCredits ?? 0);

  return {
    cashCollectedUsd: cash.collectedUsd,
    playFeeUsd: cash.feeUsd,
    cashNetUsd: cash.netUsd,
    providerSpendUsd,
    cashMarginUsd: round2(cash.netUsd - providerSpendUsd),
    cashMarginPercent: percentOf(cash.netUsd - providerSpendUsd, cash.netUsd),
    creditsDelivered,
    creditsDeliveredUsd,
    paidCreditsDelivered: Math.round(valued.reduce((sum, spend) => sum + spend.paidCredits, 0)),
    creditsRefunded,
    creditsRefundedUsd,
    unitMarginUsd: round2(creditsDeliveredUsd - providerSpendUsd),
    unitMarginPercent: percentOf(creditsDeliveredUsd - providerSpendUsd, creditsDeliveredUsd),
    creditsOutstanding,
    paidCreditsOutstanding: outstandingPaid.credits,
    creditsOutstandingUsd: round2(outstandingPaid.usd),
    unpricedCalls: unpriced
  };
}

async function loadPeople(window: AdminWindow): Promise<AdminOverview["people"]> {
  const inWindow = { gte: window.since, lte: window.until };
  const [totalUsers, newUsers, disabledUsers, activeSubscriptions, activeUserGroups, payingUserGroups] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: inWindow } }),
      prisma.user.count({ where: { status: "DISABLED" } }),
      prisma.subscriptionState.count({ where: { status: { in: ["ACTIVE", "GRACE_PERIOD"] } } }),
      // "Active" = spent credits in the window. Cheaper and more meaningful than
      // a session table scan: it counts people who did something worth charging.
      prisma.creditLedgerEntry.groupBy({
        by: ["userId"],
        where: { entryType: "SPEND", createdAt: inWindow }
      }),
      prisma.purchasePayment.groupBy({
        by: ["userId"],
        where: { amountMicros: { gt: 0 } }
      })
    ]);

  return {
    totalUsers,
    newUsers,
    activeUsers: activeUserGroups.length,
    disabledUsers,
    activeSubscriptions,
    payingUsers: payingUserGroups.length
  };
}

async function loadWork(window: AdminWindow): Promise<AdminOverview["work"]> {
  const inWindow = { gte: window.since, lte: window.until };
  const [projectsCreated, projectsCompleted, projectsFailed, booksInFlight, jobsRun, jobsFailed, voice, pendingReports] =
    await Promise.all([
      prisma.project.count({ where: { createdAt: inWindow } }),
      prisma.project.count({ where: { status: "COMPLETE", updatedAt: inWindow } }),
      prisma.project.count({ where: { status: "FAILED", updatedAt: inWindow } }),
      prisma.project.count({ where: { status: { in: ["PLANNING", "GENERATING", "EDITING"] } } }),
      prisma.generationJob.count({ where: { createdAt: inWindow } }),
      prisma.generationJob.count({ where: { status: "FAILED", createdAt: inWindow } }),
      prisma.voiceCall.aggregate({ _count: { _all: true }, _sum: { elapsedSeconds: true }, where: { startedAt: inWindow } }),
      prisma.moderationReport.count({ where: { status: "PENDING" } })
    ]);

  return {
    projectsCreated,
    projectsCompleted,
    projectsFailed,
    booksInFlight,
    jobsRun,
    jobsFailed,
    jobFailureRate: jobsRun > 0 ? round2((jobsFailed / jobsRun) * 100) : null,
    voiceCalls: voice._count._all,
    voiceMinutes: Math.round((voice._sum.elapsedSeconds ?? 0) / 60),
    pendingModerationReports: pendingReports
  };
}

type SeriesRow = {
  day: Date;
  provider_usd: number | null;
  new_users: bigint | null;
  books_completed: bigint | null;
};

/**
 * One row per day in the window, zero-filled.
 *
 * A `generate_series` left-joined against each source keeps quiet days present
 * as zeroes — a line chart that silently skips them reads as if nothing
 * happened *and* compresses the time axis, which is the more misleading of the
 * two failures.
 *
 * Cash and delivered value are bucketed here from the rows the totals were
 * computed from, by UTC day — the same days the series is keyed by — so a
 * chart and its headline can never disagree. A charge's delivered value stays
 * on the day it was made, a partial refund leaving the kept part there.
 */
async function loadSeries(window: AdminWindow, cash: CashSummary, valued: readonly ValuedSpend[]): Promise<MoneySeriesPoint[]> {
  const rows = await prisma.$queryRaw<SeriesRow[]>`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', ${window.since}::timestamptz),
        date_trunc('day', ${window.until}::timestamptz),
        '1 day'
      ) AS day
    )
    SELECT
      days.day,
      -- Bounded by the series' own days so each lookup can ride the createdAt index.
      (SELECT SUM(l."costHint") FROM "ProviderCallLog" l
        WHERE l."costHint" IS NOT NULL
          AND l."createdAt" >= days.day AND l."createdAt" < days.day + interval '1 day') AS provider_usd,
      (SELECT COUNT(*) FROM "User" u WHERE date_trunc('day', u."createdAt") = days.day) AS new_users,
      (SELECT COUNT(*) FROM "Project" pr
        WHERE pr.status = 'COMPLETE' AND date_trunc('day', pr."updatedAt") = days.day) AS books_completed
    FROM days
    ORDER BY days.day ASC
  `;

  const deliveredByDay = new Map<string, number>();
  for (const spend of valued) {
    const key = spend.createdAt.toISOString().slice(0, 10);
    deliveredByDay.set(key, (deliveredByDay.get(key) ?? 0) + spend.usd);
  }

  return rows.map((row) => {
    const date = row.day.toISOString().slice(0, 10);
    const day = cash.byDay.get(date);
    return {
      date,
      cashUsd: day?.collectedUsd ?? 0,
      cashNetUsd: day?.netUsd ?? 0,
      providerUsd: round2(row.provider_usd ?? 0),
      creditsDeliveredUsd: round2(deliveredByDay.get(date) ?? 0),
      newUsers: Number(row.new_users ?? 0n),
      booksCompleted: Number(row.books_completed ?? 0n)
    };
  });
}

async function loadCreditsByOperation(inWindow: Prisma.DateTimeFilter): Promise<NamedTotal[]> {
  const [charges, refunds] = await Promise.all([
    prisma.creditLedgerEntry.groupBy({
      by: ["operation"],
      _sum: { amountCredits: true },
      _count: { _all: true },
      where: { ...SETTLED_CHARGE, createdAt: inWindow }
    }),
    prisma.creditLedgerEntry.groupBy({
      by: ["operation"],
      _sum: { amountCredits: true },
      where: { ...SETTLED_REFUND, reversesEntry: { is: { ...SETTLED_CHARGE, createdAt: inWindow } } }
    })
  ]);
  return charges
    .map((group) => {
      const refunded = refunds.find((entry) => entry.operation === group.operation)?._sum.amountCredits ?? 0;
      return {
        key: group.operation,
        label: titleCase(group.operation),
        value: netSettledCredits(group._sum.amountCredits ?? 0, refunded),
        secondary: group._count._all
      };
    })
    .filter((entry) => entry.value > 0)
    .sort((left, right) => right.value - left.value);
}

async function loadSpendByProvider(inWindow: Prisma.DateTimeFilter): Promise<NamedTotal[]> {
  const groups = await prisma.providerCallLog.groupBy({
    by: ["provider"],
    _sum: { costHint: true },
    _count: { _all: true },
    where: { costHint: { not: null }, createdAt: inWindow }
  });
  return groups
    .map((group) => ({
      key: group.provider,
      label: group.provider,
      value: round2(group._sum.costHint ?? 0),
      secondary: group._count._all
    }))
    .filter((entry) => entry.value > 0)
    .sort((left, right) => right.value - left.value);
}

async function loadProjectsByStatus(): Promise<NamedTotal[]> {
  const groups = await prisma.project.groupBy({ by: ["status"], _count: { _all: true } });
  return groups
    .map((group) => ({ key: group.status, label: titleCase(group.status), value: group._count._all }))
    .sort((left, right) => right.value - left.value);
}

async function loadJobsByType(inWindow: Prisma.DateTimeFilter): Promise<NamedTotal[]> {
  const groups = await prisma.generationJob.groupBy({
    by: ["type", "status"],
    _count: { _all: true },
    where: { createdAt: inWindow }
  });
  const byType = new Map<string, { total: number; failed: number }>();
  for (const group of groups) {
    const entry = byType.get(group.type) ?? { total: 0, failed: 0 };
    entry.total += group._count._all;
    if (group.status === "FAILED") {
      entry.failed += group._count._all;
    }
    byType.set(group.type, entry);
  }
  return [...byType.entries()]
    .map(([type, counts]) => ({ key: type, label: titleCase(type), value: counts.total, secondary: counts.failed }))
    .sort((left, right) => right.value - left.value);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function percentOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}
