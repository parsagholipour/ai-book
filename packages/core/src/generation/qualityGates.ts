import type { ModelTier } from "../schemas/mediaSettings.js";

/**
 * Live generation-quality gates: each feature can be assigned to any subset of
 * Effort tiers. An empty array disables the feature until an operator checks a
 * box again. No revision rows means the compiled defaults below, so a fresh
 * database still generates with the approved science.
 */

export const QUALITY_EFFORT_TIERS = ["ultra", "premium", "balanced", "fast"] as const;
export type QualityEffortTier = (typeof QUALITY_EFFORT_TIERS)[number];

export const QUALITY_FEATURE_IDS = [
  "storyExtractAudit",
  "planCritic",
  "claimVerifier",
  "styleExcerpts",
  "styleAuditor",
  "pageMapCritic",
  "writerTools",
  "bestOfPolish",
  "planThinkingBoost",
  "claimRetrieve"
] as const;

export type QualityFeatureId = (typeof QUALITY_FEATURE_IDS)[number];

export type QualityFeatureSettings = Record<QualityFeatureId, QualityEffortTier[]>;

export const QUALITY_FEATURE_DEFAULTS: QualityFeatureSettings = {
  storyExtractAudit: ["ultra", "premium", "balanced", "fast"],
  planCritic: ["ultra", "premium", "balanced", "fast"],
  claimVerifier: ["ultra", "premium", "balanced", "fast"],
  styleExcerpts: ["ultra", "premium", "balanced", "fast"],
  styleAuditor: ["ultra", "premium"],
  pageMapCritic: ["ultra", "premium"],
  writerTools: ["ultra"],
  bestOfPolish: ["ultra"],
  planThinkingBoost: ["ultra", "premium"],
  claimRetrieve: ["ultra"]
};

export const QUALITY_FEATURES: Array<{
  id: QualityFeatureId;
  label: string;
  summary: string;
}> = [
  {
    id: "storyExtractAudit",
    label: "Story extract + audit",
    summary: "One cheap mechanical call per page to track promises, facts, and contradictions."
  },
  {
    id: "planCritic",
    label: "Plan critic",
    summary: "One cheap mechanical call per book that patches promises and repeated beats. Not a second planner."
  },
  {
    id: "claimVerifier",
    label: "Claim verifier (factual books)",
    summary: "Checks page claims against loaded research notes. Kids and fiction skip the call even when this is on."
  },
  {
    id: "styleExcerpts",
    label: "Style excerpts in the pack",
    summary: "Pins two accepted-page excerpts (or import samples) beside the recency window. No model call."
  },
  {
    id: "styleAuditor",
    label: "Style auditor",
    summary: "One cheap mechanical call per page comparing prose to the pinned excerpts and voice guide."
  },
  {
    id: "pageMapCritic",
    label: "Page-map critic",
    summary: "One cheap mechanical call after the page map. Merges beat patches instead of regenerating the map."
  },
  {
    id: "writerTools",
    label: "Writer tools",
    summary: "Ultra-only tool loop (lookup page / entity / research) with at most two tool rounds plus a finish."
  },
  {
    id: "bestOfPolish",
    label: "Best-of-2 polish",
    summary: "Samples two polish drafts and keeps the stronger one. Sequential page draft can use the same gate."
  },
  {
    id: "planThinkingBoost",
    label: "Deeper plan thinking",
    summary: "Raises thinking budget on the existing plan-book call (and Ultra page-map). Not a second prose round."
  },
  {
    id: "claimRetrieve",
    label: "Failed-claim research retrieve",
    summary: "When a factual page fails groundedOk, one embedding retrieve of stored research into the existing revise."
  }
];

function isEffortTier(value: unknown): value is QualityEffortTier {
  return typeof value === "string" && (QUALITY_EFFORT_TIERS as readonly string[]).includes(value);
}

/**
 * Merge a stored revision with compiled defaults.
 *
 * Missing keys fall back to that feature's default so adding a feature later
 * does not require a revision. Empty arrays are kept (disabled). Unknown
 * feature ids are ignored.
 */
export function parseQualityFeatureSettings(raw: unknown): QualityFeatureSettings {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const settings = {} as QualityFeatureSettings;
  for (const id of QUALITY_FEATURE_IDS) {
    if (!(id in record)) {
      settings[id] = [...QUALITY_FEATURE_DEFAULTS[id]];
      continue;
    }
    const value = record[id];
    if (!Array.isArray(value)) {
      settings[id] = [...QUALITY_FEATURE_DEFAULTS[id]];
      continue;
    }
    settings[id] = value.filter(isEffortTier);
  }
  return settings;
}

/** The only predicate the worker uses to decide whether a quality extra runs. */
export function qualityFeatureEnabled(
  settings: QualityFeatureSettings | undefined,
  feature: QualityFeatureId,
  modelTier: ModelTier
): boolean {
  const resolved = settings ?? parseQualityFeatureSettings(undefined);
  const tiers = resolved[feature] ?? QUALITY_FEATURE_DEFAULTS[feature];
  return tiers.includes(modelTier);
}
