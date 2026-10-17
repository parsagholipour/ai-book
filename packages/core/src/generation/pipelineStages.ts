import type { QualityFeatureId, QualityPipeline } from "./qualityGates.js";
import type { BookGenerationStrategy } from "./strategies/types.js";

/**
 * The two generation pipelines as an operator reads them: each stage, the
 * provider purposes it spends under, which model lane those take, how many
 * calls a book costs there, and the Quality-tab gates that switch it. Served
 * to the console by `/api/admin/generation-quality` beside the gate rows, so
 * a checkbox can be shown next to the pipeline it actually reaches.
 */

export type PipelineStage = {
  id: string;
  label: string;
  summary: string;
  /** Provider-call purposes this stage logs under. */
  purposes: readonly string[];
  lane: "prose" | "mechanical" | "mixed" | "none";
  /** Calls per book, as a formula in words. */
  calls: string;
  /** Gates that turn this stage on, off, or change it. */
  gates: readonly QualityFeatureId[];
};

export type GenerationPipelineId = Exclude<QualityPipeline, "planning">;

export const PLANNING_STAGES: readonly PipelineStage[] = [
  {
    id: "plan",
    label: "Plan the book",
    summary: "Title, premise, chapters, characters, style contract, author stance. Runs before a strategy is chosen.",
    purposes: ["plan-book", "revise-plan", "plan-research", "chapter-research"],
    lane: "prose",
    calls: "1 plan, plus research queries; no plan critic since 2026-10-16",
    gates: []
  }
];

/**
 * A reader's chat request to rewrite a page, on a book either pipeline wrote:
 * the only page that is still model-reviewed, revised, unslopped and
 * style-audited since 2026-10-16 (E4, E5). Listed in both pipelines because its
 * gates reach both pipelines' books.
 */
const CHAT_PAGE_REWRITE_STAGE: PipelineStage = {
  id: "chat-page-rewrite",
  label: "Chat page rewrite",
  summary: "After the book is finished: a page the reader asked the chat to rewrite is reviewed, revised within a small budget, unslopped and style-audited. No generated page goes through this.",
  purposes: ["review-page", "revise-page", "audit-page-style", "screen-changed-page-grounding"],
  lane: "mixed",
  calls: "Per requested page: 1 review, at most 2 revisions, style audits on approved revisions",
  gates: ["pageModelReview", "pageQaRewrite", "smartUnslop", "styleAuditor", "changedCandidateGrounding"]
};

export const PER_PAGE_STAGES: readonly PipelineStage[] = [
  {
    id: "page-map",
    label: "Page map",
    summary: "One brief per page: purpose, beat, ending pressure, evidence anchors. Integrity audits and collision repair are mandatory; no critic patches the map since 2026-10-16.",
    purposes: ["generate-page-map", "generate-chapter-brief", "dedupe-page-beats"],
    lane: "mechanical",
    calls: "1 map or 1 brief per chapter, plus integrity repairs",
    gates: []
  },
  {
    id: "page-draft",
    label: "Page draft",
    summary: "Each page is written on its own from its brief, the recency window and the style lock, then checked by the deterministic local checks only and saved as drafted: no model review, rewrite, unslop or style audit since 2026-10-16 (E4 for short books, E5 for every other page, continuations, inserts and replans included), and no story-memory extract (E6).",
    purposes: ["generate-page", "generate-chapter-draft", "generate-page-batch", "generate-whole-book", "write-page-with-tools"],
    lane: "prose",
    calls: "1 per page; no polish, no best-of candidates and no page review since 2026-10-16",
    gates: ["compactPageDraftContext", "styleExcerpts", "writerTools", "pageLocalQa"]
  },
  {
    id: "compile",
    label: "Compile and defect screen",
    summary: "Quick Draft: the one defect screen over the whole book, a scoped repair of at most three pages, and a verification if repaired. Balanced, Premium and Ultra print a short or per-page book as drafted (since 2026-10-16). All run deterministic integrity checks; brief coverage only where a revision lists it.",
    purposes: ["final-book-qa", "patch-page", "inventory-brief-requirements", "read-manuscript", "chapterize-export"],
    lane: "mechanical",
    calls: "Quick Draft: 1 screen, at most 3 patches and 1 verification; other tiers: no model review",
    gates: ["briefCoverageReview", "finalBookQa"]
  },
  CHAT_PAGE_REWRITE_STAGE
];

