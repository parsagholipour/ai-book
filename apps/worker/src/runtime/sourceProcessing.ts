import { backfillLegacyPlanSources } from "./sourceLegacyPlans.js";
import { SourceUsageModel, sourceUsageFromStored } from "./sourceUsage.js";
import { backfillLegacySources } from "./sourceBackfill.js";
import { randomUUID } from "node:crypto";
import { objectKey, objectStore } from "@book-maker/storage";
import {
  chunkSourceSection,
  createProviders,
  createSourceOcr,
  createTextModelAdapter,
  extractSource,
  resolveTextModelSelection,
  summarizeSource,
  summarizeSourceOverview,
  type ProviderSet,
  type SourceOcr
} from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import { refundAiProcessingUsageTx } from "@book-maker/db/billing";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { recordProviderUsage } from "../providers/usageAccounting.js";
import { config } from "./config.js";
import type { WorkerRuntimeJob } from "./jobPayloads.js";
import { runWithProviderSpendUserId } from "./providerSpendUser.js";

const LEASE_MS = 180_000;
const LEASE_RENEW_MS = 30_000;
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
  let sourceOwnerId: string | undefined;
  const processingRequestKey = `processing:source:${job.sourceId}:${job.version}`;
  const where = { sourceId: job.sourceId, version: job.version, leaseToken: token, status: { in: PENDING } };
  // A source read has no Stop button and no GenerationJob row: what ends it is
  // losing the lease — the source deleted with its draft or account, or the
  // lease taken by another worker. A renewal that finds nothing to renew aborts
  // the provider call in flight and every one after it.
  const lease = new AbortController();
  const heartbeat = setInterval(() => {
    void prisma.sourceExtraction.updateMany({ where, data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } })
      .then((renewed) => { if (renewed.count === 0) lease.abort(new Error("Source processing lease lost")); })
      .catch((error) => console.error("Source lease renewal failed", error));
  }, LEASE_RENEW_MS);
  heartbeat.unref();
  const checkpoint = async (data: Prisma.SourceExtractionUpdateManyMutationInput, write?: (tx: Prisma.TransactionClient) => Promise<void>) => {
    await prisma.$transaction(async (tx) => {
      if (data.status === "failed" && sourceOwnerId) {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${sourceOwnerId} FOR UPDATE`;
      }
      const claimed = await tx.sourceExtraction.updateMany({ where: { ...where, leaseExpiresAt: { gt: new Date() } }, data: { ...data, usage: { ...usage, elapsedMs: priorElapsedMs + Date.now() - startedAt } } });
      if (claimed.count !== 1) throw new Error("Source processing lease lost");
      await write?.(tx);
    });
  };
  try {
    const source = await prisma.sourceDocument.findUniqueOrThrow({ where: { id: job.sourceId } });
    sourceOwnerId = source.userId;
    // Every provider call below writes its cost row against the source's owner,
    // which is what the spend breaker sums.
    return await runWithProviderSpendUserId(source.userId, async () => {
      const providers = createSourceProviders({ sourceId: job.sourceId, version: job.version, userId: source.userId });
      const model = !config.MOCK_AI && providers?.text ? new SourceUsageModel(providers.text, usage, lease.signal) : undefined;
      const ocr = costedSourceOcr(createSourceOcr(config));
      const previousChunks = await prisma.sourceChunk.findMany({ where: { sourceId: job.sourceId, version: job.version }, orderBy: { ordinal: "asc" } });
      let checkpoints = Array.isArray(job.checkpoints) ? job.checkpoints as Array<{ section: number; locator: string; unreadable?: string }> : [];
      if (!job.extractionComplete) {
        await checkpoint({ status: "extracting", error: null });
        const data = await objectStore().get(objectKey("attachments", source.storageDraftId, source.id));
        if (!data) throw new Error("Source upload no longer exists");
        const sections = await extractSource({ data, name: source.name, mimeType: source.mimeType }, {
          ocr: ocr ? async (data, mimeType) => { lease.signal.throwIfAborted(); usage.ocrCalls++; const result = await ocr(data, mimeType); usage.inputTokens += result.inputTokens ?? 0; usage.outputTokens += result.outputTokens ?? 0; return result; } : undefined,
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
        lease.signal.throwIfAborted();
        const summary = chunk.summary || await summarizeSource(chunk.content, model);
        // Embeddings are optional; extraction and summaries survive a provider outage.
        if (!chunk.embedding && providers?.embedding) usage.embeddingCalls++;
        const vector = chunk.embedding ?? await providers?.embedding.embed(chunk.content).catch(() => null);
        await checkpoint({ progress: 55 + Math.round((index + 1) / chunks.length * 40) }, async (tx) => {
          await tx.sourceChunk.update({ where: { sourceId_version_ordinal: { sourceId: job.sourceId, version: job.version, ordinal: chunk.ordinal } }, data: { summary, ...(vector ? { embedding: vector } : {}) } });
        });
        summaries.push(`${chunk.locator}: ${summary}`);
      }
      lease.signal.throwIfAborted();
      const summary = await summarizeSourceOverview(summaries, model);
      const current = await prisma.sourceExtraction.findUniqueOrThrow({ where: { sourceId_version: { sourceId: job.sourceId, version: job.version } } });
      const gaps = Array.isArray(current.unreadable) && current.unreadable.length > 0;
      await checkpoint({ summary, status: chunks.length ? gaps ? "partial" : "ready" : "failed", progress: 100, completedAt: new Date(), leaseToken: null, leaseExpiresAt: null,
        ...(!chunks.length ? { error: "No readable content was found. Retry or upload another file." } : {}) }, async (tx) => {
        if (!chunks.length) await refundAiProcessingUsageTx(tx, source.userId, processingRequestKey);
      });
      return true;
    });
  } catch (error) {
    console.error("Source processing failed", { sourceId: job.sourceId, version: job.version, error });
    const oversized = error instanceof Error && "code" in error && error.code === "FILE_TOO_LARGE";
    const terminal = oversized || job.attempts >= 3;
    const readable = terminal && !oversized ? await prisma.sourceChunk.count({ where: { sourceId: job.sourceId, version: job.version } }) : 0;
    // The failed verdict and refund commit together. A lost lease cannot refund
    // a replacement worker's result; a failed refund leaves the job retryable.
    await prisma.$transaction(async (tx) => {
      if (terminal && !readable && sourceOwnerId) {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${sourceOwnerId} FOR UPDATE`;
      }
      const updated = await tx.sourceExtraction.updateMany({ where, data: { usage: { ...usage, elapsedMs: priorElapsedMs + Date.now() - startedAt }, status: terminal ? readable ? "partial" : "failed" : "queued", error: oversized && error instanceof Error ? error.message : "Reading could not finish. Completed extraction is saved; retry to continue.", leaseToken: null, leaseExpiresAt: terminal ? null : new Date(Date.now() + 30_000) } });
      if (updated.count === 1 && terminal && !readable && sourceOwnerId) {
        await refundAiProcessingUsageTx(tx, sourceOwnerId, processingRequestKey);
      }
    });
    return true;
  } finally { clearInterval(heartbeat); }
}

