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

/**
 * Which pipeline a gate belongs to. `planning` runs before a strategy is
 * chosen and so reaches every book; `per-page` is the page-map/page-draft/
 * page-review pipeline (`sequential-pages`, `chapter-whole-pass`,
 * `batch-window`, `draft-then-polish`, `whole-book`); `composed` is the
 * composed-chapters pipeline. A row on the Quality tab that names only one of
 * the last two changes nothing for a book the other pipeline wrote, which is
 * what the console has to be able to say.
 */
export const QUALITY_PIPELINES = ["planning", "per-page", "composed"] as const;
export type QualityPipeline = (typeof QUALITY_PIPELINES)[number];

export const QUALITY_PIPELINE_LABELS: Record<QualityPipeline, string> = {
  planning: "Every book (planning)",
  "per-page": "Per-page pipeline",
  composed: "Composed chapters"
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
  "claimRetrieve",
  "chapterEditorPass",
  "manuscriptReadPass",
  "creativeContract",
  "materialFirst",
  "coupletRewrite",
  "chapterApparatus"
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
    summary: "Malformed chapter briefs and page maps fail before drafting.",
    pipelines: ["per-page"]
  },
  {
    id: "page-map-coverage",
    label: "Page-map coverage and ordering",
    summary: "The production map must cover the target book exactly, in order.",
    pipelines: ["per-page"]
  },
  {
    id: "generic-assignment-rejection",
    label: "Generic assignment rejection",
    summary: "Placeholder purpose/beat/ending-pressure assignments cannot become briefs.",
    pipelines: ["per-page"]
  },
  {
    id: "full-map-collision",
    label: "Full-map collision detection and resolution",
    summary: "Near-duplicate beats are detected across the whole map and repaired or rejected.",
    pipelines: ["per-page"]
  },
  {
    id: "deterministic-page-integrity",
    label: "Deterministic page integrity",
    summary: "Page-level structural integrity checks run before durable drafts.",
    pipelines: ["per-page", "composed"]
  },
  {
    id: "deterministic-manuscript-audit",
    label: "Deterministic manuscript structural audit",
    summary: "Detector manuscript-structural-audit-v1 always runs on outcome compiles.",
    pipelines: ["per-page", "composed"]
  },
  {
    id: "publication-state-grading",
    label: "Publication-state grading",
    summary: "Quality-report state decides COMPLETE vs REVIEW_REQUIRED independently of polish gates.",
    pipelines: ["per-page", "composed"]
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
  claimRetrieve: ["ultra"],
  // Composed-chapters strategy only. One prose call per chapter each; the
  // read is one call per book. Both replace the per-page review loop.
  chapterEditorPass: ["ultra", "premium", "balanced", "fast"],
  manuscriptReadPass: ["ultra", "premium", "balanced", "fast"],
  // The 2026-09-03 quality ladder (opinion-fable-5). Off everywhere until a
  // rung is measured; each is a content or contract change, not a gate.
  creativeContract: [],
  materialFirst: [],
  coupletRewrite: [],
  chapterApparatus: []
};

export type QualityFeatureDescription = {
  id: QualityFeatureId;
  label: string;
  summary: string;
  /** The pipelines whose books this gate can change. */
  pipelines: readonly QualityPipeline[];
  /** Where in that pipeline it fires, as the console labels it. */
  stage: string;
};

