/**
 * Drill-in queries behind the dashboard's inspector.
 *
 * The list view deliberately rolls up in the database rather than fetching
 * `include`-d relations per user: a hundred readers with a few hundred ledger
 * entries each is a lot of rows to move in order to display six numbers. The
 * detail view is the opposite — one reader, so it can afford to be generous.
 */

import { CREDIT_USD_VALUE } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { round2, titleCase } from "./metrics.js";

export type AdminUserRow = {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  createdAt: string;
  availableCredits: number;
  reservedCredits: number;
  lifetimeGranted: number;
  lifetimeSpent: number;
  projects: number;
  booksCompleted: number;
  cashUsd: number;
  subscriptionStatus: string | null;
  lastActivityAt: string | null;
};

export type AdminUserListResult = {
  users: AdminUserRow[];
  total: number;
  limit: number;
  offset: number;
};

export type AdminUserSort = "recent" | "spend" | "cash" | "credits" | "projects";

type UserRollupRow = {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  createdAt: Date;
  availableCredits: bigint | null;
  reservedCredits: bigint | null;
  lifetimeGranted: bigint | null;
  lifetimeSpent: bigint | null;
  projects: bigint | null;
  books_completed: bigint | null;
  cash_micros: bigint | null;
  subscription_status: string | null;
  last_activity: Date | null;
  total: bigint;
};

const USER_SORT_SQL: Record<AdminUserSort, string> = {
  recent: 'u."createdAt" DESC',
  spend: 'COALESCE(a."lifetimeCreditsSpent", 0) DESC',
  cash: "cash_micros DESC NULLS LAST",
  credits: 'COALESCE(a."availableCredits", 0) DESC',
  projects: "projects DESC"
};

/**
 * One query, one pass.
 *
 * The `COUNT(*) OVER ()` window rides along with the page so the total and the
 * rows can never disagree about which users matched — a separate count query
 * can race a signup between the two.
 */
export async function listAdminUsers(options: {
  query?: string | undefined;
  sort?: AdminUserSort | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}): Promise<AdminUserListResult> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);
  const search = options.query?.trim() ? `%${options.query.trim()}%` : null;
  const orderBy = USER_SORT_SQL[options.sort ?? "recent"];

  const rows = await prisma.$queryRawUnsafe<UserRollupRow[]>(
    `
    SELECT
      u.id, u.email, u."displayName", u.status::text AS status, u."createdAt",
      COALESCE(a."availableCredits", 0) AS "availableCredits",
      COALESCE(a."reservedCredits", 0) AS "reservedCredits",
      COALESCE(a."lifetimeCreditsGranted", 0) AS "lifetimeGranted",
      COALESCE(a."lifetimeCreditsSpent", 0) AS "lifetimeSpent",
      (SELECT COUNT(*) FROM "Project" p WHERE p."userId" = u.id) AS projects,
      (SELECT COUNT(*) FROM "Project" p WHERE p."userId" = u.id AND p.status = 'COMPLETE') AS books_completed,
      (SELECT SUM(pr."amountMicros") FROM "PurchaseRecord" pr
        WHERE pr."userId" = u.id AND pr.status IN ('VERIFIED','GRANTED')) AS cash_micros,
      (SELECT s.status::text FROM "SubscriptionState" s
        WHERE s."userId" = u.id ORDER BY s."updatedAt" DESC LIMIT 1) AS subscription_status,
      (SELECT MAX(e."createdAt") FROM "CreditLedgerEntry" e WHERE e."userId" = u.id) AS last_activity,
      COUNT(*) OVER () AS total
    FROM "User" u
    LEFT JOIN "UserCreditAccount" a ON a."userId" = u.id
    WHERE ($1::text IS NULL OR u.email ILIKE $1 OR COALESCE(u."displayName", '') ILIKE $1)
    ORDER BY ${orderBy}
    LIMIT $2 OFFSET $3
  `,
    search,
    limit,
    offset
  );

  return {
    users: rows.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      availableCredits: Number(row.availableCredits ?? 0),
      reservedCredits: Number(row.reservedCredits ?? 0),
      lifetimeGranted: Number(row.lifetimeGranted ?? 0),
      lifetimeSpent: Number(row.lifetimeSpent ?? 0),
      projects: Number(row.projects ?? 0),
      booksCompleted: Number(row.books_completed ?? 0),
      cashUsd: round2(Number(row.cash_micros ?? 0n) / 1_000_000),
      subscriptionStatus: row.subscription_status,
      lastActivityAt: row.last_activity?.toISOString() ?? null
    })),
    total: Number(rows[0]?.total ?? 0n),
    limit,
    offset
  };
}

