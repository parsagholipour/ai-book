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
  "changedCandidateGrounding",
  "compactPageDraftContext",
  "styleExcerpts",
  "styleAuditor",
  "writerTools",
  "planThinkingBoost",
  "chapterEditorPass",
  "chapterEditAcceptance",
  "manuscriptReadPass",
  "bookDevelopment",
  "caseEvidence",
  "developmentalEdit",
  "creativeContract",
  "materialFirst",
  "chapterApparatus",
  "figures",
  "chapterFocus",
  "manuscriptReadCuts",
  "wideSourceGathering",
  "chapterFactLedger",
  "briefCoverageReview"
] as const;

export type QualityFeatureId = (typeof QUALITY_FEATURE_IDS)[number];

/**
 * Gates deleted from the table that a stored revision may still carry. They
 * control nothing: `parseQualityFeatureSettings` ignores them like any unknown
 * id, and the API leaves them out of what it serves and of every revision it
 * writes, so the console never draws them as a newer server's gate.
 * `coupletRewrite` was retired on 2026-09-06 and had no reader left. The E4
 * review audit (2026-10-16, `.scratch/eval-data/reports/e4-review-audit.md`)
 * removed four more on every tier under the owner's rule — a review, edit or
 * critic that improves books by 5–10% or not at all is deleted, not kept on
 * Premium or Ultra unmeasured — and their code with them: `planCritic` (blind
 * readers preferred the book without its patch, 2 wins / 3 ties / 8 losses),
 * `bestOfPolish` (the judge's pick against the draft without best-of, 5/8/6),
 * `formPlanRepair` (repaired vs rotation-only form plan, 4/4/9) and
 * `proseArithmeticCheck` (a defect screen that fixed a real error in 0 of 48
 * books).
 * The E5 sweep (2026-10-16, `.scratch/eval-data/reports/e5-final-review-sweep.md`)
 * removed two more: `pageMapCritic` (the critic that patched a page map before
 * drafting; the short book drafted from its patched map against the one drafted
 * from the map it was handed, 5 wins / 7 ties / 6 losses over 41 books) and
 * `beatDedup` (a checkbox no code read: the collision rewrite it was named for
 * is mandatory map integrity and always runs). `claimVerifier` and
 * `claimRetrieve`, shelved since 2026-09-30, went with the per-page review chain
 * that was their only reader: no generated page is model-reviewed on any tier
 * since E5, so neither could switch anything any more.
 * E6 (2026-10-16, `.scratch/eval-data/reports/e6-story-memory.md`) removed
 * `storyExtractAudit` — story memory, the per-page extract later pages read as
 * the book's story state — after a continuation drafted with it lost to the same
 * continuation drafted from the plan's promises alone, 7 wins / 4 ties / 10
 * losses (stopped at 21 of 30 pairs), and `storyNotesTogether`, which only
 * scheduled those extracts.
 */
