/**
 * Lifetime unit economics for books that are complete right now.
 *
 * The list window chooses projects only. Once chosen, every ledger entry and
 * provider call associated with each project is included, regardless of when
 * it happened, so a later edit or audiobook does not disappear from a book's
 * margin when the dashboard range changes.
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
import {
  qualityGateCostsForProject,
  type QualityGateCost
} from "./qualityGateCosts.js";

export type GeneratedBookSummary = {
  id: string;
  title: string;
  ownerEmail: string;
  pageCount: number;
  imageCount: number;
  completedAt: string;
  grossCredits: number;
  refundedCredits: number;
  netCredits: number;
  revenueUsd: number;
  providerCostUsd: number;
  marginUsd: number;
  marginPercent: number | null;
};

export type GeneratedBookList = {
  books: GeneratedBookSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type GeneratedBookDetail = {
  bookId: string;
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
  qualityGates: QualityGateCost[];
};

const QUALITY_GATE_JOB_TYPES = [
  "PLAN_BOOK",
  "GENERATE_BOOK",
  "GENERATE_PAGE",
  "COMPILE_EXPORT",
  "APPLY_BOOK_EDIT",
  "REPLAN_BOOK",
  "CONTINUE_BOOK"
] as const;

type ProjectEconomicsRow = {
  project_id: string;
  charge_count: bigint | number | null;
  gross_credits: bigint | number | null;
  refund_count: bigint | number | null;
  refunded_credits: bigint | number | null;
  provider_cost_usd: number | null;
};

type ProjectEconomics = {
  chargeCount: number;
  grossCredits: number;
  refundCount: number;
  refundedCredits: number;
  netCredits: number;
  revenueUsd: number;
  providerCostUsd: number;
  marginUsd: number;
  marginPercent: number | null;
};

export async function listGeneratedBooks(options: {
  window: AdminWindow;
  limit: number;
  offset: number;
}): Promise<GeneratedBookList> {
  const where = {
    status: "COMPLETE" as const,
    updatedAt: { gte: options.window.since, lte: options.window.until }
  };
  const [total, projects] = await Promise.all([
    prisma.project.count({ where }),
    prisma.project.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: options.offset,
      take: options.limit,
      select: {
        id: true,
        title: true,
        updatedAt: true,
        user: { select: { email: true } },
        _count: { select: { pages: true, images: true } }
      }
    })
  ]);
  const economics = await loadProjectEconomics(projects.map((project) => project.id));

  return {
    books: projects.map((project) => ({
      id: project.id,
      title: project.title,
      ownerEmail: project.user.email,
      pageCount: project._count.pages,
      imageCount: project._count.images,
      completedAt: project.updatedAt.toISOString(),
      ...economicsFor(economics, project.id)
    })),
    total,
    limit: options.limit,
    offset: options.offset
  };
}

export async function loadGeneratedBookDetail(projectId: string): Promise<GeneratedBookDetail | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, status: true, mediaSettings: true, updatedAt: true }
  });
  if (!project || project.status !== "COMPLETE") {
    return null;
  }

  const [economicsByProject, costRows, qualityRuns, qualityRevisions] = await Promise.all([
    loadProjectEconomics([projectId]),
    loadProjectCostRows(projectId),
    prisma.generationJob.findMany({
      where: { projectId, type: { in: [...QUALITY_GATE_JOB_TYPES] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { createdAt: true, startedAt: true }
    }),
    prisma.generationQualityRevision.findMany({
      orderBy: [{ createdAt: "asc" }, { version: "asc" }],
      select: { version: true, settings: true, createdAt: true }
    })
  ]);
  const economics = economicsByProject.get(projectId) ?? economicsFromRow({
    project_id: projectId,
    charge_count: 0,
    gross_credits: 0,
    refund_count: 0,
    refunded_credits: 0,
    provider_cost_usd: 0
  });
  const breakdown = costBreakdownFromRows(costRows);
  const providerCostUsd = breakdown.totals.usd;
  const marginUsd = round6(economics.revenueUsd - providerCostUsd);

  return {
    bookId: projectId,
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
    purposes: breakdown.operations,
    qualityGates: qualityGateCostsForProject({
      mediaSettings: project.mediaSettings,
      fallbackAt: project.updatedAt,
      runs: qualityRuns,
      revisions: qualityRevisions,
      costRows
    })
  };
}

async function loadProjectEconomics(projectIds: string[]): Promise<Map<string, ProjectEconomics>> {
  if (projectIds.length === 0) {
    return new Map();
  }
  const values = projectIds.map((_id, index) => `($${index + 1}::text)`).join(", ");
  const rows = await prisma.$queryRawUnsafe<ProjectEconomicsRow[]>(
    `
      WITH selected(project_id) AS (VALUES ${values}),
      ledger AS (
        SELECT
          e."projectId" AS project_id,
          COUNT(*) AS charge_count,
          COALESCE(SUM(ABS(e."amountCredits")), 0) AS gross_credits,
          COUNT(r.id) AS refund_count,
          COALESCE(SUM(GREATEST(r."amountCredits", 0)), 0) AS refunded_credits
        FROM "CreditLedgerEntry" e
        JOIN selected s ON s.project_id = e."projectId"
        LEFT JOIN "CreditLedgerEntry" r
          ON r."reversesEntryId" = e.id
         AND r."entryType" = 'REFUND'
         AND r.status = 'SETTLED'
        WHERE e."entryType" = 'SPEND' AND e.status = 'SETTLED'
        GROUP BY e."projectId"
      ),
      provider AS (
        SELECT
          COALESCE(l."projectId", j."projectId") AS project_id,
          COALESCE(SUM(l."costHint"), 0)::double precision AS provider_cost_usd
        FROM "ProviderCallLog" l
        LEFT JOIN "GenerationJob" j ON j.id = l."generationJobId"
        JOIN selected s ON s.project_id = COALESCE(l."projectId", j."projectId")
        WHERE l."costHint" IS NOT NULL
        GROUP BY COALESCE(l."projectId", j."projectId")
      )
      SELECT
        s.project_id,
        COALESCE(ledger.charge_count, 0) AS charge_count,
        COALESCE(ledger.gross_credits, 0) AS gross_credits,
        COALESCE(ledger.refund_count, 0) AS refund_count,
        COALESCE(ledger.refunded_credits, 0) AS refunded_credits,
        COALESCE(provider.provider_cost_usd, 0)::double precision AS provider_cost_usd
      FROM selected s
      LEFT JOIN ledger ON ledger.project_id = s.project_id
      LEFT JOIN provider ON provider.project_id = s.project_id
    `,
    ...projectIds
  );

  return new Map(rows.map((row) => [row.project_id, economicsFromRow(row)]));
}

/** The Costs-tab grouping query, scoped to one project and with no time window. */
async function loadProjectCostRows(projectId: string): Promise<ProviderCostRow[]> {
  return prisma.$queryRaw<ProviderCostRow[]>`
    SELECT
      CASE
        WHEN l.purpose LIKE 'tts.%' OR COALESCE(l.metadata ->> 'operation', '') LIKE 'tts.%' THEN 'audio'
        WHEN l.purpose = 'image.generate' OR l.metadata ->> 'operation' = 'image.generate' THEN 'image'
        ELSE 'text'
      END AS kind,
      l.purpose AS purpose,
      j.type::text AS generation_job_type,
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
    LEFT JOIN "GenerationJob" j ON j.id = l."generationJobId"
    WHERE COALESCE(l."projectId", j."projectId") = ${projectId}
    GROUP BY 1, 2, 3, 4, 5
  `;
}

