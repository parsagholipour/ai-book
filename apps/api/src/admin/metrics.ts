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
 * collected (`PurchaseRecord.amountMicros`) is money in the bank during the
 * window. Credits delivered is the notional value of work done in the window,
 * which is what actually pairs against provider spend for unit economics.
 * They diverge because a reader buys credits on one day and spends them on
 * another; reporting either alone would misstate a margin.
 *
 * **A refunded charge is still a `SPEND`/`SETTLED` row.** Its linked positive
 * reversal is cumulative and may be smaller than the charge, so every revenue
 * figure is gross spend minus the actual reversal amount. Presence alone is
 * not a whole-refund predicate.
 */

import { CREDIT_USD_VALUE } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";

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
  cashUsd: number;
  providerUsd: number;
  creditsDeliveredUsd: number;
  newUsers: number;
  booksCompleted: number;
};

export type NamedTotal = { key: string; label: string; value: number; secondary?: number };

export type AdminOverview = {
  window: { days: number; since: string; until: string };
  creditUsdValue: number;
  money: {
    cashCollectedUsd: number;
    providerSpendUsd: number;
    cashMarginUsd: number;
    cashMarginPercent: number | null;
    creditsDelivered: number;
    creditsDeliveredUsd: number;
    /** Charges made in the window that were later given back. Not in the above. */
    creditsRefunded: number;
    creditsRefundedUsd: number;
    unitMarginUsd: number;
    unitMarginPercent: number | null;
    /** Credits bought but not yet spent — an obligation, not income. */
    creditsOutstanding: number;
    creditsOutstandingUsd: number;
    unpricedCalls: number;
  };
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

  const [money, people, work, series, creditsByOperation, spendByProvider, projectsByStatus, jobsByType] =
    await Promise.all([
      loadMoney(window),
      loadPeople(window),
      loadWork(window),
      loadSeries(window),
      loadCreditsByOperation(inWindow),
      loadSpendByProvider(inWindow),
      loadProjectsByStatus(),
      loadJobsByType(inWindow)
    ]);

  return {
    window: { days: window.days, since: window.since.toISOString(), until: window.until.toISOString() },
    creditUsdValue: CREDIT_USD_VALUE,
    money,
    people,
    work,
    series,
    creditsByOperation,
    spendByProvider,
    projectsByStatus,
    jobsByType
  };
}

async function loadMoney(window: AdminWindow): Promise<AdminOverview["money"]> {
  const inWindow = { gte: window.since, lte: window.until };
  const [cash, provider, unpriced, delivered, refunded, accounts] = await Promise.all([
    prisma.purchaseRecord.aggregate({
      _sum: { amountMicros: true },
      where: { status: { in: ["VERIFIED", "GRANTED"] }, createdAt: inWindow }
    }),
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
    prisma.userCreditAccount.aggregate({ _sum: { availableCredits: true, reservedCredits: true } })
  ]);

  const cashCollectedUsd = round2(Number(cash._sum.amountMicros ?? 0n) / 1_000_000);
  const providerSpendUsd = round2(provider._sum.costHint ?? 0);
  const creditsRefunded = Math.max(refunded._sum.amountCredits ?? 0, 0);
  const creditsDelivered = netSettledCredits(delivered._sum.amountCredits ?? 0, refunded._sum.amountCredits ?? 0);
  const creditsDeliveredUsd = round2(creditsDelivered * CREDIT_USD_VALUE);
  // Charges from this window that a refund has since reversed. Their provider
  // calls are still real spend, which is why the unit margin below reads them
  // as cost with no revenue behind them rather than netting both away.
  const creditsOutstanding = (accounts._sum.availableCredits ?? 0) + (accounts._sum.reservedCredits ?? 0);

  return {
    cashCollectedUsd,
    providerSpendUsd,
    cashMarginUsd: round2(cashCollectedUsd - providerSpendUsd),
    cashMarginPercent: percentOf(cashCollectedUsd - providerSpendUsd, cashCollectedUsd),
    creditsDelivered,
    creditsDeliveredUsd,
    creditsRefunded,
    creditsRefundedUsd: round2(creditsRefunded * CREDIT_USD_VALUE),
    unitMarginUsd: round2(creditsDeliveredUsd - providerSpendUsd),
    unitMarginPercent: percentOf(creditsDeliveredUsd - providerSpendUsd, creditsDeliveredUsd),
    creditsOutstanding,
    creditsOutstandingUsd: round2(creditsOutstanding * CREDIT_USD_VALUE),
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
      prisma.purchaseRecord.groupBy({
        by: ["userId"],
        where: { status: { in: ["VERIFIED", "GRANTED"] } }
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
  cash_micros: bigint | null;
  provider_usd: number | null;
  credits_spent: bigint | null;
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
 */
async function loadSeries(window: AdminWindow): Promise<MoneySeriesPoint[]> {
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
      (SELECT SUM(p."amountMicros") FROM "PurchaseRecord" p
        WHERE p.status IN ('VERIFIED','GRANTED') AND date_trunc('day', p."createdAt") = days.day) AS cash_micros,
      (SELECT SUM(l."costHint") FROM "ProviderCallLog" l
        WHERE l."costHint" IS NOT NULL AND date_trunc('day', l."createdAt") = days.day) AS provider_usd,
      -- Same rule as netSettledCredits: original charge less its cumulative reversal.
      -- A partial refund therefore leaves the delivered portion on the original day.
      (SELECT SUM(GREATEST(ABS(e."amountCredits") - COALESCE(r."amountCredits", 0), 0))
        FROM "CreditLedgerEntry" e
        LEFT JOIN "CreditLedgerEntry" r
          ON r."reversesEntryId" = e.id AND r."entryType" = 'REFUND' AND r.status = 'SETTLED'
        WHERE e."entryType" = 'SPEND' AND e.status = 'SETTLED'
          AND date_trunc('day', e."createdAt") = days.day) AS credits_spent,
      (SELECT COUNT(*) FROM "User" u WHERE date_trunc('day', u."createdAt") = days.day) AS new_users,
      (SELECT COUNT(*) FROM "Project" pr
        WHERE pr.status = 'COMPLETE' AND date_trunc('day', pr."updatedAt") = days.day) AS books_completed
    FROM days
    ORDER BY days.day ASC
  `;

  return rows.map((row) => {
    const credits = Number(row.credits_spent ?? 0n);
    return {
      date: row.day.toISOString().slice(0, 10),
      cashUsd: round2(Number(row.cash_micros ?? 0n) / 1_000_000),
      providerUsd: round2(row.provider_usd ?? 0),
      creditsDeliveredUsd: round2(credits * CREDIT_USD_VALUE),
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
