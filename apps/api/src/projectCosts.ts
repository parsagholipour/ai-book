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
  cacheWriteTokens: number | null;
  costHint: number | null;
  createdAt: Date;
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

  return calculateProjectCostSummary(logs.filter(isSettledCostLog), images);
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
  const logsByProjectId = groupByProjectId(logs.filter(isSettledCostLog));
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
  cacheWriteTokens: true,
  costHint: true,
  createdAt: true,
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

function isSettledCostLog(log: ProviderCostRow): boolean {
  const metadata = jsonPayloadToRecord(log.metadata);
  if (metadata.provisional === true) {
    return false;
  }
  const liveStatus = typeof metadata.liveStatus === "string" ? metadata.liveStatus : null;
  return liveStatus !== "in_progress" && liveStatus !== "failed";
}

function jsonPayloadToRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}
