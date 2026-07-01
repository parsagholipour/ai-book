import { prisma } from "../packages/db/src/index.ts";

type Args = {
  apply: boolean;
  projectId?: string | undefined;
};

type RepairCandidate = {
  projectId: string;
  title: string;
  currentPlanId: string;
  latestReviseJobId: string;
  latestReviseJobStatus: string;
  latestReviseJobFinishedAt: string | null;
  latestReviseJobError: string | null;
};

const args = parseArgs(process.argv.slice(2));

try {
  const result = await repairStuckPlanRevisions(args);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await prisma.$disconnect();
}

async function repairStuckPlanRevisions(options: Args) {
  const candidates = await findCandidates(options.projectId);
  const result = {
    mode: options.apply ? "applied" : "dry-run",
    candidateCount: candidates.length,
    candidates,
    updatedProjectIds: [] as string[]
  };

  if (!options.apply || candidates.length === 0) {
    return result;
  }

  for (const candidate of candidates) {
    const updated = await prisma.project.updateMany({
      where: {
        id: candidate.projectId,
        status: "PLANNING",
        currentPlanId: candidate.currentPlanId
      },
      data: { status: "PLAN_READY" }
    });
    if (updated.count > 0) {
      result.updatedProjectIds.push(candidate.projectId);
    }
  }

  return result;
}

async function findCandidates(projectId: string | undefined): Promise<RepairCandidate[]> {
  const projects = await prisma.project.findMany({
    where: {
      status: "PLANNING",
      currentPlanId: { not: null },
      ...(projectId ? { id: projectId } : {})
    },
    select: {
      id: true,
      title: true,
      currentPlanId: true
    },
    orderBy: { updatedAt: "desc" }
  });

  const candidates: RepairCandidate[] = [];
  for (const project of projects) {
    if (!project.currentPlanId) {
      continue;
    }
    const [latestReviseJob, activePlanningJobCount] = await Promise.all([
      prisma.generationJob.findFirst({
        where: { projectId: project.id, type: "REVISE_PLAN" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          error: true,
          finishedAt: true
        }
      }),
      prisma.generationJob.count({
        where: {
          projectId: project.id,
          type: { in: ["PLAN_BOOK", "REVISE_PLAN"] },
          status: { in: ["QUEUED", "ACTIVE"] }
        }
      })
    ]);

    if (!latestReviseJob || latestReviseJob.status !== "FAILED" || activePlanningJobCount > 0) {
      continue;
    }

    candidates.push({
      projectId: project.id,
      title: project.title,
      currentPlanId: project.currentPlanId,
      latestReviseJobId: latestReviseJob.id,
      latestReviseJobStatus: latestReviseJob.status,
      latestReviseJobFinishedAt: latestReviseJob.finishedAt?.toISOString() ?? null,
      latestReviseJobError: latestReviseJob.error ?? null
    });
  }

  return candidates;
}

function parseArgs(argv: string[]): Args {
  let apply = false;
  let projectId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--project") {
      projectId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { apply, projectId };
}

function printUsageAndExit(code: number): never {
  console.log("Usage: pnpm exec tsx scripts/repair-stuck-plan-revisions.ts [--project <project-id>] [--apply]");
  process.exit(code);
}
