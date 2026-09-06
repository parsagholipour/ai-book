import { writeFileSync } from "node:fs";
import { prisma } from "../../../../packages/db/src/index.ts";
const projectId = process.argv[2];
if (!projectId) throw new Error("project id required");
try {
  const [project, jobs, pages, calls, plan] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { status: true } }),
    prisma.generationJob.findMany({ where: { projectId }, select: { type: true, status: true, progress: true, message: true, createdAt: true, updatedAt: true } }),
    prisma.page.groupBy({ by: ["status"], where: { projectId }, _count: { _all: true } }),
    prisma.providerCallLog.groupBy({ by: ["purpose", "model"], where: { projectId }, _count: { _all: true }, _sum: { costHint: true } }),
    prisma.planVersion.findFirst({ where: { projectId }, orderBy: { version: "desc" }, select: { planningPackage: true } })
  ]);
  console.log(JSON.stringify({ projectId, project, jobs, pages, calls }));
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(plan?.planningPackage, null, 2));
} finally { await prisma.$disconnect(); }
