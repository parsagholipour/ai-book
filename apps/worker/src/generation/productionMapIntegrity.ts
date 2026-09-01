import { bestEffortPass } from "./bestEffortPass.js";
import { applyPlanThinkingBoost } from "./qualitySettings.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import {
  PRODUCTION_MAP_AUDIT_VERSION,
  PRODUCTION_MAP_REPAIR_CYCLE_LIMIT,
  PageMapIntegrityUnresolvedError,
  auditProductionMap,
  chunkFindingsForRewriteCalls,
  dedupePageBeats,
  evidenceLedgerWritingMode,
  mergePageMapCriticPatch,
  productionMapContractFromRanges,
  sparseRewriteFindingsFromAudit,
  type BookGenerationStrategy,
  type BookPlan,
  type ChapterBrief,
  type ChapterPlan,
  type CreateProjectInput,
  type DuplicateBeatFinding,
  type ProductionMapAudit,
  type QualityFeatureId,
  type TextModelAdapter
} from "@book-maker/core";

/**
 * Mandatory production-map integrity behind `prepareChapterSetups`.
 *
 * Callers get a complete, mutually distinct map or a typed throw. Progress
 * writes may degrade; detection, merge, and unresolved blocking findings may
 * not. `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY=shadow` logs `would_block` and
 * keeps the prior draft-anyway behavior. Phase 06 did not remove this env:
 * live precision gates are still unmeasured.
 */

export const PRODUCTION_MAP_INTEGRITY_ENV = "BOOK_MAKER_PRODUCTION_MAP_INTEGRITY";

export function productionMapIntegrityMode(): "enforce" | "shadow" {
  return process.env[PRODUCTION_MAP_INTEGRITY_ENV] === "shadow" ? "shadow" : "enforce";
}

export async function enforceProductionMapIntegrity(options: {
  briefs: ChapterBrief[];
  input: CreateProjectInput;
  plan: BookPlan;
  textModel: TextModelAdapter;
  strategy: BookGenerationStrategy;
  chapterRanges: Array<{ chapter: ChapterPlan; startPage: number; endPage: number }>;
  generationJobId?: string | undefined;
  quality: (feature: QualityFeatureId) => Promise<boolean>;
}): Promise<ChapterBrief[]> {
  const contract = productionMapContractFromRanges(
    options.input.targetPages,
    options.chapterRanges.map((setup) => ({
      chapterIndex: setup.chapter.index,
      startPage: setup.startPage,
      endPage: setup.endPage
    })),
    evidenceLedgerWritingMode(options.input, options.plan)
  );
  await writeProgress(options.generationJobId, "Checking production map integrity");

  let current = options.briefs;
  let lastAudit = await auditProductionMap(current, contract);
  if (!needsRepair(lastAudit)) {
    logIntegrity(auditLog("clean", 0, lastAudit));
    return current;
  }

  for (let cycle = 1; cycle <= PRODUCTION_MAP_REPAIR_CYCLE_LIMIT; cycle += 1) {
    const regenerated = new Set<number>();
    for (const chapterIndex of lastAudit.denseChapterIndexes) {
      await writeProgress(options.generationJobId, `Regenerating chapter ${chapterIndex} production map`);
      current = await regenerateChapterOrKeep(current, chapterIndex, options, regenerated);
      lastAudit = await auditProductionMap(current, contract);
      if (!needsRepair(lastAudit)) {
        logIntegrity(auditLog("clean", cycle, lastAudit));
        return current;
      }
    }

    const rewriteFindings = sparseRewriteFindingsFromAudit(lastAudit, current);
    const batches = chunkFindingsForRewriteCalls(rewriteFindings);
    for (const [batchIndex, batch] of batches.entries()) {
      if (!batch || batch.length === 0) {
        continue;
      }
      await writeProgress(
        options.generationJobId,
        `Repairing ${batch.length} colliding page assignments (batch ${batchIndex + 1}/${batches.length}, cycle ${cycle})`
      );
      current = await repairSparseBatchOrRegenerate({
        briefs: current,
        batch,
        batchIndex: batchIndex + 1,
        cycle,
        regenerated,
        options
      });
      lastAudit = await auditProductionMap(current, contract);
      if (!needsRepair(lastAudit)) {
        logIntegrity(auditLog("clean", cycle, lastAudit, batchIndex + 1));
        return current;
      }
    }

    lastAudit = await auditProductionMap(current, contract);
    if (!needsRepair(lastAudit)) {
      logIntegrity(auditLog("clean", cycle, lastAudit));
      return current;
    }
  }

  // Only an advisory finding survived the cycles — a shared evidence anchor the
  // rewrite could not clear. The page drafts with its distinctness note; the
  // book is not failed over a ledger.
  if (!lastAudit.blocking) {
    logIntegrity(auditLog("advisory_unresolved", PRODUCTION_MAP_REPAIR_CYCLE_LIMIT, lastAudit));
    return current;
  }

  await writeProgress(options.generationJobId, "Production map integrity unresolved");
  const unresolved = new PageMapIntegrityUnresolvedError(PRODUCTION_MAP_REPAIR_CYCLE_LIMIT, lastAudit);
  if (productionMapIntegrityMode() === "shadow") {
    logIntegrity({
      ...auditLog("would_block", PRODUCTION_MAP_REPAIR_CYCLE_LIMIT, lastAudit),
      jobMessage: unresolved.message
    });
    return current;
  }
  logIntegrity(auditLog("unresolved", PRODUCTION_MAP_REPAIR_CYCLE_LIMIT, lastAudit));
  throw unresolved;
}

