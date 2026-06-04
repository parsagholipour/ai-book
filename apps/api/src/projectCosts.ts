import { calculateProjectCostSummary, type ProjectCostSummary } from "@book-maker/core";
import { prisma } from "@book-maker/db";

type ProviderCostRow = {
  projectId: string | null;
  provider: string;
  model: string;
  purpose: string;
  promptTokens: number | null;
  outputTokens: number | null;
  cacheHitTokens: number | null;
  costHint: number | null;
  metadata: unknown;
};

type ImageCostRow = {
  projectId: string;
  provider: string;
  metadata: unknown;
};

export async function loadProjectCostSummary(projectId: string): Promise<ProjectCostSummary> {
  const [logs, images] = await Promise.all([
    prisma.providerCallLog.findMany({
      where: { projectId },
      select: providerCostSelect
    }),
    prisma.imageAsset.findMany({
      where: { projectId },
      select: imageCostSelect
    })
  ]);

  return calculateProjectCostSummary(logs, images);
}

export async function loadProjectCostSummaries(projectIds: string[]): Promise<Map<string, ProjectCostSummary>> {
  const costsByProjectId = new Map<string, ProjectCostSummary>();
  if (projectIds.length === 0) {
    return costsByProjectId;
  }

  const [logs, images] = await Promise.all([
    prisma.providerCallLog.findMany({
      where: { projectId: { in: projectIds } },
      select: providerCostSelect
    }),
    prisma.imageAsset.findMany({
      where: { projectId: { in: projectIds } },
      select: imageCostSelect
    })
  ]);
  const logsByProjectId = groupByProjectId(logs);
  const imagesByProjectId = groupByProjectId(images);

  for (const projectId of projectIds) {
    costsByProjectId.set(
      projectId,
      calculateProjectCostSummary(logsByProjectId.get(projectId) ?? [], imagesByProjectId.get(projectId) ?? [])
    );
  }

  return costsByProjectId;
}

const providerCostSelect = {
  projectId: true,
  provider: true,
  model: true,
  purpose: true,
  promptTokens: true,
  outputTokens: true,
  cacheHitTokens: true,
  costHint: true,
  metadata: true
} as const;

const imageCostSelect = {
  projectId: true,
  provider: true,
  metadata: true
} as const;

function groupByProjectId<T extends ProviderCostRow | ImageCostRow>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.projectId) {
      continue;
    }
    const projectRows = grouped.get(row.projectId);
    if (projectRows) {
      projectRows.push(row);
    } else {
      grouped.set(row.projectId, [row]);
    }
  }
  return grouped;
}
