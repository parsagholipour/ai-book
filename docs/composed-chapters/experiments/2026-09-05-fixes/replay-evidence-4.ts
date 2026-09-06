/** Paid, bounded replay of the captured acceptance failures; run inside the existing worker container. */
import { bindTextModelCall, type TextModelAdapter } from "../../../../packages/core/src/adapters/types.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { mapWithConcurrency, createProviders, createProjectSchema, caseEvidencePacketSchema } from "../../../../packages/core/src/index.ts";
import { buildCaseEvidence } from "../../../../packages/core/src/generation/caseEvidence.ts";
import { reviewCaseEvidencePacket, caseEvidenceReviewIssues } from "../../../../packages/core/src/generation/caseEvidenceReview.ts";
import { prisma } from "../../../../packages/db/src/index.ts";
import { createLoggedProviders } from "../../../../apps/worker/src/providers/loggedAdapters.ts";
import type { WorkerRuntimeJob } from "../../../../apps/worker/src/runtime/jobPayloads.ts";
import { config } from "../../../../apps/worker/src/runtime/config.ts";

if (config.MOCK_AI) throw new Error("This replay requires the real configured writer");
const projectId = "cmtntugl60000img0t01m5uk6";
const source = JSON.parse(readFileSync(new URL("../2026-09-05-sol/diagnostics/accepted-packets-audit-input.json", import.meta.url), "utf8"));
const runId = `evidence-replay-${Date.now()}`;
const results: unknown[] = [];
const failures: string[] = [];
try {
  const plan = await prisma.planVersion.findUniqueOrThrow({ where: { id: "cmtntuglk0001img0hzv22ay6" }, select: { inputSnapshot: true } });
  const input = createProjectSchema.parse(plan.inputSnapshot);
  const providers = createLoggedProviders({ id: runId, name: "evidence-replay", data: { projectId } } as WorkerRuntimeJob, createProviders(config, input), input);
  const rules = JSON.parse(readFileSync(new URL("candidate-evidence-rules.json", import.meta.url), "utf8"));
  function candidateAdapter(adapter: TextModelAdapter): TextModelAdapter {
    return new Proxy(adapter, { get(target, key) {
      if (key === "bindForCall") return async (purpose: string) => { const bound = await bindTextModelCall(target, purpose); return { ...bound, adapter: candidateAdapter(bound.adapter) }; };
      if (key === "generateJson") return (options: Parameters<TextModelAdapter["generateJson"]>[0]) => target.generateJson({ ...options, messages: options.messages.map((message) => message.role === "system" ? { ...message, content: message.content + " " + (options.purpose === "build-case-evidence" ? rules.build : rules.review) } : message) });
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  const candidateText = candidateAdapter(providers.text);
  await mapWithConcurrency(source as Array<{ attempt: string; packet: unknown }>, 2, async (record) => {
    const packet = caseEvidencePacketSchema.parse(record.packet);
    const expectedIdentity = !["The Standard Inscription of Gudea", "The Iroquois Mourning War"].includes(packet.episode.title);
    try {
      const review = await reviewCaseEvidencePacket(packet, candidateText);
      const reviewIssues = caseEvidenceReviewIssues(packet, review);
      const rebuilt = await buildCaseEvidence({ id: packet.id, chapterIndex: packet.sourceChapterIndex, episode: packet.episode, excerpts: packet.excerpts, textModel: candidateText });
      if (review.caseMatch.supported !== expectedIdentity) failures.push(`${packet.episode.title}: case identity differs from the adjudicated fixture`);
      if (Boolean(rebuilt.packet) !== expectedIdentity) failures.push(`${packet.episode.title}: rebuilt packet ${rebuilt.failure ?? "was unexpectedly accepted"}`);
      results.push({ attempt: record.attempt, caseId: packet.id, title: packet.episode.title, expectedIdentity, review, reviewIssues, rebuilt });
      console.log(JSON.stringify({ title: packet.episode.title, identity: review.caseMatch.supported, issues: reviewIssues, rebuilt: Boolean(rebuilt.packet) }));
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      failures.push(`${packet.episode.title}: ${failure}`);
      results.push({ attempt: record.attempt, caseId: packet.id, failure });
    }
    writeFileSync(new URL("evidence-replay-4.json", import.meta.url), JSON.stringify({ runId, results, failures }, null, 2) + "\n");
  });
  console.log(JSON.stringify({ runId, packets: results.length, failures }));
  process.exitCode = failures.length ? 1 : 0;
} finally {
  await prisma.$disconnect();
}
