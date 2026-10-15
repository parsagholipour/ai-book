import { prisma } from "@book-maker/db";
import { PAYWALL_TRIGGERS } from "../productEventNames.js";
import { DEFAULT_LOCAL_ADMIN_USER_ID } from "../requestAuth.js";
import { loadCheckoutFunnel, loadInstallSources, type CheckoutFunnel, type InstallSource } from "./growthAcquisition.js";
import {
  loadChurn,
  loadGrowthPayments,
  loadIntroConversion,
  summarizeRevenueByCountry,
  summarizeSkuCash,
  type ChurnMonth,
  type CountryRevenue,
  type IntroConversion,
  type SkuCash
} from "./growthMonetization.js";
import type { AdminWindow } from "./metrics.js";

/**
 * The growth funnel on the Overview: what happened to the readers who signed up
 * in the window, how long their first book took, which paywalls were shown and
 * whether the people shown them paid, whether they came back, and what they cost.
 *
 * Almost all of it is read from the tables the product already writes — a plan
 * is a succeeded `PLAN_GENERATION` attempt, a delivered book a succeeded
 * `FULL_BOOK_GENERATION` attempt (`exportPublication.ts` marks it at
 * publication), a payment a `PurchasePayment` row — so it is true of every
 * reader since launch, not only of those signed up after the funnel shipped.
 * Two things only exist because of it: `ProductEvent` (what only the app sees:
 * a paywall it showed, a checkout started, cancelled or failed, the Play
 * install referrer) and `UserActiveDay` (a day a reader used the app). Both
 * start counting the day they were deployed, so figures for earlier cohorts
 * read low rather than wrong. The money half — cash net of Google's fee per
 * product and per signup country, intro conversion and churn — is
 * `growthMonetization.ts`; installs and checkouts are `growthAcquisition.ts`.
 *
 * The operator console's own user (`local-admin`) is never a reader and is left
 * out. Cohort figures follow the readers who signed up in the window to now;
 * paywall, purchase and cost figures are activity inside the window.
 */
export type ProductFunnel = {
  cohort: {
    signups: number;
    welcome: Record<"GRANTED" | "RECENT_IP" | "NO_IP" | "DISABLED" | "PENDING", number>;
    startedChat: number;
    builtPlan: number;
    startedBook: number;
    deliveredBook: number;
    secondBook: number;
    paid: number;
  };
  /** Signup to first delivered book, over cohort readers who have one. */
  timeToFirstBook: { samples: number; medianMinutes: number | null; p90Minutes: number | null };
  paywall: Array<{ trigger: string; views: number; viewers: number; paidWithin7Days: number }>;
  purchasesBySku: SkuCash[];
  checkout: CheckoutFunnel;
  introConversion: IntroConversion[];
  churn: ChurnMonth[];
  revenueByCountry: CountryRevenue[];
  installSources: InstallSource[];
  /**
   * Rolling retention: of the cohort readers whose signup is at least N days
   * old, how many used the app on day N or any day after.
   */
  retention: Array<{ day: 1 | 7 | 30; eligible: number; retained: number }>;
  cost: {
    /** Provider spend to date on books owned by cohort readers, per signup. */
    perSignupUsd: number | null;
    /** Window spend on active readers' books, per reader active in the window. */
    perActiveUserUsd: number | null;
    activeUsers: number;
    /** Window spend with no book to charge it to (creation chats, voice prep). */
    unattributedUsd: number;
    /** Books delivered in the window, by tier: their whole provider bill to date. */
    perDeliveredBook: Array<{ tier: string; books: number; avgUsd: number }>;
  };
};

type CohortRow = {
  signups: bigint;
  started_chat: bigint;
  built_plan: bigint;
  started_book: bigint;
  delivered_book: bigint;
  second_book: bigint;
  paid: bigint;
};

export async function loadProductFunnel(window: AdminWindow): Promise<ProductFunnel> {
  const [cohort, welcome, firstBook, paywall, payments, retention, cost, checkout, introConversion, churn, installSources] =
    await Promise.all([
      loadCohort(window),
      loadWelcomeOutcomes(window),
      loadTimeToFirstBook(window),
      loadPaywall(window),
      loadGrowthPayments(window),
      loadRetention(window),
      loadCost(window),
      loadCheckoutFunnel(window),
      loadIntroConversion(window),
      loadChurn(window),
      loadInstallSources(window)
    ]);
  return {
    cohort: { ...cohort, welcome },
    timeToFirstBook: firstBook,
    paywall,
    purchasesBySku: summarizeSkuCash(payments),
    checkout,
    introConversion,
    churn,
    revenueByCountry: summarizeRevenueByCountry(payments),
    installSources,
    retention,
    cost
  };
}