export const REMOVED_QUALITY_FEATURE_IDS: readonly string[] = [
  "coupletRewrite", "planCritic", "bestOfPolish", "formPlanRepair", "proseArithmeticCheck",
  "pageMapCritic", "beatDedup", "claimVerifier", "claimRetrieve", "storyExtractAudit", "storyNotesTogether"
];

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
  // These three, and `styleAuditor`, switch a reader's chat page rewrite only
  // (its review → revise loop): no generated page is model-reviewed, rewritten,
  // unslopped or style-audited on any tier since 2026-10-16 (E4 short books, E5
  // every other page generation drafts). `pageQaRewrite` also switches the
  // compile's scoped repair and a composed page's integrity revise.
  smartUnslop: ["ultra", "premium", "balanced", "fast"],
  pageModelReview: ["ultra", "premium", "balanced", "fast"],
  pageQaRewrite: ["ultra", "premium", "balanced", "fast"],
  // The defect screen: the compile's one review, on every tier, over the books it was measured on
  // (`usesCompileDefectScreen` in the worker). It fixed a real reader-visible defect in 23% of Quick Draft
  // books and 36% of Balanced composed ones (H7), and in 2 of 17 Quick Draft short-book drafts with 4 of 4
  // repairs preferred, while on 13 Balanced short-book drafts it found nothing (H7b, 2026-10-16). The
  // owner's bar: a model defect screen stays only where it fixes such a defect in at least 10% of books.
  finalBookQa: ["ultra", "premium", "balanced", "fast"],
  // Claim and source verification is off by default on every tier (2026-09-30:
  // best-looking books over token-spending checks; see SOURCE_CLAIM_REVIEW in
  // apps/worker/src/generation/sourceClaimState.ts). Shelved: the console offers
  // no tier boxes. It rechecks a reader's chat page rewrite only.
  changedCandidateGrounding: [],
  compactPageDraftContext: ["balanced", "fast"],
  styleExcerpts: ["ultra", "premium", "balanced", "fast"],
  styleAuditor: ["ultra", "premium", "balanced"],
  writerTools: ["ultra"],
  planThinkingBoost: [],
  // Retired 2026-10-16 with the composed line edit it switched (see its
  // description): `qualityFeatureEnabled` answers false whatever a stored
  // revision lists, so this default only fills the key a revision may lack.
  chapterEditorPass: [],
  // Composed chapters: the whole-chapter review of a repair's factual
  // correction and of the manuscript read's cuts. Quick Draft trades it for
  // speed (Parsa, 2026-09-30): 7–30 s of a chapter's finish.
  chapterEditAcceptance: ["ultra", "premium", "balanced"],
  // Off on every tier (2026-10-16): a stage that moves a book by under 5–10% is
  // removed (the owner's rule), and E3 measured Balanced's read and cuts
  // changing 0.75% of a book's words in 20 of 37 books, 2–8 minutes after the
  // last chapter. The owner declined to keep it on Premium and Ultra unmeasured:
  // a critic that does not help one writer is not kept for another in case.
  manuscriptReadPass: [],
  // The September 5 live experiment regressed quality and runtime. These
  // stages require an explicit opt-in; older settings must not enable them.
  // Shelved in the console, like chapterFocus below.
  bookDevelopment: [],
  caseEvidence: [],
  developmentalEdit: [],
  // The 2026-09-03 quality ladder (opinion-fable-5). Off everywhere until a
  // rung is measured; each is a content or contract change, not a gate.
  // creativeContract is measured: with claim review off it reaches nonfiction
  // too, and on Quick Draft books it won 12 of 12 blind pairwise readings
  // against the grounded contract and the pre-audit pipeline (2026-09-30).
  creativeContract: ["ultra", "premium", "balanced", "fast"],
  materialFirst: [],
  chapterApparatus: [],
  // No model call of its own: the form plan assigns the figure inside its
  // one call, the writer emits the block, the exporters draw it.
  figures: ["ultra", "premium", "balanced", "fast"],
  // The 2026-09-06 fresh-plan measurement: rung 5 (no focus, told opening
  // scenes) read 7.63 against 6.87–7.10 for every focused book, and the
  // read's cut is affordable only where the book has room over its floor.
  // Off everywhere; the live revision opts in.
  chapterFocus: [],
  // Needs the read, which Quick Draft and Balanced no longer make by default.
  manuscriptReadCuts: [],
  // Scheduling only, no prose changes: six chapters' sources gathered at once
  // instead of three.
  wideSourceGathering: ["fast"],
  // One short call per chapter; the next chapter's compose waits for it (2.5–4.7 s measured). Every
  // Quick Draft book of 2026-09-30 contradicted an earlier chapter's names, dates or figures.
  chapterFactLedger: ["ultra", "premium", "balanced", "fast"],
  // The compile's read of the finished book against the brief: 26–67 s after
  // the last chapter, on the critical path. On the 2026-09-30 Quick Draft
  // books it marked every requirement fulfilled, gaps the blind readers named
  // included. Quick Draft skips it for speed (Parsa, 2026-10-01), and since
  // 2026-10-15 no tier does: on Balanced it was 43–77 s of the compile, its
  // findings are console diagnostics only, and labelled they were real 27%
  // (MISSING_BRIEF_REQUIREMENT) and 40% (UNPAID_PROMISE) of the time. The owner
  // declined to keep it on Premium and Ultra unmeasured (2026-10-16). The
  // brief's asks still reach the form plan through the inventory.
  briefCoverageReview: []
};

