/**
 * Unit economics for initial plans, isolated from the books they may produce.
 *
 * A plan and its downstream book share a project, so project-scoped totals are
 * deliberately wrong here. Plan revenue is limited to PLAN_GENERATION ledger
 * entries and provider spend is limited to the project's PLAN_BOOK job.
 */

import { CREDIT_USD_VALUE } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import {
  costBreakdownFromRows,
  type CostUsage,
  type KindCost,
  type OperationCost,
  type ProviderCostRow
} from "./costBreakdown.js";
import { netSettledCredits, round2, type AdminWindow } from "./metrics.js";

export type GeneratedPlanSummary = {
  id: string;
  projectId: string;
  title: string;
  ownerEmail: string;
  targetPages: number;
  version: number;
  status: string;
  generatedAt: string;
  grossCredits: number;
  refundedCredits: number;
  netCredits: number;
  revenueUsd: number;
  providerCostUsd: number;
  marginUsd: number;
  marginPercent: number | null;
};

export type GeneratedPlanList = {
  plans: GeneratedPlanSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type GeneratedPlanDetail = {
  planId: string;
  chargeCount: number;
  refundCount: number;
  grossCredits: number;
  refundedCredits: number;
  netCredits: number;
  revenueUsd: number;
  providerCostUsd: number;
  marginUsd: number;
  marginPercent: number | null;
  totals: CostUsage;
  byKind: KindCost[];
  purposes: OperationCost[];
};

type PlanEconomicsRow = {
  plan_id: string;
  charge_count: bigint | number | null;
  gross_credits: bigint | number | null;
  refund_count: bigint | number | null;
  refunded_credits: bigint | number | null;
  provider_cost_usd: number | null;
};

type PlanEconomics = Omit<GeneratedPlanDetail, "planId" | "totals" | "byKind" | "purposes">;

const generatedPlanWhere = (window?: AdminWindow) => ({
  version: 1,
  ...(window ? { createdAt: { gte: window.since, lte: window.until } } : {}),
  project: { jobs: { some: { type: "PLAN_BOOK" as const } } }
});

export async function listGeneratedPlans(options: {
  window: AdminWindow;
  limit: number;
  offset: number;
}): Promise<GeneratedPlanList> {
  const where = generatedPlanWhere(options.window);
  const [total, plans] = await Promise.all([
    prisma.planVersion.count({ where }),
    prisma.planVersion.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: options.offset,
      take: options.limit,
      select: {
        id: true,
        projectId: true,
        version: true,
        status: true,
        createdAt: true,
        project: {
          select: {
            title: true,
            targetPages: true,
            user: { select: { email: true } }
          }
        }
      }
    })
  ]);
  const economics = await loadPlanEconomics(plans.map((plan) => ({ id: plan.id, projectId: plan.projectId })));

  return {
    plans: plans.map((plan) => ({
      id: plan.id,
      projectId: plan.projectId,
      title: plan.project.title,
      ownerEmail: plan.project.user.email,
      targetPages: plan.project.targetPages,
      version: plan.version,
      status: plan.status,
      generatedAt: plan.createdAt.toISOString(),
      ...economicsFor(economics, plan.id)
    })),
    total,
    limit: options.limit,
    offset: options.offset
  };
}

export async function loadGeneratedPlanDetail(planId: string): Promise<GeneratedPlanDetail | null> {
  const plan = await prisma.planVersion.findFirst({
    where: { id: planId, ...generatedPlanWhere() },
    select: { id: true, projectId: true }
  });
  if (!plan) {
    return null;
  }

  const [economicsByPlan, costRows] = await Promise.all([
    loadPlanEconomics([{ id: plan.id, projectId: plan.projectId }]),
    loadPlanCostRows(plan.projectId)
  ]);
  const economics = economicsByPlan.get(plan.id) ?? economicsFromRow(emptyEconomicsRow(plan.id));
  const breakdown = costBreakdownFromRows(costRows);
  const providerCostUsd = breakdown.totals.usd;
  const marginUsd = round6(economics.revenueUsd - providerCostUsd);

  return {
    planId: plan.id,
    chargeCount: economics.chargeCount,
    refundCount: economics.refundCount,
    grossCredits: economics.grossCredits,
    refundedCredits: economics.refundedCredits,
    netCredits: economics.netCredits,
    revenueUsd: economics.revenueUsd,
    providerCostUsd,
    marginUsd,
    marginPercent: economics.revenueUsd > 0
      ? Math.round((marginUsd / economics.revenueUsd) * 1000) / 10
      : null,
    totals: breakdown.totals,
    byKind: breakdown.byKind,
    purposes: breakdown.operations
  };
}

