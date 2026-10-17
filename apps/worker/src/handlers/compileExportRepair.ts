import { repairQuickDraftFromFinalQa } from "./compileQuickDraftRepair.js";
import { quickDraftQaTargets, quickDraftRepairTargets } from "../generation/quickDraftReviewPolicy.js";
import type { FinalQaOwnershipClaim } from "./compileExportFence.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import type {
  BookGenerationStrategy,
  BookPlan,
  CreateProjectInput,
  FinalBookQa,
  ManuscriptQualityIssue,
  ProviderSet
} from "@book-maker/core";
import type { Prisma } from "@book-maker/db";

/**
 * The compile's one repair: the defect screen's scoped patch over at most three pages, whole finding groups only
 * (`quickDraftRepairTargets`), verified once and published atomically (`compileQuickDraftRepair.ts`). The per-page
 * rewrite loop and the coordinated picture-book rewrite that other tiers ran here went with their final review
 * (2026-10-16, `CLAUDE.md`).
 */
export async function repairPagesFromFinalQa(options: {
  projectId: string;
  /** Plan-version identity carried into any replacement illustration job. */
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  pages: ExportPageForRepair[];
  finalQa: FinalBookQa;
  additionalRepairIssues?: readonly ManuscriptQualityIssue[];
  /** Additional page indexes to repair (pages that failed page-level QA, integrity errors). */
  extraPageIndexes?: number[] | undefined;
  /**
   * The fence every durable write of the pass is staked on: a superseded answer stands the compile down, an
   * unreadable one stops the repair without settling it (`compileExportFence.ts`). The publication call hands
   * its transaction client, and the claim must bind through that client, so the page writes are atomic with it.
   */
  assertOwnership?: FinalQaOwnershipClaim | undefined;
  generationJobId?: string | undefined;
  shouldRepairPage?: (pageId: string) => boolean;
  onRepairPageStarted?: (pageId: string, pageIndex: number) => Promise<boolean>;
  onRepairGroupStarted?: (pages: { id: string; index: number }[]) => Promise<boolean>;
  onRepairGroupPublished?: (client: Prisma.TransactionClient, pages: ExportPageForRepair[]) => Promise<void>;
  onRepairPageCompleted?: (pageId: string) => Promise<void>;
  onRepairPageUnavailable?: (pageId: string, pageIndex: number, error: unknown) => Promise<void>;
  /** The compile redraws a repaired page's picture at finalization, so an illustrated page may be repaired. */
  deferIllustrations?: boolean;
}): Promise<ExportPageForRepair[] | undefined> {
  const repairPageIndexes = new Set([...(options.extraPageIndexes ?? []), ...quickDraftQaTargets(options.finalQa)]);
  const targets = quickDraftRepairTargets(options.pages, repairPageIndexes, options.finalQa);
  // Nothing real to repair is not a pass: returning `undefined` keeps the caller from deriving a second verdict.
  return targets.length ? repairQuickDraftFromFinalQa(options, targets) : undefined;
}
