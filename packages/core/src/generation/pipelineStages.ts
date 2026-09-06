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
    purposes: ["plan-book", "revise-plan", "critique-plan", "plan-research", "chapter-research"],
    lane: "prose",
    calls: "1 plan, plus 1 critic when enabled, plus research queries",
    gates: ["planThinkingBoost", "planCritic"]
  }
];

export const PER_PAGE_STAGES: readonly PipelineStage[] = [
  {
    id: "page-map",
    label: "Page map",
    summary: "One brief per page: purpose, beat, ending pressure, evidence anchors. Integrity audits and collision repair are mandatory.",
    purposes: ["generate-page-map", "generate-chapter-brief", "critique-page-map", "dedupe-page-beats"],
    lane: "mechanical",
    calls: "1 map or 1 brief per chapter, plus repairs",
    gates: ["pageMapCritic", "beatDedup"]
  },
  {
    id: "page-draft",
    label: "Page draft",
    summary: "Each page is written on its own from its brief, the recency window and the style lock.",
    purposes: ["generate-page", "generate-chapter-draft", "generate-page-batch", "generate-whole-book", "write-page-with-tools", "polish-page", "judge-page-drafts"],
    lane: "prose",
    calls: "1 per page, up to 3 candidates on page 1",
    gates: ["compactPageDraftContext", "styleExcerpts", "writerTools", "bestOfPolish"]
  },
  {
    id: "page-review",
    label: "Page review and rewrite",
    summary: "Local checks, then the model reviewer, then up to the tier's rewrite budget per page.",
    purposes: ["review-page", "revise-page", "repair-page-brief", "verify-page-claims", "audit-page-style"],
    lane: "mixed",
    calls: "1 review per page, plus 2 to 10 rewrites per failing page by tier",
    gates: ["pageLocalQa", "smartUnslop", "pageModelReview", "pageQaRewrite", "claimVerifier", "styleAuditor", "claimRetrieve", "storyExtractAudit"]
  },
  {
    id: "compile",
    label: "Compile and final QA",
    summary: "Whole-book QA, chapter-transition review, page repair loop, deterministic manuscript audit, then render.",
    purposes: ["final-book-qa", "book.final_qa.chapter_transitions", "review-manuscript-structure", "chapterize-export"],
    lane: "mechanical",
    calls: "1 to 3 reviews, plus rewrites for flagged pages",
    gates: ["finalBookQa"]
  }
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
    summary: "After research-led replanning when enabled, every chapter gets 3 to 8 sections with a form from the palette and one landing. Variety is checked deterministically; one repair call, then rotation.",
    purposes: ["plan-chapter-forms", "architect-book", "develop-book-plan", "review-book-development"],
    lane: "prose",
    calls: "1 form plan plus at most 1 repair; research-led development adds up to 2 proposals and 2 reviews",
    gates: ["figures", "bookDevelopment"]
  },
  {
    id: "compose",
    label: "Compose chapter",
    summary: "A continuous chapter from the stance, form plan, prior chapters and researched cases. Evidence-required runs extract and review case claims from source passages before drafting, then check the written claims.",
    purposes: ["compose-chapter", "judge-chapter-drafts", "plan-episodes", "case-source-search", "extract-excerpts", "compose-scene", "build-case-evidence", "verify-case-evidence", "review-chapter-evidence"],
    lane: "prose",
    calls: "1 draft per chapter, up to 1 length retry; evidence adds extraction, packet reviews and prose checks, with bounded research retries",
    gates: ["creativeContract", "materialFirst", "caseEvidence", "chapterFocus"]
  },
  {
    id: "edit",
    label: "Line edit",
    summary: "A chapter line edit after developmental changes when enabled, with no automatic padding. Legacy runs retain their original chapter edit order.",
    purposes: ["edit-chapter", "rewrite-couplets"],
    lane: "prose",
    calls: "1 per chapter",
    gates: ["chapterEditorPass", "coupletRewrite"]
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
    summary: "For nonfiction, bounded section deletions, moves and rewrites across chapters within a whole-book word budget. When developmental editing is off, the legacy read returns notes.",
    purposes: ["read-manuscript", "cut-chapter", "rewrite-seams", "plan-developmental-edit", "rewrite-developmental-sections"],
    lane: "prose",
    calls: "1 full-text proposal plus up to 6 linked section rewrites; final line edits and descriptions run per chapter",
    gates: ["manuscriptReadPass", "manuscriptReadCuts", "developmentalEdit"]
  },
  {
    id: "finalize",
    label: "Finalize pages",
    summary: "Deterministic local checks only, one revise on a leak or placeholder, then the staged publication with illustrations and story state.",
    purposes: ["revise-page", "extract-story-state"],
    lane: "mixed",
    calls: "0 or 1 revise per failing page",
    gates: ["pageLocalQa", "smartUnslop", "pageQaRewrite", "storyExtractAudit"]
  },
  {
    id: "compile",
    label: "Compile",
    summary: "Deterministic manuscript audit and targeted structural review, then render. The per-page final-QA repair loop is skipped.",
    purposes: ["review-manuscript-structure", "chapterize-export"],
    lane: "mechanical",
    calls: "0 or 1 structural review",
    gates: []
  }
];

export const GENERATION_PIPELINE_STAGES: Record<GenerationPipelineId, readonly PipelineStage[]> = {
  "per-page": PER_PAGE_STAGES,
  composed: COMPOSED_STAGES
};

/** Which pipeline a strategy's books are written by. */
export function pipelineForStrategy(strategy: Pick<BookGenerationStrategy, "executionMode">): GenerationPipelineId {
  return strategy.executionMode === "composed-chapters" ? "composed" : "per-page";
}