export type AdminUserDetail = {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    status: string;
    createdAt: string;
    disabledAt: string | null;
  };
  credits: { available: number; reserved: number; lifetimeGranted: number; lifetimeSpent: number };
  spendByOperation: Array<{ key: string; label: string; value: number }>;
  purchases: Array<{
    id: string;
    status: string;
    provider: string;
    creditsGranted: number;
    amountUsd: number | null;
    purchasedAt: string | null;
  }>;
  subscriptions: Array<{
    id: string;
    status: string;
    creditsPerPeriod: number;
    currentPeriodEnd: string | null;
    canceledAt: string | null;
  }>;
  ledger: Array<{
    id: string;
    operation: string;
    entryType: string;
    status: string;
    amountCredits: number;
    projectId: string | null;
    pricingVersion: number | null;
    description: string | null;
    createdAt: string;
  }>;
  projects: Array<{
    id: string;
    title: string;
    status: string;
    targetPages: number;
    pages: number;
    createdAt: string;
    providerUsd: number;
    creditsCharged: number;
  }>;
  deletionRequests: Array<{ id: string; status: string; requestedAt: string }>;
};

export async function loadAdminUserDetail(userId: string): Promise<AdminUserDetail | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, status: true, createdAt: true, disabledAt: true }
  });
  if (!user) {
    return null;
  }

  const [account, spendGroups, purchases, subscriptions, ledger, projects, deletionRequests] = await Promise.all([
    prisma.userCreditAccount.findUnique({ where: { userId } }),
    prisma.creditLedgerEntry.groupBy({
      by: ["operation"],
      _sum: { amountCredits: true },
      where: { userId, entryType: "SPEND", status: "SETTLED" }
    }),
    prisma.purchaseRecord.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, status: true, provider: true, creditsGranted: true, amountMicros: true, purchasedAt: true }
    }),
    prisma.subscriptionState.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { id: true, status: true, creditsPerPeriod: true, currentPeriodEnd: true, canceledAt: true }
    }),
    prisma.creditLedgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        operation: true,
        entryType: true,
        status: true,
        amountCredits: true,
        projectId: true,
        description: true,
        metadata: true,
        createdAt: true
      }
    }),
    prisma.project.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        title: true,
        status: true,
        targetPages: true,
        createdAt: true,
        _count: { select: { pages: true } }
      }
    }),
    prisma.accountDeletionRequest.findMany({
      where: { userId },
      orderBy: { requestedAt: "desc" },
      take: 5,
      select: { id: true, status: true, requestedAt: true }
    })
  ]);

  const projectIds = projects.map((project) => project.id);
  const [providerCosts, creditCosts] = await Promise.all([
    projectIds.length
      ? prisma.providerCallLog.groupBy({
          by: ["projectId"],
          _sum: { costHint: true },
          where: { projectId: { in: projectIds }, costHint: { not: null } }
        })
      : Promise.resolve([]),
    projectIds.length
      ? prisma.creditLedgerEntry.groupBy({
          by: ["projectId"],
          _sum: { amountCredits: true },
          where: { projectId: { in: projectIds }, entryType: "SPEND", status: "SETTLED" }
        })
      : Promise.resolve([])
  ]);
  const providerByProject = new Map(providerCosts.map((row) => [row.projectId, row._sum.costHint ?? 0]));
  const creditsByProject = new Map(creditCosts.map((row) => [row.projectId, Math.abs(row._sum.amountCredits ?? 0)]));

  return {
    user: {
      ...user,
      createdAt: user.createdAt.toISOString(),
      disabledAt: user.disabledAt?.toISOString() ?? null
    },
    credits: {
      available: account?.availableCredits ?? 0,
      reserved: account?.reservedCredits ?? 0,
      lifetimeGranted: account?.lifetimeCreditsGranted ?? 0,
      lifetimeSpent: account?.lifetimeCreditsSpent ?? 0
    },
    spendByOperation: spendGroups
      .map((group) => ({
        key: group.operation,
        label: titleCase(group.operation),
        value: Math.abs(group._sum.amountCredits ?? 0)
      }))
      .filter((entry) => entry.value > 0)
      .sort((left, right) => right.value - left.value),
    purchases: purchases.map((purchase) => ({
      id: purchase.id,
      status: purchase.status,
      provider: purchase.provider,
      creditsGranted: purchase.creditsGranted,
      amountUsd: purchase.amountMicros === null ? null : round2(Number(purchase.amountMicros) / 1_000_000),
      purchasedAt: purchase.purchasedAt?.toISOString() ?? null
    })),
    subscriptions: subscriptions.map((subscription) => ({
      id: subscription.id,
      status: subscription.status,
      creditsPerPeriod: subscription.creditsPerPeriod,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      canceledAt: subscription.canceledAt?.toISOString() ?? null
    })),
    ledger: ledger.map((entry) => ({
      id: entry.id,
      operation: entry.operation,
      entryType: entry.entryType,
      status: entry.status,
      amountCredits: entry.amountCredits,
      projectId: entry.projectId,
      pricingVersion: pricingVersionFrom(entry.metadata),
      description: entry.description,
      createdAt: entry.createdAt.toISOString()
    })),
    projects: projects.map((project) => ({
      id: project.id,
      title: project.title,
      status: project.status,
      targetPages: project.targetPages,
      pages: project._count.pages,
      createdAt: project.createdAt.toISOString(),
      providerUsd: round2(providerByProject.get(project.id) ?? 0),
      creditsCharged: creditsByProject.get(project.id) ?? 0
    })),
    deletionRequests: deletionRequests.map((request) => ({
      id: request.id,
      status: request.status,
      requestedAt: request.requestedAt.toISOString()
    }))
  };
}

