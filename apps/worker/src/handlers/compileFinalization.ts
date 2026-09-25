import { createHash, randomUUID } from "node:crypto";
import { prisma, type Prisma } from "@book-maker/db";
import type { FinalBookQa, ManuscriptQualityIssue } from "@book-maker/core";
import { isStopOrAbortError } from "@book-maker/core";
import { assertJobNotStopped } from "../runtime/jobLifecycle.js";
import { ExportRepairSupersededError } from "./compileExportFence.js";
import { runExportCheckpoint, type ExportChecks } from "./compileExportCheckpoint.js";
import { repairFailure, repairFailureSchema, type RepairFailure } from "./compileRepairOutcome.js";

type Page = { id: string; index: number; title: string; markdown: string; revision: number };
type Review = { fingerprint: string; finalQa: FinalBookQa; issues: ManuscriptQualityIssue[] };
const LEASE_MS = 120_000;
export class FinalizationLeaseLostError extends ExportRepairSupersededError {
  constructor() { super(); this.message = "Finalization lease was superseded."; this.name = "FinalizationLeaseLostError"; }
}
export type FinalizationPhase = "review" | "repair" | "final_review" | "illustrations" | "coverage" | "render" | "published";
export type FinalizationState = {
  version: 1;
  key: string;
  inputFingerprint: string;
  manuscriptFingerprint: string;
  phase: FinalizationPhase;
  repairPassStarted: boolean;
  repairPassCompleted: boolean;
  startedPageIds: string[];
  completedPageIds: string[];
  unavailableRepairPageIds?: string[];
  repairFailures?: RepairFailure[];
  targetPageIds: string[];
  activePageIndex: number | null;
  pendingImageJobIds: string[];
  illustrationJobsTotal?: number;
  initialReviewStarted?: boolean;
  finalReviewStarted?: boolean;
  initialReview?: Review;
  finalReview?: Review;
  exportChecks?: ExportChecks;
  updatedAt: string;
  lease?: { token: string; expiresAt: number };
  configuration: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function finalizationFingerprint(value: unknown): string {
  // JSONB sorts object keys and removes undefined fields. Normalize through
  // JSON first, then canonicalize nested objects while retaining array order.
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  return createHash("sha256").update(JSON.stringify(canonicalJson(normalized))).digest("hex");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalJson(item)]));
  }
  return value;
}

export function manuscriptFinalizationFingerprint(pages: readonly Page[]): string {
  return finalizationFingerprint(pages.map(({ id, index, title, markdown, revision }) => ({ id, index, title, markdown, revision })));
}

type OperationIdentity = { projectId: string; planId: string; contentRevision: number | null; operationIdentity: unknown };
function operationKey(options: OperationIdentity): string {
  return finalizationFingerprint({ projectId: options.projectId, planId: options.planId,
    revision: options.contentRevision, identity: options.operationIdentity });
}

/** Once begun, an automatic review survives a settings toggle during its image handoff. */
export async function hasCompileFinalization(options: OperationIdentity): Promise<boolean> {
  const row = await prisma.generationJob.findFirst({
    where: { projectId: options.projectId, type: "COMPILE_EXPORT", payload: { path: ["finalization", "key"], equals: operationKey(options) } },
    select: { id: true }
  });
  return row !== null;
}

