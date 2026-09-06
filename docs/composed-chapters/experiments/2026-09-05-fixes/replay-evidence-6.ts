/**
 * Paid, bounded replay of the eight captured fixtures through the PRODUCTION evidence modules —
 * no prompt injection — after the chronology-in-claims / provenance-is-metadata / claim-excision
 * revision (implementation-3). Run inside the existing worker container:
 *   docker exec -w /app ai-book-maker-worker-1 pnpm exec tsx docs/composed-chapters/experiments/2026-09-05-fixes/replay-evidence-6.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mapWithConcurrency, createProviders, createProjectSchema, caseEvidencePacketSchema } from "../../../../packages/core/src/index.ts";
import { buildCaseEvidence } from "../../../../packages/core/src/generation/caseEvidence.ts";
import { prisma } from "../../../../packages/db/src/index.ts";
import { createLoggedProviders } from "../../../../apps/worker/src/providers/loggedAdapters.ts";
import type { WorkerRuntimeJob } from "../../../../apps/worker/src/runtime/jobPayloads.ts";
import { config } from "../../../../apps/worker/src/runtime/config.ts";

if (config.MOCK_AI) throw new Error("This replay requires the real configured writer");
const projectId = "cmtntugl60000img0t01m5uk6";
const source = JSON.parse(readFileSync(new URL("../2026-09-05-sol/diagnostics/accepted-packets-audit-input.json", import.meta.url), "utf8"));
const runId = `evidence-replay-6-${Date.now()}`;
const results: unknown[] = [];
const failures: string[] = [];
try {
  const plan = await prisma.planVersion.findUniqueOrThrow({ where: { id: "cmtntuglk0001img0hzv22ay6" }, select: { inputSnapshot: true } });
  const input = createProjectSchema.parse(plan.inputSnapshot);
  const providers = createLoggedProviders({ id: runId, name: "evidence-replay", data: { projectId } } as WorkerRuntimeJob, createProviders(config, input), input);
  await mapWithConcurrency(source as Array<{ attempt: string; packet: unknown }>, 2, async (record) => {
    const packet = caseEvidencePacketSchema.parse(record.packet);
    const expectedIdentity = !["The Standard Inscription of Gudea", "The Iroquois Mourning War"].includes(packet.episode.title);
    try {
      const rebuilt = await buildCaseEvidence({ id: packet.id, chapterIndex: packet.sourceChapterIndex, episode: packet.episode, excerpts: packet.excerpts, textModel: providers.text });
      if (Boolean(rebuilt.packet) !== expectedIdentity) failures.push(`${packet.episode.title}: rebuilt packet ${rebuilt.failure ?? "was unexpectedly accepted"}`);
      results.push({ attempt: record.attempt, caseId: packet.id, title: packet.episode.title, expectedIdentity, rebuilt });
      console.log(JSON.stringify({ title: packet.episode.title, rebuilt: Boolean(rebuilt.packet), failure: rebuilt.failure ?? null }));
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      failures.push(`${packet.episode.title}: ${failure}`);
      results.push({ attempt: record.attempt, caseId: packet.id, failure });
    }
    writeFileSync(new URL("evidence-replay-6.json", import.meta.url), JSON.stringify({ runId, results, failures }, null, 2) + "\n");
  });
  console.log(JSON.stringify({ runId, packets: results.length, failures }));
  process.exitCode = failures.length ? 1 : 0;
} finally {
  await prisma.$disconnect();
}