export type AdminProjectDetail = {
  project: {
    id: string;
    title: string;
    status: string;
    category: string;
    language: string;
    targetPages: number;
    pages: number;
    images: number;
    createdAt: string;
    updatedAt: string;
  };
  owner: { id: string; email: string } | null;
  economics: {
    creditsCharged: number;
    revenueUsd: number;
    providerUsd: number;
    marginUsd: number;
    marginPercent: number | null;
    unpricedCalls: number;
  };
  spendByPurpose: Array<{ key: string; label: string; value: number; secondary?: number }>;
  jobs: Array<{
    id: string;
    type: string;
    status: string;
    progress: number;
    durationMs: number | null;
    error: string | null;
    createdAt: string;
  }>;
  ledger: Array<{
    id: string;
    operation: string;
    entryType: string;
    status: string;
    amountCredits: number;
    pricingVersion: number | null;
    createdAt: string;
  }>;
};

export async function loadAdminProjectDetail(projectId: string): Promise<AdminProjectDetail | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      title: true,
      status: true,
      category: true,
      language: true,
      targetPages: true,
      createdAt: true,
      updatedAt: true,
      user: { select: { id: true, email: true } },
      _count: { select: { pages: true, images: true } }
    }
  });
  if (!project) {
    return null;
  }

  const [providerTotal, unpricedCalls, byPurpose, jobs, ledger, creditTotal] = await Promise.all([
    prisma.providerCallLog.aggregate({ _sum: { costHint: true }, where: { projectId, costHint: { not: null } } }),
    prisma.providerCallLog.count({ where: { projectId, costHint: null } }),
    prisma.providerCallLog.groupBy({
      by: ["purpose"],
      _sum: { costHint: true },
      _count: { _all: true },
      where: { projectId, costHint: { not: null } }
    }),
    prisma.generationJob.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        type: true,
        status: true,
        progress: true,
        error: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true
      }
    }),
    prisma.creditLedgerEntry.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        operation: true,
        entryType: true,
        status: true,
        amountCredits: true,
        metadata: true,
        createdAt: true
      }
    }),
    prisma.creditLedgerEntry.aggregate({
      _sum: { amountCredits: true },
      where: { projectId, entryType: "SPEND", status: "SETTLED" }
    })
  ]);

  const creditsCharged = Math.abs(creditTotal._sum.amountCredits ?? 0);
  const revenueUsd = round2(creditsCharged * CREDIT_USD_VALUE);
  const providerUsd = round2(providerTotal._sum.costHint ?? 0);

  return {
    project: {
      id: project.id,
      title: project.title,
      status: project.status,
      category: project.category,
      language: project.language,
      targetPages: project.targetPages,
      pages: project._count.pages,
      images: project._count.images,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString()
    },
    owner: project.user,
    economics: {
      creditsCharged,
      revenueUsd,
      providerUsd,
      marginUsd: round2(revenueUsd - providerUsd),
      marginPercent: revenueUsd > 0 ? Math.round(((revenueUsd - providerUsd) / revenueUsd) * 1000) / 10 : null,
      unpricedCalls
    },
    spendByPurpose: byPurpose
      .map((group) => ({
        // Left verbatim: `purpose` is the string the run logs under
        // <BOOK_STORAGE_DIR>/<projectId>/runs/ are keyed by, and prettifying
        // "book.finalQa.chapterTransitions" makes it ungreppable.
        key: group.purpose,
        label: group.purpose,
        value: round2(group._sum.costHint ?? 0),
        secondary: group._count._all
      }))
      .filter((entry) => entry.value > 0)
      .sort((left, right) => right.value - left.value),
    jobs: jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      durationMs:
        job.startedAt && job.finishedAt ? job.finishedAt.getTime() - job.startedAt.getTime() : null,
      error: job.error,
      createdAt: job.createdAt.toISOString()
    })),
    ledger: ledger.map((entry) => ({
      id: entry.id,
      operation: entry.operation,
      entryType: entry.entryType,
      status: entry.status,
      amountCredits: entry.amountCredits,
      pricingVersion: pricingVersionFrom(entry.metadata),
      createdAt: entry.createdAt.toISOString()
    }))
  };
}

/** Written onto every ledger entry by `packages/db/src/billing.ts`. */
function pricingVersionFrom(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).pricingVersion;
  return typeof value === "number" ? value : null;
}