export type QualityFeatureDescription = {
  id: QualityFeatureId;
  label: string;
  summary: string;
  /** Saved revisions may retain this key, but it no longer controls a pipeline. */
  retired?: boolean;
  /**
   * Measured and off on every tier, its code kept for a later experiment. The
   * console lists it apart and offers no tier boxes. A stored tier list still
   * runs, because a revision is how an experiment opts one in
   * (`scripts/dev-set-quality.ts`), so the console shows any it finds.
   */
  shelved?: boolean;
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
    summary: "A reader's chat page rewrite only: finds significant deterministic slop candidates and, when Page QA rewrites is on, asks for a contextual minimal rewrite or an unchanged page. No generated page is rewritten for slop since 2026-10-16.",
    pipelines: ["per-page", "composed"],
    stage: "Chat page rewrite"
  },
  {
    id: "pageModelReview",
    label: "Model page review",
    summary: "Reviews a page a reader asked the chat to rewrite. No generated page is model-reviewed on any tier since 2026-10-16: the per-page chain lost to the raw draft 3 wins / 7 ties / 7 losses (E4), and E5 took it off every page generation drafts, continuations, inserts and replans included.",
    pipelines: ["per-page", "composed"],
    stage: "Chat page rewrite"
  },
  {
    id: "pageQaRewrite",
    label: "Page QA rewrites",
    summary: "Revises a page that failed: a reader's chat page rewrite after its review, a composed page whose integrity checks found a prompt leak or a placeholder, and the compile's scoped repair of what the defect screen proved. No generated page is rewritten over a review since 2026-10-16. Off keeps the draft.",
    pipelines: ["per-page", "composed"],
    stage: "Page repairs"
  },
  {
    id: "finalBookQa",
    label: "Defect screen",
    summary: "The compile's one review: a concrete-defect screen of the whole book (contradictions, wrong arithmetic, duplicated or unfinished passages, leaked notes) and a scoped repair of at most three pages with one verification. It runs on every Quick Draft book and on every book composed by chapters; a short or per-page book on Balanced, Premium or Ultra is printed as drafted, because the screen found nothing to fix in those drafts. Deterministic manuscript checks always run.",
    pipelines: ["per-page", "composed"],
    stage: "Compile"
  },
  {
    id: "changedCandidateGrounding",
    shelved: true,
    label: "Changed candidate grounding",
    summary: "Checks the changed factual candidates of a reader's chat page rewrite against supplied research and source passages; repairs stay within the rewrite's budget. Off skips this recheck only.",
    pipelines: ["per-page", "composed"],
    stage: "Chat page rewrite"
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
    summary: "One cheap mechanical call comparing a reader's chat page rewrite to the pinned excerpts and voice guide. No generated page is style-audited since 2026-10-16.",
    pipelines: ["per-page", "composed"],
    stage: "Chat page rewrite"
  },
  {
    id: "writerTools",
    label: "Writer tools",
    summary: "Ultra-only tool loop (lookup page / entity / research) with at most two tool rounds plus a finish.",
    pipelines: ["per-page"],
    stage: "Page draft"
  },
  {
    id: "planThinkingBoost",
    retired: true,
    label: "Deeper plan thinking (retired)",
    summary: "Reasoning is controlled by the saved model settings for each stage. Tier-based boosts are no longer applied.",
    pipelines: [],
    stage: "Plan"
  },
  {
    id: "chapterEditorPass",
    retired: true,
    label: "Chapter line edit (removed)",
    summary: "Removed 2026-10-16: a composed chapter is printed as drafted, with no line-edit call and no review of one, on every tier. Blind readers preferred the draft to the edited chapter: fiction 6 wins, 11 ties, 13 losses for the edit; nonfiction 15/26/9, a tie; Quick Draft guides and workbooks 1/7/16, the edit adding recaps and restatements; Balanced ones 8/5/11 even with each change judged on its own. Repairs and cuts still run.",
    pipelines: [],
    stage: "Chapter edit"
  },
  {
    id: "chapterEditAcceptance",
    label: "Chapter repair and cut acceptance",
    summary: "One contextual review of a composed chapter's arithmetic or evidence repair, judged against its computation or passages, and of each deletion-only cut the manuscript read makes; a change it does not pass keeps the original and its findings. Off keeps every repair and cut unreviewed. There is no line edit to review since 2026-10-16.",
    pipelines: ["composed"],
    stage: "Chapter repairs"
  },
  {
    id: "manuscriptReadPass",
    label: "Whole-manuscript read (composed chapters)",
    summary: "One read of the finished book returning per-chapter notes, which the console shows and the read's cuts act on. Off on every tier since 2026-10-16: with its cuts it changed 0.75% of a Balanced book's words, in 20 of 37 books, for 2–8 minutes after the last chapter, under the 5–10% a stage has to move a book by.",
    pipelines: ["composed"],
    stage: "Manuscript read"
  },
  {
    id: "bookDevelopment", shelved: true, label: "Research-led book planning",
    summary: "Before a new nonfiction manuscript starts, redesigns chapter count, order and scope while checking requested coverage and distinct contributions. Requires reviewed case evidence even if that separate gate is off. Stored plans resume unchanged.",
    pipelines: ["composed"], stage: "Book development"
  },
  {
    id: "caseEvidence", shelved: true, label: "Evidence for major cases",
    summary: "Builds and independently checks case claims against retrieved passages, retries missing research, and checks the resulting prose before publication.",
    pipelines: ["composed"], stage: "Case evidence"
  },
  {
    id: "developmentalEdit", shelved: true, label: "Developmental manuscript edit",
    summary: "A bounded edit of overlapping sections across nonfiction chapters, with source-backed replacements, coordinated moves and a whole-book word budget before the final line edit; replaces the legacy notes-only read for these runs.",
    pipelines: ["composed"], stage: "Developmental edit"
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
    summary: "Inert for a real book: a book its author stance says is written from sources plans its episodes and gathers a dossier on every tier, and any other book gathers nothing either way. Only a MOCK_AI run reads it, where it lets a sourced book plan fake episodes and query the live catalogues.",
    pipelines: ["composed"],
    stage: "Compose chapter"
  },
  {
    id: "chapterApparatus",
    label: "Chapter epigraphs from the dossier (composed chapters)",
    summary: "Sets a verbatim, attributed epigraph from the chapter's primary-source dossier at the head of each chapter that has one, and lets no two consecutive chapters open on a told scene. No model call; needs a dossier, which only a book written from sources gathers.",
    pipelines: ["composed"],
    stage: "Paginate and describe"
  },
  {
    id: "figures",
    label: "Figures: charts and flow diagrams (composed chapters)",
    summary: "Lets the form plan place one bar, line or pie chart or one flow diagram in up to three chapters in four of an analytical, instructional or reference book; the writer emits a fenced figure block and the exporters draw it. No extra model call.",
    pipelines: ["composed"],
    stage: "Chapter form plan"
  },
  {
    id: "chapterFocus",
    shelved: true,
    label: "Chapter focus: per-chapter question and investigation (composed chapters)",
    summary: "The episode planner also plans a question, investigation list and contribution per chapter, and the writer composes from them with the strict reconstruction rule and no separate scene call; off, the chapter is composed the rung-5 way from the stance and its episodes, with a told opening scene where the material has one. No extra model call either way.",
    pipelines: ["composed"],
    stage: "Compose chapter"
  },
  {
    id: "manuscriptReadCuts",
    label: "Manuscript read cuts (composed chapters)",
    summary: "Flagged chapters get one deletion-only cut call. Every kept sentence must be verbatim, at most 25% may be removed, and the chapter must stay above its page floor. The chapter semantic acceptance gate checks meaning and cut intent when enabled. Needs the manuscript read.",
    pipelines: ["composed"],
    stage: "Manuscript read"
  },
  {
    id: "wideSourceGathering",
    label: "Gather six chapters' sources at once (composed chapters)",
    summary: "The dossier searches, fetches and extracts six chapters at a time instead of three, so the first chapter starts sooner. More load on the catalogue hosts at once; same calls.",
    pipelines: ["composed"],
    stage: "Compose chapter"
  },
  {
    id: "chapterFactLedger",
    label: "Continuity ledger (composed chapters)",
    summary: "One short call reads each composed chapter for the people, relations, pronouns, dates, documents, marks and example figures it fixes; every later chapter's writer and editor keep to them. The next chapter waits for it, about 3 s.",
    pipelines: ["composed"],
    stage: "Compose chapter"
  },
  {
    id: "briefCoverageReview",
    label: "Final check against the brief",
    summary: "At compile, one model read of the finished book checks each explicit ask in the brief and each plan promise, and reports what it finds missing. 26–67 s on the critical path. Off, the compile records no coverage verdict and no warning, for a book either pipeline wrote; the brief's asks still reach the form plan while the chapters are written.",
    pipelines: ["per-page", "composed"],
    stage: "Compile"
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
  if (QUALITY_FEATURES.find((entry) => entry.id === feature)?.retired) return false;
  const resolved = settings ?? parseQualityFeatureSettings(undefined);
  const tiers = resolved[feature] ?? QUALITY_FEATURE_DEFAULTS[feature];
  return tiers.includes(modelTier);
}