async function loadCohort(window: AdminWindow): Promise<Omit<ProductFunnel["cohort"], "welcome">> {
  const rows = await prisma.$queryRaw<CohortRow[]>`
    WITH cohort AS (
      SELECT id FROM "User" WHERE "createdAt" >= ${window.since} AND "createdAt" <= ${window.until} AND id <> ${DEFAULT_LOCAL_ADMIN_USER_ID}
    ), books AS (
      SELECT a."userId", a."projectId", a.status
      FROM "GenerationAttempt" a JOIN cohort c ON c.id = a."userId"
      WHERE a.operation = 'FULL_BOOK_GENERATION'
    )
    SELECT
      (SELECT count(*) FROM cohort) AS signups,
      (SELECT count(DISTINCT d."userId") FROM "MobileCreationDraft" d JOIN cohort c ON c.id = d."userId") AS started_chat,
      (SELECT count(DISTINCT a."userId") FROM "GenerationAttempt" a JOIN cohort c ON c.id = a."userId"
        WHERE a.operation = 'PLAN_GENERATION' AND a.status = 'SUCCEEDED') AS built_plan,
      (SELECT count(DISTINCT "userId") FROM books) AS started_book,
      (SELECT count(DISTINCT "userId") FROM books WHERE status = 'SUCCEEDED') AS delivered_book,
      (SELECT count(*) FROM (
        SELECT "userId" FROM books GROUP BY "userId" HAVING count(DISTINCT "projectId") >= 2
      ) repeaters) AS second_book,
      (SELECT count(DISTINCT p."userId") FROM "PurchasePayment" p JOIN cohort c ON c.id = p."userId") AS paid
  `;
  const row = rows[0];
  return {
    signups: Number(row?.signups ?? 0),
    startedChat: Number(row?.started_chat ?? 0),
    builtPlan: Number(row?.built_plan ?? 0),
    startedBook: Number(row?.started_book ?? 0),
    deliveredBook: Number(row?.delivered_book ?? 0),
    secondBook: Number(row?.second_book ?? 0),
    paid: Number(row?.paid ?? 0)
  };
}

async function loadWelcomeOutcomes(window: AdminWindow): Promise<ProductFunnel["cohort"]["welcome"]> {
  const groups = await prisma.welcomeCreditGrant.groupBy({
    by: ["outcome"],
    where: { user: { createdAt: { gte: window.since, lte: window.until }, id: { not: DEFAULT_LOCAL_ADMIN_USER_ID } } },
    _count: { _all: true }
  });
  const count = (outcome: string) => groups.find((group) => group.outcome === outcome)?._count._all ?? 0;
  return {
    GRANTED: count("GRANTED"),
    RECENT_IP: count("RECENT_IP"),
    NO_IP: count("NO_IP"),
    DISABLED: count("DISABLED"),
    PENDING: count("PENDING")
  };
}

async function loadTimeToFirstBook(window: AdminWindow): Promise<ProductFunnel["timeToFirstBook"]> {
  const rows = await prisma.$queryRaw<Array<{ samples: bigint; median: number | null; p90: number | null }>>`
    WITH firsts AS (
      SELECT u.id, EXTRACT(EPOCH FROM (min(a."finishedAt") - u."createdAt")) / 60 AS minutes
      FROM "User" u
      JOIN "GenerationAttempt" a ON a."userId" = u.id
      WHERE u."createdAt" >= ${window.since} AND u."createdAt" <= ${window.until} AND u.id <> ${DEFAULT_LOCAL_ADMIN_USER_ID}
        AND a.operation = 'FULL_BOOK_GENERATION' AND a.status = 'SUCCEEDED' AND a."finishedAt" IS NOT NULL
      GROUP BY u.id, u."createdAt"
    )
    SELECT count(*) AS samples,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes) AS median,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY minutes) AS p90
    FROM firsts
  `;
  const row = rows[0];
  const round = (value: number | null | undefined) => (value === null || value === undefined ? null : Math.round(Number(value)));
  return { samples: Number(row?.samples ?? 0), medianMinutes: round(row?.median), p90Minutes: round(row?.p90) };
}

async function loadPaywall(window: AdminWindow): Promise<ProductFunnel["paywall"]> {
  const rows = await prisma.$queryRaw<Array<{ trigger: string | null; views: bigint; viewers: bigint; paid: bigint }>>`
    WITH views AS (
      SELECT e."userId", e.properties ->> 'trigger' AS trigger, min(e."createdAt") AS first_seen, count(*) AS n
      FROM "ProductEvent" e
      WHERE e.name = 'paywall_viewed' AND e."createdAt" >= ${window.since} AND e."createdAt" <= ${window.until}
      GROUP BY e."userId", e.properties ->> 'trigger'
    )
    SELECT v.trigger,
      sum(v.n) AS views,
      count(*) AS viewers,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM "PurchasePayment" p
        WHERE p."userId" = v."userId" AND p."paidAt" >= v.first_seen AND p."paidAt" <= v.first_seen + interval '7 days'
      )) AS paid
    FROM views v
    GROUP BY v.trigger
  `;
  const known = new Set<string>(PAYWALL_TRIGGERS);
  return rows
    .map((row) => ({
      trigger: row.trigger && known.has(row.trigger) ? row.trigger : "other",
      views: Number(row.views),
      viewers: Number(row.viewers),
      paidWithin7Days: Number(row.paid)
    }))
    .sort((left, right) => right.views - left.views);
}