async function loadPlanEconomics(
  plans: Array<{ id: string; projectId: string }>
): Promise<Map<string, PlanEconomics>> {
  if (plans.length === 0) {
    return new Map();
  }
  const values = plans
    .map((_plan, index) => `($${index * 2 + 1}::text, $${index * 2 + 2}::text)`)
    .join(", ");
  const parameters = plans.flatMap((plan) => [plan.id, plan.projectId]);
  const rows = await prisma.$queryRawUnsafe<PlanEconomicsRow[]>(
    `
      WITH selected(plan_id, project_id) AS (VALUES ${values}),
      ledger AS (
        SELECT
          s.plan_id,
          COUNT(e.id) AS charge_count,
          COALESCE(SUM(ABS(e."amountCredits")), 0) AS gross_credits,
          COUNT(r.id) AS refund_count,
          COALESCE(SUM(GREATEST(r."amountCredits", 0)), 0) AS refunded_credits
        FROM selected s
        LEFT JOIN "CreditLedgerEntry" e
          ON e."projectId" = s.project_id
         AND e.operation = 'PLAN_GENERATION'
         AND e."entryType" = 'SPEND'
         AND e.status = 'SETTLED'
        LEFT JOIN "CreditLedgerEntry" r
          ON r."reversesEntryId" = e.id
         AND r."entryType" = 'REFUND'
         AND r.status = 'SETTLED'
        GROUP BY s.plan_id
      ),
      provider AS (
        SELECT
          s.plan_id,
          COALESCE(SUM(l."costHint"), 0)::double precision AS provider_cost_usd
        FROM selected s
        JOIN "GenerationJob" j ON j."projectId" = s.project_id AND j.type = 'PLAN_BOOK'
        JOIN "ProviderCallLog" l ON l."generationJobId" = j.id
        WHERE l."costHint" IS NOT NULL
        GROUP BY s.plan_id
      )
      SELECT
        s.plan_id,
        COALESCE(ledger.charge_count, 0) AS charge_count,
        COALESCE(ledger.gross_credits, 0) AS gross_credits,
        COALESCE(ledger.refund_count, 0) AS refund_count,
        COALESCE(ledger.refunded_credits, 0) AS refunded_credits,
        COALESCE(provider.provider_cost_usd, 0)::double precision AS provider_cost_usd
      FROM selected s
      LEFT JOIN ledger ON ledger.plan_id = s.plan_id
      LEFT JOIN provider ON provider.plan_id = s.plan_id
    `,
    ...parameters
  );

  return new Map(rows.map((row) => [row.plan_id, economicsFromRow(row)]));
}

/** The Costs-tab grouping query, scoped only to the initial plan job. */
async function loadPlanCostRows(projectId: string): Promise<ProviderCostRow[]> {
  return prisma.$queryRaw<ProviderCostRow[]>`
    SELECT
      CASE
        WHEN l.purpose LIKE 'tts.%' OR COALESCE(l.metadata ->> 'operation', '') LIKE 'tts.%' THEN 'audio'
        WHEN l.purpose = 'image.generate' OR l.metadata ->> 'operation' = 'image.generate' THEN 'image'
        ELSE 'text'
      END AS kind,
      l.purpose AS purpose,
      l.provider AS provider,
      l.model AS model,
      COUNT(*)::double precision AS calls,
      COUNT(*) FILTER (WHERE l."costHint" IS NOT NULL)::double precision AS priced_calls,
      COUNT(*) FILTER (
        WHERE l."costHint" IS NULL AND l.metadata ->> 'liveStatus' = 'failed'
      )::double precision AS failed_calls,
      COUNT(*) FILTER (
        WHERE l."costHint" IS NULL AND l.metadata ->> 'liveStatus' = 'in_progress'
      )::double precision AS in_flight_calls,
      COUNT(*) FILTER (
        WHERE l."costHint" IS NULL
          AND COALESCE(l.metadata ->> 'liveStatus', '') NOT IN ('failed', 'in_progress')
          AND l.metadata ->> 'provisional' = 'true'
      )::double precision AS estimated_calls,
      COALESCE(SUM(l."costHint"), 0)::double precision AS usd,
      COALESCE(SUM(l."promptTokens") FILTER (WHERE l."costHint" IS NOT NULL), 0)::double precision AS prompt_tokens,
      COALESCE(SUM(l."cacheHitTokens") FILTER (WHERE l."costHint" IS NOT NULL), 0)::double precision AS cached_prompt_tokens,
      COALESCE(SUM(l."outputTokens") FILTER (WHERE l."costHint" IS NOT NULL), 0)::double precision AS output_tokens,
      COALESCE(
        SUM(
          CASE WHEN jsonb_typeof(l.metadata -> 'audioMs') = 'number'
            THEN (l.metadata ->> 'audioMs')::double precision
          END
        ) FILTER (WHERE l."costHint" IS NOT NULL),
        0
      )::double precision AS audio_ms
    FROM "ProviderCallLog" l
    JOIN "GenerationJob" j ON j.id = l."generationJobId"
    WHERE j."projectId" = ${projectId} AND j.type = 'PLAN_BOOK'
    GROUP BY 1, 2, 3, 4
  `;
}

function economicsFromRow(row: PlanEconomicsRow): PlanEconomics {
  const grossCredits = Number(row.gross_credits ?? 0);
  const refundedCredits = Math.max(Number(row.refunded_credits ?? 0), 0);
  const netCredits = netSettledCredits(grossCredits, refundedCredits);
  const revenueUsd = round2(netCredits * CREDIT_USD_VALUE);
  const providerCostUsd = round6(row.provider_cost_usd ?? 0);
  const marginUsd = round6(revenueUsd - providerCostUsd);
  return {
    chargeCount: Number(row.charge_count ?? 0),
    refundCount: Number(row.refund_count ?? 0),
    grossCredits,
    refundedCredits,
    netCredits,
    revenueUsd,
    providerCostUsd,
    marginUsd,
    marginPercent: revenueUsd > 0 ? Math.round((marginUsd / revenueUsd) * 1000) / 10 : null
  };
}

function economicsFor(economics: Map<string, PlanEconomics>, planId: string) {
  const value = economics.get(planId) ?? economicsFromRow(emptyEconomicsRow(planId));
  const { chargeCount: _chargeCount, refundCount: _refundCount, ...summary } = value;
  return summary;
}

function emptyEconomicsRow(planId: string): PlanEconomicsRow {
  return {
    plan_id: planId,
    charge_count: 0,
    gross_credits: 0,
    refund_count: 0,
    refunded_credits: 0,
    provider_cost_usd: 0
  };
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
