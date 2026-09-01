import type { ModelTier } from "../schemas/mediaSettings.js";

/**
 * Live generation-quality gates: each feature can be assigned to any subset of
 * Effort tiers. An empty array disables the feature until an operator checks a
 * box again. No revision rows means the compiled defaults below, so a fresh
 * database still generates with the approved science.
 *
 * None of these ids is a mandatory integrity check. Schema validation, page-map
 * coverage, generic assignment rejection, collision handling, deterministic
 * page and manuscript audits, and publication-state grading always run. See
 * `MANDATORY_INTEGRITY_CHECKS`.
 */

export const QUALITY_EFFORT_TIERS = ["ultra", "premium", "balanced", "fast"] as const;
export type QualityEffortTier = (typeof QUALITY_EFFORT_TIERS)[number];

export const PAGE_REVIEW_PROMPT_MODES = ["normal", "compact"] as const;
export type PageReviewPromptMode = (typeof PAGE_REVIEW_PROMPT_MODES)[number];
export type PageReviewPromptModes = Record<QualityEffortTier, PageReviewPromptMode>;

/** Missing or legacy revision values keep the pre-existing full review prompt. */
export const PAGE_REVIEW_PROMPT_MODE_DEFAULTS: PageReviewPromptModes = {
  ultra: "normal",
  premium: "normal",
  balanced: "normal",
  fast: "normal"
};

export const QUALITY_FEATURE_IDS = [
  "pageLocalQa",
  "smartUnslop",
  "pageModelReview",
  "pageQaRewrite",
  "finalBookQa",
  "storyExtractAudit",
  "planCritic",
  "claimVerifier",
  "compactPageDraftContext",
  "styleExcerpts",
  "styleAuditor",
  "pageMapCritic",
  "beatDedup",
  "writerTools",
  "bestOfPolish",
  "planThinkingBoost",
  "claimRetrieve"
] as const;

export type QualityFeatureId = (typeof QUALITY_FEATURE_IDS)[number];

/**
 * Integrity that cannot be disabled by model tier or operator checkboxes.
 * These are not `QUALITY_FEATURE_IDS` and must never be encoded as a
 * disableable tier list on a GenerationQualityRevision.
 */
export const MANDATORY_INTEGRITY_CHECKS = [
  {
    id: "generated-response-schema",
    label: "Generated-response schema validation",
    summary: "Malformed chapter briefs and page maps fail before drafting."
  },
  {
    id: "page-map-coverage",
    label: "Page-map coverage and ordering",
    summary: "The production map must cover the target book exactly, in order."
  },
  {
    id: "generic-assignment-rejection",
    label: "Generic assignment rejection",
    summary: "Placeholder purpose/beat/ending-pressure assignments cannot become briefs."
  },
  {
    id: "full-map-collision",
    label: "Full-map collision detection and resolution",
    summary: "Near-duplicate beats are detected across the whole map and repaired or rejected."
  },
  {
    id: "deterministic-page-integrity",
    label: "Deterministic page integrity",
    summary: "Page-level structural integrity checks run before durable drafts."
  },
  {
    id: "deterministic-manuscript-audit",
    label: "Deterministic manuscript structural audit",
    summary: "Detector manuscript-structural-audit-v1 always runs on outcome compiles."
  },
  {
    id: "publication-state-grading",
    label: "Publication-state grading",
    summary: "Quality-report state decides COMPLETE vs REVIEW_REQUIRED independently of polish gates."
  }
] as const;

export type MandatoryIntegrityCheckId = (typeof MANDATORY_INTEGRITY_CHECKS)[number]["id"];

export type QualityFeatureSettings = Record<QualityFeatureId, QualityEffortTier[]>;