async function loadRetention(window: AdminWindow): Promise<ProductFunnel["retention"]> {
  const rows = await prisma.$queryRaw<Array<{ day: number; eligible: bigint; retained: bigint }>>`
    WITH cohort AS (
      SELECT id, ("createdAt" AT TIME ZONE 'UTC')::date AS signup_day
      FROM "User"
      WHERE "createdAt" >= ${window.since} AND "createdAt" <= ${window.until} AND id <> ${DEFAULT_LOCAL_ADMIN_USER_ID}
    ), marks AS (SELECT unnest(ARRAY[1, 7, 30]) AS day)
    SELECT m.day,
      count(c.id) FILTER (WHERE c.signup_day + m.day <= (now() AT TIME ZONE 'UTC')::date) AS eligible,
      count(c.id) FILTER (WHERE c.signup_day + m.day <= (now() AT TIME ZONE 'UTC')::date AND EXISTS (
        SELECT 1 FROM "UserActiveDay" d WHERE d."userId" = c.id AND d.day >= c.signup_day + m.day
      )) AS retained
    FROM marks m CROSS JOIN cohort c
    GROUP BY m.day
    ORDER BY m.day
  `;
  const byDay = new Map(rows.map((row) => [Number(row.day), row]));
  return ([1, 7, 30] as const).map((day) => ({
    day,
    eligible: Number(byDay.get(day)?.eligible ?? 0),
    retained: Number(byDay.get(day)?.retained ?? 0)
  }));
}

async function loadCost(window: AdminWindow): Promise<ProductFunnel["cost"]> {
  const [perSignupRows, activeRows, unattributedRows, bookRows] = await Promise.all([
    prisma.$queryRaw<Array<{ signups: bigint; usd: number | null }>>`
      WITH cohort AS (
        SELECT id FROM "User" WHERE "createdAt" >= ${window.since} AND "createdAt" <= ${window.until} AND id <> ${DEFAULT_LOCAL_ADMIN_USER_ID}
      )
      SELECT (SELECT count(*) FROM cohort) AS signups,
        (SELECT sum(l."costHint") FROM "ProviderCallLog" l
          JOIN "Project" pr ON pr.id = l."projectId"
          JOIN cohort c ON c.id = pr."userId") AS usd
    `,
    prisma.$queryRaw<Array<{ active: bigint; usd: number | null }>>`
      WITH active AS (
        SELECT DISTINCT "userId" FROM "UserActiveDay"
        WHERE day >= (${window.since}::timestamptz AT TIME ZONE 'UTC')::date
          AND day <= (${window.until}::timestamptz AT TIME ZONE 'UTC')::date
      )
      SELECT (SELECT count(*) FROM active) AS active,
        (SELECT sum(l."costHint") FROM "ProviderCallLog" l
          JOIN "Project" pr ON pr.id = l."projectId"
          JOIN active a ON a."userId" = pr."userId"
          WHERE l."createdAt" >= ${window.since} AND l."createdAt" <= ${window.until}) AS usd
    `,
    prisma.$queryRaw<Array<{ usd: number | null }>>`
      SELECT sum("costHint") AS usd FROM "ProviderCallLog"
      WHERE "projectId" IS NULL AND "createdAt" >= ${window.since} AND "createdAt" <= ${window.until}
    `,
    prisma.$queryRaw<Array<{ tier: string | null; books: bigint; usd: number | null }>>`
      WITH delivered AS (
        SELECT DISTINCT a."projectId" FROM "GenerationAttempt" a
        WHERE a.operation = 'FULL_BOOK_GENERATION' AND a.status = 'SUCCEEDED' AND a."projectId" IS NOT NULL
          AND a."finishedAt" >= ${window.since} AND a."finishedAt" <= ${window.until}
      ), spend AS (
        SELECT d."projectId", coalesce(sum(l."costHint"), 0) AS usd
        FROM delivered d LEFT JOIN "ProviderCallLog" l ON l."projectId" = d."projectId"
        GROUP BY d."projectId"
      )
      SELECT coalesce(pr."mediaSettings" ->> 'modelTier', 'balanced') AS tier, count(*) AS books, sum(s.usd) AS usd
      FROM spend s JOIN "Project" pr ON pr.id = s."projectId"
      GROUP BY 1
      ORDER BY 2 DESC
    `
  ]);
  const signups = Number(perSignupRows[0]?.signups ?? 0);
  const active = Number(activeRows[0]?.active ?? 0);
  const per = (usd: number | null | undefined, count: number) =>
    count > 0 ? Math.round((Number(usd ?? 0) / count) * 10_000) / 10_000 : null;
  return {
    perSignupUsd: per(perSignupRows[0]?.usd, signups),
    perActiveUserUsd: per(activeRows[0]?.usd, active),
    activeUsers: active,
    unattributedUsd: Math.round(Number(unattributedRows[0]?.usd ?? 0) * 100) / 100,
    perDeliveredBook: bookRows.map((row) => ({
      tier: row.tier ?? "balanced",
      books: Number(row.books),
      avgUsd: per(row.usd, Number(row.books)) ?? 0
    }))
  };
}