function economicsFromRow(row: ProjectEconomicsRow): ProjectEconomics {
  const grossCredits = Number(row.gross_credits ?? 0);
  const refundedCredits = Math.max(Number(row.refunded_credits ?? 0), 0);
  const netCredits = netSettledCredits(grossCredits, refundedCredits);
  const revenueUsd = round2(netCredits * CREDIT_USD_VALUE);
  const providerCostUsd = round6(row.provider_cost_usd ?? 0);
  const marginUsd = round6(revenueUsd - providerCostUsd);
  return {
    chargeCount: Number(row.charge_count ?? 0),
    grossCredits,
    refundCount: Number(row.refund_count ?? 0),
    refundedCredits,
    netCredits,
    revenueUsd,
    providerCostUsd,
    marginUsd,
    marginPercent: revenueUsd > 0 ? Math.round((marginUsd / revenueUsd) * 1000) / 10 : null
  };
}

function economicsFor(economics: Map<string, ProjectEconomics>, projectId: string): Omit<ProjectEconomics, "chargeCount" | "refundCount"> {
  const value = economics.get(projectId) ?? economicsFromRow({
    project_id: projectId,
    charge_count: 0,
    gross_credits: 0,
    refund_count: 0,
    refunded_credits: 0,
    provider_cost_usd: 0
  });
  const { chargeCount: _chargeCount, refundCount: _refundCount, ...summary } = value;
  return summary;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