/**
 * The source read's providers, through the same logging decorators every job's
 * calls go through: each call is in the run log and has a `ProviderCallLog` cost
 * row, and the text model is built with no SDK retries — the decorator's
 * attempt budget is the only retry, so a chunk summary is at most the requests
 * that budget allows, each one logged and costed, where the SDK's hidden two
 * used to stack on top of it. The decorators read a job for their run log and
 * their row; a source read has neither a project nor a `GenerationJob`, so the
 * job names only its owner, which puts the run log in their account's logs and
 * leaves no row to poll for a stop (the lease signal is the stop instead).
 * Construction failing — no provider key — is no model, as it always was: the
 * read still extracts, and summaries fall back to extracts.
 */
function createSourceProviders(owner: { sourceId: string; version: number; userId: string }): ProviderSet | undefined {
  let providers: ProviderSet;
  try {
    const base = createProviders(config);
    providers = config.MOCK_AI ? base : { ...base, text: createTextModelAdapter(config, resolveTextModelSelection(config), { maxRetries: 0 }) };
  } catch {
    return undefined;
  }
  const job = {
    id: `source-${owner.sourceId}-v${owner.version}`,
    name: "process-source",
    data: { userId: owner.userId },
    attemptsMade: 0,
    opts: {}
  } as unknown as WorkerRuntimeJob;
  return createLoggedProviders(job, providers);
}

/**
 * Cloud OCR is a paid Gemini call outside the provider set, so its cost row is
 * written here, from the token counts only Gemini's answer carries — a page the
 * local OCR read has none, and costs nothing.
 */
function costedSourceOcr(ocr: SourceOcr | undefined): SourceOcr | undefined {
  if (!ocr || config.MOCK_AI) return ocr;
  const model = config.GEMINI_OCR_MODEL || config.GEMINI_TEXT_MODEL;
  return async (data, mimeType) => {
    const startedAt = Date.now();
    const result = await ocr(data, mimeType);
    if (result.inputTokens !== undefined || result.outputTokens !== undefined) {
      await recordProviderUsage({
        projectId: undefined,
        generationJobId: undefined,
        provider: "gemini",
        model,
        purpose: "source-ocr",
        operation: "source.ocr",
        callId: randomUUID(),
        durationMs: Date.now() - startedAt,
        usage: { promptTokens: result.inputTokens, outputTokens: result.outputTokens }
      });
    }
    return result;
  };
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
