/** Read-only per-job accounting; the ordinary project export combines retries. */
import { readFileSync, writeFileSync } from "node:fs";
import { prisma } from "../../../../packages/db/src/index.ts";

const root = new URL("./", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
const ids = manifest.launches.map((launch: { generationJobId: string }) => launch.generationJobId);
try {
  const [jobs, calls] = await Promise.all([
    prisma.generationJob.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, createdAt: true, startedAt: true, finishedAt: true, progress: true }
    }),
    prisma.providerCallLog.groupBy({
      by: ["generationJobId", "provider", "model", "purpose"], where: { generationJobId: { in: ids } },
      _count: true, _sum: { costHint: true, promptTokens: true, outputTokens: true }
    })
  ]);
  const result = jobs.map((job) => {
    const perPurpose = calls.filter((call) => call.generationJobId === job.id);
    return {
      ...job, calls: perPurpose,
      totalTextCalls: perPurpose.reduce((sum, call) => sum + call._count, 0),
      estimatedProviderCost: perPurpose.reduce((sum, call) => sum + (call._sum.costHint ?? 0), 0),
      missingCostEstimates: perPurpose.some((call) => call._sum.costHint === null)
    };
  });
  writeFileSync(new URL("job-accounting.json", root), JSON.stringify({ capturedAt: new Date().toISOString(), jobs: result }, null, 2) + "\n");
  console.log(JSON.stringify(result.map(({ calls, ...job }) => job), null, 2));
} finally {
  await prisma.$disconnect();
}
