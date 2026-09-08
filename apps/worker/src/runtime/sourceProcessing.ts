import { backfillLegacyPlanSources } from "./sourceLegacyPlans.js";
import { SourceUsageModel, sourceUsageFromStored } from "./sourceUsage.js";
import { backfillLegacySources } from "./sourceBackfill.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chunkSourceSection, createProviders, createSourceOcr, extractSource, summarizeSource, summarizeSourceOverview } from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import { config } from "./config.js";

const LEASE_MS = 180_000;
const PENDING = ["queued", "extracting", "summarizing"];

/** SourceExtraction is a DB-backed durable job, independent of project/billing jobs. */
export async function processNextSource(): Promise<boolean> {
  const token = randomUUID();
  const rows = await prisma.$queryRaw<Array<Prisma.SourceExtractionGetPayload<{}>>>`
    UPDATE "SourceExtraction" SET "leaseToken" = ${token}, "leaseExpiresAt" = ${new Date(Date.now() + LEASE_MS)}, "attempts" = "attempts" + 1
    WHERE ("sourceId", "version") = (
      SELECT "sourceId", "version" FROM "SourceExtraction"
      WHERE "status" IN ('queued', 'extracting', 'summarizing') AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < NOW())
      ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING *`;
  const job = rows[0];
  if (!job) return false;
  const usage = sourceUsageFromStored(job.usage);
  const startedAt = Date.now();
  const priorElapsedMs = usage.elapsedMs;
  const where = { sourceId: job.sourceId, version: job.version, leaseToken: token, status: { in: PENDING } };
  const heartbeat = setInterval(() => {
    void prisma.sourceExtraction.updateMany({ where, data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } }).catch((error) => console.error("Source lease renewal failed", error));
  }, 30_000);
  heartbeat.unref();
  const checkpoint = async (data: Prisma.SourceExtractionUpdateManyMutationInput, write?: (tx: Prisma.TransactionClient) => Promise<void>) => {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.sourceExtraction.updateMany({ where: { ...where, leaseExpiresAt: { gt: new Date() } }, data: { ...data, usage: { ...usage, elapsedMs: priorElapsedMs + Date.now() - startedAt } } });
      if (claimed.count !== 1) throw new Error("Source processing lease lost");
      await write?.(tx);
    });
  };
  try {
    const source = await prisma.sourceDocument.findUniqueOrThrow({ where: { id: job.sourceId } });
    const providers = (() => { try { return createProviders(config); } catch { return undefined; } })();
    const model = !config.MOCK_AI && providers?.text ? new SourceUsageModel(providers.text, usage) : undefined;
    const ocr = createSourceOcr(config);
    const previousChunks = await prisma.sourceChunk.findMany({ where: { sourceId: job.sourceId, version: job.version }, orderBy: { ordinal: "asc" } });
    let checkpoints = Array.isArray(job.checkpoints) ? job.checkpoints as Array<{ section: number; locator: string; unreadable?: string }> : [];
    if (!job.extractionComplete) {
      await checkpoint({ status: "extracting", error: null });
      const data = await readFile(join(config.ATTACHMENT_STORAGE_DIR, source.storageDraftId, source.id));
      const sections = await extractSource({ data, name: source.name, mimeType: source.mimeType }, {
        ocr: ocr ? async (data, mimeType) => { usage.ocrCalls++; const result = await ocr(data, mimeType); usage.inputTokens += result.inputTokens ?? 0; usage.outputTokens += result.outputTokens ?? 0; return result; } : undefined,
        completed: checkpoints.map((entry) => ({ ...entry, content: previousChunks.filter((chunk) => chunk.section === entry.section).map((chunk) => chunk.content).join("") })),
        checkpoint: async (section, total) => {
          checkpoints = [...checkpoints.filter((entry) => entry.section !== section.section), { section: section.section, locator: section.locator, ...(section.unreadable ? { unreadable: section.unreadable } : {}) }];
          const chunks = chunkSourceSection(section);
          const unchanged = previousChunks.filter((chunk) => chunk.section === section.section).map((chunk) => chunk.content).join("") === section.content;
          await checkpoint({ totalSections: total, checkpoints, progress: Math.round(checkpoints.length / total * 55) }, async (tx) => {
            if (!unchanged) {
              await tx.sourceChunk.deleteMany({ where: { sourceId: job.sourceId, version: job.version, section: section.section } });
              await tx.sourceChunk.createMany({ data: chunks.map((chunk) => ({ sourceId: job.sourceId, version: job.version, ...chunk })) });
            }
          });
        }
      });
      usage.extractedCharacters = sections.reduce((sum, section) => sum + section.content.length, 0);
      await checkpoint({ extractionComplete: true, fullContent: sections.map((section) => section.content).join("\n\n"), unreadable: sections.flatMap((section) => section.unreadable ? [section.unreadable] : []), status: "summarizing", progress: 55 });
    }
    await checkpoint({ status: "summarizing" });
    const chunks = await prisma.sourceChunk.findMany({ where: { sourceId: job.sourceId, version: job.version }, orderBy: { ordinal: "asc" } });
    usage.extractedCharacters = chunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
    const summaries: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const summary = chunk.summary || await summarizeSource(chunk.content, model);
      // Embeddings are optional; extraction and summaries survive a provider outage.
      if (!chunk.embedding && providers?.embedding) usage.embeddingCalls++;
      const vector = chunk.embedding ?? await providers?.embedding.embed(chunk.content).catch(() => null);
      await checkpoint({ progress: 55 + Math.round((index + 1) / chunks.length * 40) }, async (tx) => {
        await tx.sourceChunk.update({ where: { sourceId_version_ordinal: { sourceId: job.sourceId, version: job.version, ordinal: chunk.ordinal } }, data: { summary, ...(vector ? { embedding: vector } : {}) } });
      });
      summaries.push(`${chunk.locator}: ${summary}`);
    }
    const summary = await summarizeSourceOverview(summaries, model);
    const current = await prisma.sourceExtraction.findUniqueOrThrow({ where: { sourceId_version: { sourceId: job.sourceId, version: job.version } } });
    const gaps = Array.isArray(current.unreadable) && current.unreadable.length > 0;
    await checkpoint({ summary, status: chunks.length ? gaps ? "partial" : "ready" : "failed", progress: 100, completedAt: new Date(), leaseToken: null, leaseExpiresAt: null,
      ...(!chunks.length ? { error: "No readable content was found. Retry or upload another file." } : {}) });
    return true;
  } catch (error) {
    console.error("Source processing failed", { sourceId: job.sourceId, version: job.version, error });
    const oversized = error instanceof Error && "code" in error && error.code === "FILE_TOO_LARGE";
    const terminal = oversized || job.attempts >= 3;
    const readable = terminal && !oversized ? await prisma.sourceChunk.count({ where: { sourceId: job.sourceId, version: job.version } }) : 0;
    await prisma.sourceExtraction.updateMany({ where, data: { usage: { ...usage, elapsedMs: priorElapsedMs + Date.now() - startedAt }, status: terminal ? readable ? "partial" : "failed" : "queued", error: oversized && error instanceof Error ? error.message : "Reading could not finish. Completed extraction is saved; retry to continue.", leaseToken: null, leaseExpiresAt: terminal ? null : new Date(Date.now() + 30_000) } });
    return true;
  } finally { clearInterval(heartbeat); }
}

export function startSourceProcessing() {
  let stopped = false;
  let backfillAt = 0;
  let running: Promise<unknown> | undefined;
  const tick = () => {
    if (stopped || running || !config.FULL_DOCUMENT_SOURCES) return;
    running = (async () => {
      if (Date.now() > backfillAt) { backfillAt = Date.now() + 60_000; await backfillLegacySources(); await backfillLegacyPlanSources(); }
      return processNextSource();
    })().catch((error) => console.error("Source processing sweep failed", error)).finally(() => { running = undefined; });
  };
  const timer = setInterval(tick, 2000);
  timer.unref();
  tick();
  return { async stop() { stopped = true; clearInterval(timer); await running; } };
}
