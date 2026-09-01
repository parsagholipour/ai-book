import {
  QUALITY_FEATURES,
  modelTierFromMediaSettings,
  parseQualityFeatureSettings,
  qualityFeatureEnabled,
  type QualityFeatureId
} from "@book-maker/core";
import { costBreakdownFromRows, type ProviderCostRow } from "./costBreakdown.js";

export type QualityGateCost = {
  id: QualityFeatureId;
  label: string;
  calls: number | null;
  providerCostUsd: number | null;
  costNote: string | null;
};

export type QualityGateRun = {
  createdAt: Date;
  startedAt: Date | null;
};

export type QualityGateRevision = {
  version: number;
  settings: unknown;
  createdAt: Date;
};

const DIRECT_COST_PURPOSES: Partial<Record<QualityFeatureId, ReadonlySet<string>>> = {
  pageModelReview: new Set(["review-page"]),
  pageQaRewrite: new Set(["revise-page", "repair-page-brief"]),
  finalBookQa: new Set([
    "final-book-qa",
    "book.final_qa.chapter_transitions",
    "revise-page",
    "repair-page-brief"
  ]),
  storyExtractAudit: new Set(["extract-story-state"]),
  planCritic: new Set(["critique-plan"]),
  claimVerifier: new Set(["verify-page-claims"]),
  styleAuditor: new Set(["audit-page-style"]),
  pageMapCritic: new Set(["critique-page-map"]),
  beatDedup: new Set(["dedupe-page-beats"]),
  writerTools: new Set(["write-page-with-tools"]),
  bestOfPolish: new Set(["polish-page", "judge-page-drafts"])
};

const NON_SEPARATE_COST_NOTES: Partial<Record<QualityFeatureId, string>> = {
  smartUnslop: "Detection is free; any resulting rewrite is included under Page QA rewrites.",
  planThinkingBoost: "Incremental reasoning spend is included in the planning calls it modifies.",
  claimRetrieve: "Embedding retrieval spend is not separately metered in provider call logs."
};

const FREE_GATE_NOTES: Partial<Record<QualityFeatureId, string>> = {
  pageLocalQa: "Deterministic checks; no provider call.",
  compactPageDraftContext: "Context selection adds no separate provider call.",
  styleExcerpts: "Prompt context only; no separate provider call."
};

/**
 * Gates enabled for at least one project generation run, paired with spend from
 * provider-call purposes that belong to one gate unambiguously.
 *
 * Revisions are resolved at each job's start rather than from today's live
 * settings: the operator can change a tier after a book finishes, and the
 * generated-books view must continue to describe what that book actually ran.
 */
export function qualityGateCostsForProject(options: {
  mediaSettings: unknown;
  fallbackAt: Date;
  runs: QualityGateRun[];
  revisions: QualityGateRevision[];
  costRows: ProviderCostRow[];
}): QualityGateCost[] {
  const tier = modelTierFromMediaSettings(options.mediaSettings);
  const revisions = [...options.revisions].sort(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.version - right.version
  );
  const runTimes = options.runs.length > 0
    ? options.runs.map((run) => run.startedAt ?? run.createdAt)
    : [options.fallbackAt];

  return QUALITY_FEATURES.filter((feature) =>
    runTimes.some((runAt) => qualityFeatureEnabled(settingsAt(revisions, runAt), feature.id, tier))
  ).map((feature) => gateCost(feature.id, feature.label, options.costRows));
}

function settingsAt(revisions: QualityGateRevision[], runAt: Date) {
  let raw: unknown;
  for (const revision of revisions) {
    if (revision.createdAt > runAt) {
      break;
    }
    raw = revision.settings;
  }
  return parseQualityFeatureSettings(raw);
}

function gateCost(id: QualityFeatureId, label: string, rows: ProviderCostRow[]): QualityGateCost {
  const nonSeparateNote = NON_SEPARATE_COST_NOTES[id];
  if (nonSeparateNote) {
    return { id, label, calls: null, providerCostUsd: null, costNote: nonSeparateNote };
  }

  const freeNote = FREE_GATE_NOTES[id];
  if (freeNote) {
    return { id, label, calls: 0, providerCostUsd: 0, costNote: freeNote };
  }

  const purposes = DIRECT_COST_PURPOSES[id];
  const matchingRows = purposes
    ? rows.filter((row) => purposes.has(row.purpose?.trim() ?? "") && belongsToGate(id, row))
    : [];
  const usage = costBreakdownFromRows(matchingRows).totals;
  return {
    id,
    label,
    calls: usage.calls,
    providerCostUsd: usage.usd,
    costNote: usage.calls === 0 ? "Enabled, but no attributable provider call was triggered." : null
  };
}

/** Final-QA repair calls share raw purposes with ordinary page QA. */
function belongsToGate(id: QualityFeatureId, row: ProviderCostRow): boolean {
  const purpose = row.purpose?.trim();
  if (purpose !== "revise-page" && purpose !== "repair-page-brief") {
    return true;
  }
  const compileRepair = row.generation_job_type === "COMPILE_EXPORT";
  return id === "finalBookQa" ? compileRepair : id === "pageQaRewrite" && !compileRepair;
}