export const COMPOSED_STAGES: readonly PipelineStage[] = [
  {
    id: "stance",
    label: "Author stance",
    summary: "Thesis, positions, refusals and a voice sample the writer imitates. Skipped when the plan already carries one.",
    purposes: ["author-stance"],
    lane: "prose",
    calls: "0 or 1 per book",
    gates: []
  },
  {
    id: "forms",
    label: "Chapter form plan",
    summary: "After research-led replanning when enabled, every chapter gets 3 to 8 sections with a form from the palette and one landing. Variety is checked deterministically and settled by rotation; there is no repair call since 2026-10-16.",
    purposes: ["plan-chapter-forms", "architect-book", "develop-book-plan", "review-book-development"],
    lane: "prose",
    calls: "1 form plan; research-led development adds up to 2 proposals and 2 reviews",
    gates: ["figures", "bookDevelopment"]
  },
  {
    id: "compose",
    label: "Compose chapter",
    summary: "A continuous chapter from the stance, form plan, prior chapters and researched cases. Evidence-required runs extract and review case claims from source passages before drafting, then check the written claims.",
    purposes: ["compose-chapter", "judge-chapter-drafts", "plan-episodes", "case-source-search", "extract-excerpts", "compose-scene", "build-case-evidence", "verify-case-evidence", "inventory-chapter-claims", "review-chapter-evidence", "extract-chapter-facts"],
    lane: "prose",
    calls: "1 draft per chapter, up to 1 length retry; evidence adds extraction, packet reviews and prose checks, with bounded research retries",
    gates: ["creativeContract", "materialFirst", "caseEvidence", "chapterFocus", "wideSourceGathering", "chapterFactLedger"]
  },
  {
    id: "edit",
    label: "Chapter repairs",
    summary: "No line edit since 2026-10-16: the draft is the chapter. A chapter whose delimited arithmetic code finds wrong gets a targeted factual correction through the editor, judged against the computation. No model reads the prose arithmetic since 2026-10-16.",
    purposes: ["edit-chapter", "review-chapter-edit-acceptance"],
    lane: "prose",
    calls: "up to 2 correction edits only where code finds a wrong number, each with 1 contextual acceptance review when enabled",
    gates: ["chapterEditAcceptance"]
  },
  {
    id: "describe",
    label: "Paginate and describe",
    summary: "Deterministic cut into the chapter's page count, then titles, summaries, continuity notes and image prompts for the cut pages.",
    purposes: ["describe-pages"],
    lane: "mechanical",
    calls: "1 per chapter",
    gates: ["chapterApparatus"]
  },
  {
    id: "read",
    label: "Manuscript read",
    summary: "Off on every tier by default (since 2026-10-16): one read of the finished book returns notes, and its cuts delete flagged passages. The shelved developmental edit replaces it with bounded section deletions, moves and rewrites within a whole-book word budget.",
    purposes: ["read-manuscript", "cut-chapter", "rewrite-seams", "plan-developmental-edit", "rewrite-developmental-sections", "review-chapter-edit-acceptance"],
    lane: "prose",
    calls: "1 full-text proposal plus up to 6 linked section rewrites; each changed cut gets 1 contextual acceptance review when enabled; descriptions run per chapter",
    gates: ["manuscriptReadPass", "manuscriptReadCuts", "developmentalEdit", "chapterEditAcceptance"]
  },
  {
    id: "finalize",
    label: "Finalize pages",
    summary: "Deterministic local checks only, one revise on a leak or placeholder, then the staged publication with illustrations.",
    purposes: ["revise-page"],
    lane: "mixed",
    calls: "0 or 1 revise per failing page",
    gates: ["pageLocalQa", "pageQaRewrite"]
  },
  {
    id: "compile",
    label: "Compile",
    summary: "Every tier: the one defect screen over the whole book, a scoped repair of at most three pages, and a verification if repaired. All run deterministic integrity checks; brief coverage only where a revision lists it.",
    purposes: ["final-book-qa", "patch-page", "inventory-brief-requirements", "read-manuscript", "chapterize-export"],
    lane: "mechanical",
    calls: "1 screen, at most 3 patches and 1 verification",
    gates: ["briefCoverageReview", "finalBookQa"]
  },
  CHAT_PAGE_REWRITE_STAGE
];

export const GENERATION_PIPELINE_STAGES: Record<GenerationPipelineId, readonly PipelineStage[]> = {
  "per-page": PER_PAGE_STAGES,
  composed: COMPOSED_STAGES
};

/** Which pipeline a strategy's books are written by. */
export function pipelineForStrategy(strategy: Pick<BookGenerationStrategy, "executionMode">): GenerationPipelineId {
  return strategy.executionMode === "composed-chapters" ? "composed" : "per-page";
}