function parseState(value: unknown, key: string): FinalizationState | null {
  const state = record(value);
  if (state.version !== 1 || state.key !== key || typeof state.updatedAt !== "string" ||
      typeof state.manuscriptFingerprint !== "string" || typeof state.inputFingerprint !== "string" ||
      !state.configuration || state.inputFingerprint !== finalizationFingerprint(state.configuration) ||
      !["review", "repair", "final_review", "illustrations", "coverage", "render", "published"].includes(String(state.phase)) ||
      (state.unavailableRepairPageIds !== undefined && (!Array.isArray(state.unavailableRepairPageIds) ||
      !state.unavailableRepairPageIds.every((id) => typeof id === "string"))) ||
      (state.repairFailures !== undefined && !repairFailureSchema.array().safeParse(state.repairFailures).success) ||
      (state.illustrationJobsTotal !== undefined && (!Number.isSafeInteger(state.illustrationJobsTotal) || Number(state.illustrationJobsTotal) < 0)) ||
      typeof state.repairPassStarted !== "boolean" || typeof state.repairPassCompleted !== "boolean" ||
      ![state.startedPageIds, state.completedPageIds, state.targetPageIds, state.pendingImageJobIds]
        .every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"))) return null;
  return state as FinalizationState;
}

/**
 * The root compile owns durable state in its payload. Successors only carry a
 * pointer and a public progress snapshot. Project row locking gives competing
 * deliveries one root and atomic page claims, without adding a schema migration.
 * The operation key excludes page revisions: our own repairs must not replenish
 * the allowance. An explicit edit, new plan or paid attempt starts another key.
 */
export async function openCompileFinalization(options: {
  projectId: string; planId: string; generationJobId: string;
  contentRevision: number | null; operationIdentity: unknown;
  input: unknown; pages: readonly Page[]; payload: unknown;
}) {
  const key = operationKey(options);
  const initial: FinalizationState = {
    version: 1, key, inputFingerprint: finalizationFingerprint(options.input),
    manuscriptFingerprint: manuscriptFinalizationFingerprint(options.pages), phase: "review",
    repairPassStarted: false, repairPassCompleted: false, startedPageIds: [], completedPageIds: [],
    targetPageIds: [], activePageIndex: null, pendingImageJobIds: [], updatedAt: new Date().toISOString(),
    configuration: options.input
  };
  const root = await prisma.$transaction(async (tx) => {
    await lockProject(tx, options.projectId);
    const prior = await tx.generationJob.findFirst({
      where: { projectId: options.projectId, type: "COMPILE_EXPORT", payload: { path: ["finalization", "key"], equals: key } },
      orderBy: { createdAt: "asc" }, select: { id: true, payload: true }
    });
    if (prior) {
      if (!parseState(record(prior.payload).finalization, key)) throw new Error("Durable finalization checkpoint is invalid.");
      return prior;
    }
    const current = await tx.generationJob.findUnique({ where: { id: options.generationJobId }, select: { payload: true } });
    const payload = { ...record(current?.payload ?? options.payload), finalization: initial };
    await tx.generationJob.update({ where: { id: options.generationJobId }, data: { payload: payload as Prisma.InputJsonValue } });
    return { id: options.generationJobId, payload };
  });
  let state = parseState(record(root.payload).finalization, key)!;
  const token = randomUUID();
  const readState = async (tx: Pick<Prisma.TransactionClient, "generationJob">) => {
    const current = await tx.generationJob.findUnique({ where: { id: root.id }, select: { payload: true } });
    const payload = record(current?.payload);
    const currentState = parseState(payload.finalization, key);
    if (!currentState) throw new Error("Durable finalization checkpoint is missing or invalid.");
    return { payload, currentState };
  };
  for (;;) {
    await assertJobNotStopped(options.generationJobId);
    const claimed = await prisma.$transaction(async (tx) => {
      await lockProject(tx, options.projectId);
      const { payload, currentState } = await readState(tx);
      if (currentState.lease && currentState.lease.expiresAt > Date.now()) return false;
      currentState.lease = { token, expiresAt: Date.now() + LEASE_MS };
      await tx.generationJob.update({ where: { id: root.id }, data: {
        payload: { ...payload, finalization: currentState } as Prisma.InputJsonValue
      } });
      state = currentState;
      return true;
    });
    if (claimed) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  let leaseLost: unknown;
  let closed = false;
  const mutate = async (change: (current: FinalizationState) => void, progressChanged = true): Promise<void> => {
    if (leaseLost) throw leaseLost;
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, options.projectId);
      const { payload, currentState } = await readState(tx);
      const next = structuredClone(currentState);
      if (next.lease?.token !== token) throw new FinalizationLeaseLostError();
      change(next);
      next.lease = { token, expiresAt: Date.now() + LEASE_MS };
      if (progressChanged) next.updatedAt = new Date().toISOString();
      const progress = {
        operationId: root.id, phase: next.phase, pageIndex: next.activePageIndex,
        attempts: next.startedPageIds.length,
        remainingRepairPages: next.repairPassCompleted ? 0 : next.targetPageIds.filter((id) => !next.startedPageIds.includes(id)).length,
        illustrationJobsTotal: next.illustrationJobsTotal ?? next.pendingImageJobIds.length,
        updatedAt: next.updatedAt
      };
      await tx.generationJob.update({ where: { id: root.id }, data: {
        payload: { ...payload, finalization: next, ...(root.id === options.generationJobId ? { finalizationProgress: progress } : {}) } as Prisma.InputJsonValue
      } });
      if (root.id !== options.generationJobId) {
        const successor = await tx.generationJob.findUnique({ where: { id: options.generationJobId }, select: { payload: true } });
        await tx.generationJob.update({ where: { id: options.generationJobId }, data: {
          payload: { ...record(successor?.payload ?? options.payload), finalizationOperationId: root.id, finalizationProgress: progress } as Prisma.InputJsonValue
        } });
      }
      state = next;
    });
  };
  await mutate(() => {}, false);
  let heartbeatRunning: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatRunning || closed) return;
    heartbeatRunning = mutate(() => {}, false).catch((error) => { leaseLost = error; }).finally(() => { heartbeatRunning = undefined; });
  }, LEASE_MS / 3);
  heartbeat.unref();
  return {
    get state() { return state; },
    async exportCheck<T>(request: Pick<Parameters<typeof runExportCheckpoint<T>>[0], "slot" | "fingerprint" | "parse" | "compute" | "interrupted">): Promise<T> {
      return runExportCheckpoint({ ...request, read: () => state.exportChecks,
        mutate: (change) => mutate((next) => { next.exportChecks ??= {}; change(next.exportChecks); }, false),
        assertActive: async () => { await assertJobNotStopped(options.generationJobId); await mutate(() => {}, false); }
      });
    },
    async assertLease(client?: { generationJob?: Prisma.TransactionClient["generationJob"] }) {
      if (!client) return mutate(() => {}, false);
      // The caller already locked Project in its publication transaction.
      // Reading on that same client avoids a nested transaction deadlock and
      // keeps lease ownership atomic with the repaired page/export write.
      if (leaseLost) throw leaseLost;
      if (!client.generationJob) throw new Error("Finalization ownership requires the publication transaction client.");
      const row = await client.generationJob.findUnique({ where: { id: root.id }, select: { payload: true } });
      const persisted = parseState(record(row?.payload).finalization, key);
      if (!persisted) throw new Error("Durable finalization checkpoint is missing or invalid.");
      if (persisted.lease?.token !== token) throw new FinalizationLeaseLostError();
    },
    async close() {
      closed = true; clearInterval(heartbeat); await heartbeatRunning;
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, options.projectId);
        const { payload, currentState } = await readState(tx);
        if (currentState.lease?.token !== token) return;
        delete currentState.lease;
        await tx.generationJob.update({ where: { id: root.id }, data: { payload: { ...payload, finalization: currentState } as Prisma.InputJsonValue } });
      });
    },
    async review(stage: "initial" | "final", pages: readonly Page[], compute: () => Promise<Omit<Review, "fingerprint">>): Promise<Review> {
      const fingerprint = manuscriptFinalizationFingerprint(pages);
      const resultKey = stage === "initial" ? "initialReview" : "finalReview";
      const startedKey = stage === "initial" ? "initialReviewStarted" : "finalReviewStarted";
      if (state[resultKey] && (stage === "initial" || state[resultKey].fingerprint === fingerprint)) return state[resultKey];
      // A targeted repair can be a no-op. No new manuscript means no second
      // paid review; preserve the actual first verdict and its evidence.
      if (stage === "final" && state.initialReview?.fingerprint === fingerprint) {
        const review = state.initialReview;
        await mutate((next) => { next.finalReview = review; next.finalReviewStarted = true; });
        return review;
      }
      let claimed = false;
      await mutate((next) => {
        if (next[startedKey]) return;
        next[startedKey] = true;
        next.phase = stage === "initial" ? "review" : "final_review";
        claimed = true;
      });
      if (!claimed) {
        if (state[resultKey] && (stage === "initial" || state[resultKey].fingerprint === fingerprint)) return state[resultKey];
        return { fingerprint, finalQa: { approved: false, score: 0, issues: ["Final review was interrupted; review the saved manuscript."], requiredFixes: [], notes: "Review unavailable." }, issues: [{
          code: "FINAL_REVIEW_UNAVAILABLE", source: "deterministic", severity: "warning", affectedPageIndexes: [],
          message: "Final review was interrupted before its result could be saved.", guidance: "Review this manuscript or request another review."
        }] };
      }
      let result: Review;
      try {
        result = { ...await compute(), fingerprint };
      } catch (error) {
        if (isStopOrAbortError(error) || error instanceof FinalizationLeaseLostError) throw error;
        // Only model work belongs in compute. Durable reads/writes stay outside
        // this catch so a storage outage cannot masquerade as a quality warning.
        result = { fingerprint, finalQa: { approved: false, score: 0, issues: [], requiredFixes: [], notes: "Review unavailable." },
          issues: [{ code: "FINAL_REVIEW_UNAVAILABLE", source: "model", severity: "warning", affectedPageIndexes: [],
            message: "Final review could not complete after its bounded provider attempts.", guidance: "Review the saved manuscript or request another review." }] };
      }
      await mutate((next) => { next[resultKey] = result; next.manuscriptFingerprint = fingerprint; });
      return result;
    },
    async beginRepair(targetPageIds: string[]) {
      await mutate((next) => {
        if (next.repairPassStarted) return;
        next.repairPassStarted = true; next.phase = "repair"; next.targetPageIds = targetPageIds;
      });
    },
    async claimPage(pageId: string, pageIndex: number): Promise<boolean> {
      let claimed = false;
      await mutate((next) => {
        if (next.repairPassCompleted || !next.repairPassStarted || !next.targetPageIds.includes(pageId) || next.startedPageIds.includes(pageId)) return;
        next.startedPageIds.push(pageId); next.activePageIndex = pageIndex; claimed = true;
      });
      return claimed;
    },
    async claimPages(pages: { id: string; index: number }[]): Promise<boolean> {
      let claimed = false;
      await mutate((next) => {
        if (!pages.length || pages.length !== next.targetPageIds.length || new Set(pages.map((page) => page.id)).size !== pages.length ||
          next.repairPassCompleted || !next.repairPassStarted || next.startedPageIds.length ||
          pages.some((page) => !next.targetPageIds.includes(page.id))) return;
        next.startedPageIds.push(...pages.map((page) => page.id)); next.activePageIndex = pages[0]!.index; claimed = true;
      });
      return claimed;
    },
    async finishRepairInTransaction(client: Pick<Prisma.TransactionClient, "generationJob">, pages: readonly Page[]) {
      // Caller holds the Project lock. Publishing prose and its completed
      // repair stamp together closes the commit-before-checkpoint crash gap.
      if (leaseLost) throw leaseLost;
      const { payload, currentState } = await readState(client);
      if (currentState.lease?.token !== token) throw new FinalizationLeaseLostError();
      const next: FinalizationState = { ...currentState, repairPassCompleted: true, activePageIndex: null,
        completedPageIds: [...new Set([...currentState.completedPageIds, ...currentState.startedPageIds])],
        manuscriptFingerprint: manuscriptFinalizationFingerprint(pages), phase: "final_review", updatedAt: new Date().toISOString() };
      await client.generationJob.update({ where: { id: root.id }, data: { payload: { ...payload, finalization: next } as Prisma.InputJsonValue } });
      state = next;
    },
    async unavailablePage(pageId: string, pageIndex?: number, error?: unknown) {
      await mutate((next) => {
        next.unavailableRepairPageIds ??= [];
        if (!next.unavailableRepairPageIds.includes(pageId)) next.unavailableRepairPageIds.push(pageId);
        next.repairFailures ??= [];
        // A restart must not overwrite a concrete rejection with "already attempted".
        if (!next.repairFailures.some((failure) => failure.pageId === pageId))
          next.repairFailures.push(repairFailure(pageId, pageIndex, error));
        if (!next.completedPageIds.includes(pageId)) next.completedPageIds.push(pageId);
        next.activePageIndex = null;
      });
    },
    async completePage(pageId: string) {
      await mutate((next) => { if (!next.completedPageIds.includes(pageId)) next.completedPageIds.push(pageId); next.activePageIndex = null; });
    },
    async finishRepair(pages: readonly Page[]) {
      await mutate((next) => { next.repairPassCompleted = true; next.activePageIndex = null;
        next.manuscriptFingerprint = manuscriptFinalizationFingerprint(pages); next.phase = "final_review"; });
    },
    async phase(phase: FinalizationPhase, pendingImageJobIds: string[] = []) {
      await mutate((next) => {
        next.phase = phase; next.pendingImageJobIds = pendingImageJobIds;
        if (phase === "illustrations") next.illustrationJobsTotal = Math.max(next.illustrationJobsTotal ?? 0, pendingImageJobIds.length);
      });
    }
  };
}

async function lockProject(tx: Prisma.TransactionClient, projectId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
}