/**
 * Whether the map still has something the repair loop can act on: a blocking
 * finding, or a sparse one — a shared evidence anchor is repaired through the
 * same rewrite call as a near-duplicate beat without ever blocking.
 */
function needsRepair(audit: ProductionMapAudit): boolean {
  return audit.blocking || audit.sparseFindings.length > 0;
}

async function regenerateChapterOrKeep(
  briefs: ChapterBrief[],
  chapterIndex: number,
  options: {
    input: CreateProjectInput;
    plan: BookPlan;
    textModel: TextModelAdapter;
    strategy: BookGenerationStrategy;
    chapterRanges: Array<{ chapter: ChapterPlan; startPage: number; endPage: number }>;
    quality: (feature: QualityFeatureId) => Promise<boolean>;
  },
  regenerated: Set<number>
): Promise<ChapterBrief[]> {
  if (regenerated.has(chapterIndex)) {
    return briefs;
  }
  const setup = options.chapterRanges.find((range) => range.chapter.index === chapterIndex);
  if (!setup) {
    return briefs;
  }
  applyPlanThinkingBoost(options.textModel, await options.quality("planThinkingBoost"));
  try {
    const next = await options.strategy.generateChapterBrief({
      input: options.input,
      plan: options.plan,
      chapter: setup.chapter,
      chapterPageStart: setup.startPage,
      chapterPageEnd: setup.endPage,
      textModel: options.textModel
    });
    regenerated.add(chapterIndex);
    logIntegrity({
      outcome: "chapter_regenerated",
      chapterIndex,
      detectorVersion: PRODUCTION_MAP_AUDIT_VERSION
    });
    return replaceChapterBrief(briefs, next);
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    logIntegrity({
      outcome: "chapter_regeneration_failed",
      chapterIndex,
      error: error instanceof Error ? error.message : "unknown"
    });
    regenerated.add(chapterIndex);
    return briefs;
  }
}

async function repairSparseBatchOrRegenerate(input: {
  briefs: ChapterBrief[];
  batch: DuplicateBeatFinding[];
  batchIndex: number;
  cycle: number;
  regenerated: Set<number>;
  options: {
    input: CreateProjectInput;
    plan: BookPlan;
    textModel: TextModelAdapter;
    strategy: BookGenerationStrategy;
    chapterRanges: Array<{ chapter: ChapterPlan; startPage: number; endPage: number }>;
    quality: (feature: QualityFeatureId) => Promise<boolean>;
  };
}): Promise<ChapterBrief[]> {
  applyPlanThinkingBoost(input.options.textModel, await input.options.quality("planThinkingBoost"));
  try {
    const patch = await dedupePageBeats({
      textModel: input.options.textModel,
      briefs: input.briefs,
      findings: input.batch,
      promises: input.options.plan.promises ?? [],
      lastPageIndex: input.options.input.targetPages,
      providerCallMetadata: {
        productionMapRepairCycle: input.cycle,
        productionMapRepairBatch: input.batchIndex,
        productionMapRepairFindingCount: input.batch.length,
        productionMapRepairKind: "sparse-page-patch"
      }
    });
    return mergePageMapCriticPatch(input.briefs, patch, input.options.input.targetPages);
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    logIntegrity({
      outcome: "sparse_repair_failed",
      cycle: input.cycle,
      batch: input.batchIndex,
      findingCount: input.batch.length,
      error: error instanceof Error ? error.message : "unknown"
    });
    let current = input.briefs;
    for (const chapterIndex of chaptersForFindings(input.briefs, input.batch)) {
      current = await regenerateChapterOrKeep(current, chapterIndex, input.options, input.regenerated);
    }
    return current;
  }
}

function replaceChapterBrief(briefs: ChapterBrief[], next: ChapterBrief): ChapterBrief[] {
  if (briefs.some((brief) => brief.chapterIndex === next.chapterIndex)) {
    return briefs.map((brief) => (brief.chapterIndex === next.chapterIndex ? next : brief));
  }
  return [...briefs, next].sort((left, right) => left.chapterIndex - right.chapterIndex);
}

function chaptersForFindings(briefs: ChapterBrief[], findings: DuplicateBeatFinding[]): number[] {
  const pageChapter = new Map(
    briefs.flatMap((brief) => brief.pages.map((page) => [page.pageIndex, brief.chapterIndex] as const))
  );
  return [...new Set(findings.flatMap((finding) => {
    const chapterIndex = pageChapter.get(finding.pageIndex);
    return chapterIndex === undefined ? [] : [chapterIndex];
  }))].sort((left, right) => left - right);
}

async function writeProgress(generationJobId: string | undefined, message: string): Promise<void> {
  await bestEffortPass<void>({
    attempt: () => updateJobProgress(generationJobId, { message }),
    fallback: undefined,
    warning: "Production-map integrity progress message skipped; the repair it announces still runs"
  });
}

function auditLog(
  outcome: string,
  cycle: number,
  audit: ProductionMapAudit,
  batch?: number
): Record<string, unknown> {
  return {
    detectorVersion: audit.version,
    outcome,
    cycle,
    ...(batch !== undefined ? { batch } : {}),
    findingCodes: [...new Set(audit.findings.map((finding) => finding.code))],
    affectedPageIndexes: [...new Set(audit.findings.flatMap((finding) => finding.pageIndexes))].sort(
      (left, right) => left - right
    ),
    affectedChapterIndexes: [
      ...new Set([...audit.denseChapterIndexes, ...audit.findings.flatMap((finding) => finding.chapterIndexes)])
    ].sort((left, right) => left - right)
  };
}

function logIntegrity(event: Record<string, unknown>): void {
  console.info(JSON.stringify({ event: "production-map-integrity", ...event }));
}