export const QUALITY_FEATURES: QualityFeatureDescription[] = [
  {
    id: "pageLocalQa",
    label: "Local page checks",
    summary: "Deterministic page checks for repetition, placeholders, prompt leaks, and formulaic prose.",
    pipelines: ["per-page", "composed"],
    stage: "Page checks"
  },
  {
    id: "smartUnslop",
    label: "Smart unslop",
    summary: "Finds significant deterministic slop candidates and, when Page QA rewrites is on, asks for a contextual minimal rewrite or an unchanged page.",
    pipelines: ["per-page", "composed"],
    stage: "Page checks"
  },
  {
    id: "pageModelReview",
    label: "Model page review",
    summary: "Reviews each drafted page with the editor model after any enabled local checks.",
    pipelines: ["per-page"],
    stage: "Page review"
  },
  {
    id: "pageQaRewrite",
    label: "Page QA rewrites",
    summary: "Revises and re-reviews pages that fail enabled page checks. Off keeps the first reviewed draft.",
    pipelines: ["per-page", "composed"],
    stage: "Page review"
  },
  {
    id: "finalBookQa",
    label: "Final book QA",
    summary: "Optional chapter transitions, the final book review, and targeted repair before export. Deterministic manuscript audit and targeted structural review are mandatory integrity and are not this checkbox.",
    pipelines: ["per-page"],
    stage: "Compile"
  },
  {
    id: "storyExtractAudit",
    label: "Story extract + audit",
    summary: "One cheap mechanical call per page to track promises, facts, and contradictions.",
    pipelines: ["per-page", "composed"],
    stage: "Page save"
  },
  {
    id: "planCritic",
    label: "Plan critic",
    summary: "One cheap mechanical call per book that patches promises and repeated beats. Not a second planner.",
    pipelines: ["planning"],
    stage: "Plan"
  },
  {
    id: "claimVerifier",
    label: "Claim verifier (factual books)",
    summary: "Checks page claims against loaded research notes. Kids and fiction skip the call even when this is on.",
    pipelines: ["per-page"],
    stage: "Page review"
  },
  {
    id: "compactPageDraftContext",
    label: "Compact page-draft context",
    summary: "Drafts from indexed summaries plus one bounded nearest-page handoff instead of five page excerpts.",
    pipelines: ["per-page"],
    stage: "Page draft"
  },
  {
    id: "styleExcerpts",
    label: "Style excerpts in the pack",
    summary: "Pins two accepted-page excerpts (or import samples) beside the recency window. No model call.",
    pipelines: ["per-page"],
    stage: "Page draft"
  },
  {
    id: "styleAuditor",
    label: "Style auditor",
    summary: "One cheap mechanical call per page comparing prose to the pinned excerpts and voice guide.",
    pipelines: ["per-page"],
    stage: "Page review"
  },
  {
    id: "pageMapCritic",
    label: "Page-map critic",
    summary: "One cheap mechanical call after the page map. Merges beat patches instead of regenerating the map.",
    pipelines: ["per-page"],
    stage: "Page map"
  },
  {
    id: "beatDedup",
    label: "Page-beat rewrite (optional polish)",
    summary: "One cheap rewrite call when a beat collision is found. Map integrity (coverage, generics, collisions) always runs and is not this checkbox.",
    pipelines: ["per-page"],
    stage: "Page map"
  },
  {
    id: "writerTools",
    label: "Writer tools",
    summary: "Ultra-only tool loop (lookup page / entity / research) with at most two tool rounds plus a finish.",
    pipelines: ["per-page"],
    stage: "Page draft"
  },
  {
    id: "bestOfPolish",
    label: "Best-of-2 polish",
    summary: "Samples two polish drafts and keeps the stronger one. Sequential page draft uses the same gate.",
    pipelines: ["per-page"],
    stage: "Page draft"
  },
  {
    id: "planThinkingBoost",
    label: "Deeper plan thinking",
    summary: "Raises thinking budget on the existing plan-book call (and Ultra page-map). Not a second prose round.",
    pipelines: ["planning"],
    stage: "Plan"
  },
  {
    id: "claimRetrieve",
    label: "Failed-claim research retrieve",
    summary: "When a factual page fails groundedOk, one embedding retrieve of stored research into the existing revise.",
    pipelines: ["per-page"],
    stage: "Page review"
  },
  {
    id: "chapterEditorPass",
    label: "Chapter line edit (composed chapters)",
    summary: "One editor call per composed chapter: cuts repeated caveats and restatements, varies paragraph shape, lets stated positions stand. Off keeps the first draft.",
    pipelines: ["composed"],
    stage: "Chapter edit"
  },
  {
    id: "manuscriptReadPass",
    label: "Whole-manuscript read (composed chapters)",
    summary: "One read of the finished book returning per-chapter notes; at most a third of the chapters get a second line edit.",
    pipelines: ["composed"],
    stage: "Manuscript read"
  },
  {
    id: "creativeContract",
    label: "Creative contract (composed chapters)",
    summary: "The writer draws on its own knowledge for people, dates, documents and scenes instead of being held to the research notes; quotation marks stay a promise.",
    pipelines: ["composed"],
    stage: "Compose chapter"
  },
  {
    id: "materialFirst",
    label: "Material first: episodes and a primary-source dossier (composed chapters)",
    summary: "Plans two or three episodes per chapter, fetches verbatim public-domain text for them, and composes each chapter around its episodes with a code-checked quote guard.",
    pipelines: ["composed"],
    stage: "Compose chapter"
  },
  {
    id: "coupletRewrite",
    label: "Couplet rewrite (composed chapters)",
    summary: "A deterministic detector finds the negation-then-assertion sentence pairs; one line-edit call per chapter on the writer rewrites only those, accepted only when the pattern is gone and every name and number survives.",
    pipelines: ["composed"],
    stage: "Line edit"
  },
  {
    id: "chapterApparatus",
    label: "Chapter epigraphs from the dossier (composed chapters)",
    summary: "Sets a verbatim, attributed epigraph from the chapter's primary-source dossier at the head of each chapter that has one, and lets no two consecutive chapters open on a told scene. No model call; needs Material first.",
    pipelines: ["composed"],
    stage: "Paginate and describe"
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
