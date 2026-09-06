import { writeFileSync } from "node:fs";
import { prisma } from "../../../../packages/db/src/index.ts";
import { bookQueue, redisConnection } from "../../../../apps/api/src/queue.ts";
const projectId = process.argv.slice(2).find((value) => !value.startsWith("--"));
try {
  const jobs = await prisma.generationJob.findMany({
    where: { ...(projectId ? { projectId } : {}), status: { in: ["QUEUED", "ACTIVE"] } },
    select: { id: true, projectId: true, type: true, status: true, progress: true, message: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: "asc" }
  });
  const settings = await prisma.generationQualityRevision.findFirst({ orderBy: { version: "desc" } });
  const queued = await bookQueue.getJobs(["active", "waiting", "delayed"], 0, 50);
  console.log(JSON.stringify({ jobs, queue: queued.map((job) => ({ id: job.id, name: job.name, processedOn: job.processedOn })), qualityRevision: settings?.version }));
  if (process.argv.includes("--snapshot")) writeFileSync("docs/composed-chapters/experiments/2026-09-05-whole-book/quality-before.json", JSON.stringify(settings, null, 2));
} finally { await bookQueue.close(); await redisConnection.quit(); await prisma.$disconnect(); }