export const QUALITY_FEATURE_DEFAULTS: QualityFeatureSettings = {
  pageLocalQa: ["ultra", "premium", "balanced", "fast"],
  // Detection is deterministic. It hands a failed report to the existing page
  // QA rewrite loop, so there is no extra model call unless the prose actually
  // contains a significant cluster of AI-writing tells.
  smartUnslop: ["ultra", "premium", "balanced", "fast"],
  pageModelReview: ["ultra", "premium", "balanced", "fast"],
  pageQaRewrite: ["ultra", "premium", "balanced", "fast"],
  finalBookQa: ["ultra", "premium", "balanced", "fast"],
  storyExtractAudit: ["ultra", "premium", "balanced", "fast"],
  planCritic: ["ultra", "premium", "balanced", "fast"],
  claimVerifier: ["ultra", "premium", "balanced", "fast"],
  compactPageDraftContext: ["balanced", "fast"],
  styleExcerpts: ["ultra", "premium", "balanced", "fast"],
  styleAuditor: ["ultra", "premium", "balanced"],
  pageMapCritic: ["ultra", "premium"],
  // Detection is deterministic and free. The optional rewrite call this flag
  // used to imply still runs as mandatory map integrity; this checkbox is
  // retained so operators can see the polish row without disabling integrity.
  beatDedup: ["ultra", "premium", "balanced", "fast"],
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
    id: "pageLocalQa",
    label: "Local page checks",
    summary: "Deterministic page checks for repetition, placeholders, prompt leaks, and formulaic prose."
  },
  {
    id: "smartUnslop",
    label: "Smart unslop",
    summary: "Finds significant deterministic slop candidates and, when Page QA rewrites is on, asks for a contextual minimal rewrite or an unchanged page."
  },
  {
    id: "pageModelReview",
    label: "Model page review",
    summary: "Reviews each drafted page with the editor model after any enabled local checks."
  },
  {
    id: "pageQaRewrite",
    label: "Page QA rewrites",
    summary: "Revises and re-reviews pages that fail enabled page checks. Off keeps the first reviewed draft."
  },
  {
    id: "finalBookQa",
    label: "Final book QA",
    summary: "Optional chapter transitions, the final book review, and targeted repair before export. Deterministic manuscript audit and targeted structural review are mandatory integrity and are not this checkbox."
  },
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
    id: "compactPageDraftContext",
    label: "Compact page-draft context",
    summary: "Drafts from indexed summaries plus one bounded nearest-page handoff instead of five page excerpts."
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
    id: "beatDedup",
    label: "Page-beat rewrite (optional polish)",
    summary: "One cheap rewrite call when a beat collision is found. Map integrity (coverage, generics, collisions) always runs and is not this checkbox."
  },
  {
    id: "writerTools",
    label: "Writer tools",
    summary: "Ultra-only tool loop (lookup page / entity / research) with at most two tool rounds plus a finish."
  },
  {
    id: "bestOfPolish",
    label: "Best-of-2 polish",
    summary: "Samples two polish drafts and keeps the stronger one. Sequential page draft uses the same gate."
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

function isPageReviewPromptMode(value: unknown): value is PageReviewPromptMode {
  return typeof value === "string" &&
    (PAGE_REVIEW_PROMPT_MODES as readonly string[]).includes(value);
}

/** Resolve per-tier reviewer prompt modes from a GenerationQualityRevision settings JSON value. */
export function parsePageReviewPromptModes(raw: unknown): PageReviewPromptModes {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const modes = record.pageReviewPromptModes &&
    typeof record.pageReviewPromptModes === "object" &&
    !Array.isArray(record.pageReviewPromptModes)
    ? (record.pageReviewPromptModes as Record<string, unknown>)
    : {};
  return Object.fromEntries(
    QUALITY_EFFORT_TIERS.map((tier) => [
      tier,
      isPageReviewPromptMode(modes[tier])
        ? modes[tier]
        : PAGE_REVIEW_PROMPT_MODE_DEFAULTS[tier]
    ])
  ) as PageReviewPromptModes;
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
