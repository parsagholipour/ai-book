import {
  QUALITY_FEATURES,
  modelTierFromMediaSettings,
  parseQualityFeatureSettings,
  qualityFeatureEnabled,
  type QualityFeatureId
} from "@book-maker/core";
import { costBreakdownFromRows, type ProviderCostRow } from "./costBreakdown.js";

export type QualityGateCost = {
  id: string;
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
  writerTools: new Set(["write-page-with-tools"]),
  bestOfPolish: new Set(["polish-page", "judge-page-drafts"]),
  chapterEditorPass: new Set(["edit-chapter"]),
  manuscriptReadPass: new Set(["read-manuscript", "cut-chapter"])
};

const NON_SEPARATE_COST_NOTES: Partial<Record<QualityFeatureId, string>> = {
  smartUnslop: "Detection is free; any resulting rewrite is included under Page QA rewrites.",
  planThinkingBoost: "Incremental reasoning spend is included in the planning calls it modifies.",
  claimRetrieve: "Embedding retrieval spend is not separately metered in provider call logs.",
  beatDedup:
    "Optional polish row only. Map-integrity rewrite spend is listed under Page-map integrity rewrite, which always runs."
};

const FREE_GATE_NOTES: Partial<Record<QualityFeatureId, string>> = {
  pageLocalQa: "Deterministic checks; no provider call.",
  compactPageDraftContext: "Context selection adds no separate provider call.",
  styleExcerpts: "Prompt context only; no separate provider call."
};

const INTEGRITY_COST_GATES = [
  {
    id: "integrity.generate-chapter-brief",
    label: "Chapter briefs (including dense regeneration and map repairs)",
    purposes: new Set(["generate-chapter-brief"]),
    emptyNote:
      "Clean-path no extra brief in this window. Initial briefs, dense regeneration, and map repairs share this purpose."
  },
  {
    id: "integrity.dedupe-page-beats",
    label: "Page-map integrity rewrite",
    purposes: new Set(["dedupe-page-beats"]),
    emptyNote: "Clean-path no-call: map integrity ran without a rewrite."
  },
  {
    id: "integrity.review-manuscript-structure",
    label: "Manuscript structural review",
    purposes: new Set(["review-manuscript-structure"]),
    emptyNote: "Clean-path no-call: no structural-review model call."
  }
] as const;

/**
 * The composed-chapters stages that are not a checkbox: shown whenever a book
 * spent under one of their purposes, so an operator sees what a composed book
 * cost by stage rather than under a single "generation" total. The two stages
 * that are checkboxes (`chapterEditorPass`, `manuscriptReadPass`) attribute
 * through `DIRECT_COST_PURPOSES` like every other gate.
 */
const COMPOSED_STAGE_COST_GATES = [
  {
    id: "composed.author-stance",
    label: "Author stance (composed chapters)",
    purposes: new Set(["author-stance"]),
    emptyNote: "The plan already carried a stance, so no call was made."
  },
  {
    id: "composed.plan-chapter-forms",
    label: "Chapter form plan (composed chapters)",
    purposes: new Set(["plan-chapter-forms"]),
    emptyNote: "No form-plan call in this window."
  },
  {
    id: "composed.compose-chapter",
    label: "Compose chapters (composed chapters)",
    purposes: new Set(["compose-chapter", "judge-chapter-drafts"]),
    emptyNote: "No chapter was composed in this window."
  },
  {
    id: "composed.describe-pages",
    label: "Paginate and describe (composed chapters)",
    purposes: new Set(["describe-pages"]),
    emptyNote: "No page descriptions in this window."
  }
] as const;

/**
 * Gates enabled for at least one project generation run, paired with spend from
 * provider-call purposes that belong to one gate unambiguously.
 *
 * Integrity rows always appear: those calls are not optional polish and must
 * remain attributable when every quality checkbox is off.
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

  const polish = QUALITY_FEATURES.filter((feature) =>
    runTimes.some((runAt) => qualityFeatureEnabled(settingsAt(revisions, runAt), feature.id, tier))
  ).map((feature) => gateCost(feature.id, feature.label, options.costRows));

  const integrity = INTEGRITY_COST_GATES.map((gate) => integrityCost(gate, options.costRows));
  // A book written page by page never spends under these purposes; rows that
  // would only ever say "no call" are noise there, so they appear when the
  // book took the composed pipeline at all.
  const composed = COMPOSED_STAGE_COST_GATES.map((gate) => integrityCost(gate, options.costRows));
  const composedRows = composed.some((row) => (row.calls ?? 0) > 0) ? composed : [];
  return [...integrity, ...composedRows, ...polish];
}

function integrityCost(
  gate: (typeof INTEGRITY_COST_GATES)[number] | (typeof COMPOSED_STAGE_COST_GATES)[number],
  rows: ProviderCostRow[]
): QualityGateCost {
  const matchingRows = rows.filter((row) => gate.purposes.has(row.purpose?.trim() ?? ""));
  const usage = costBreakdownFromRows(matchingRows).totals;
  return {
    id: gate.id,
    label: gate.label,
    calls: usage.calls,
    providerCostUsd: usage.usd,
    costNote: usage.calls === 0 ? gate.emptyNote : null
  };
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
