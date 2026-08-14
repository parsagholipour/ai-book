import type { CompiledBookMarkdown, CompileMarkdownInput } from "../markdown.js";
import type { BookPageMapPlan, GenerateBookPdfOptions, GenerateBookPdfResult } from "../pdf.js";
import type { CreatePlanOptions, RevisePlanOptions } from "../planner.js";
import type {
  FinalBookQaOptions,
  GenerateBatchDraftOptions,
  GenerateChapterDraftOptions,
  GenerateChapterBriefOptions,
  GeneratedImageBytes,
  GenerateImageBytesOptions,
  GeneratePageMapOptions,
  GeneratePageOptions,
  GenerateWholeBookOptions,
  PolishPageOptions,
  RepairPageBriefOptions,
  ReviewPageOptions,
  RevisePageOptions,
  WholeBookDraft
} from "../pages.js";
import type {
  BookPlan,
  ChapterBrief,
  CreateProjectInput,
  FinalBookQa,
  PageDraft,
  PageProductionBeat,
  PageQualityReport
} from "../../schemas/book.js";

export type BookGenerationExecutionMode =
  | "sequential-pages"
  | "whole-book"
  | "chapter-whole-pass"
  | "batch-window"
  | "draft-then-polish";

export type BookGenerationStrategy = {
  readonly id: string;
  readonly label: string;
  /** Overall output quality (1 = weakest, 10 = strongest). */
  readonly strengthScore: number;
  readonly recommendedPageRange: {
    readonly min: number;
    readonly max: number;
  };
  readonly executionMode: BookGenerationExecutionMode;
  readonly batchSize?: number | undefined;
  readonly researchDepth?: number | undefined;
  readonly createPlan: (options: CreatePlanOptions) => Promise<BookPlan>;
  readonly revisePlan: (options: RevisePlanOptions) => Promise<BookPlan>;
  readonly generateChapterBrief: (options: GenerateChapterBriefOptions) => Promise<ChapterBrief>;
  readonly createChapterBriefs?: (options: GeneratePageMapOptions) => Promise<ChapterBrief[]>;
  readonly generateWholeBookDraft?: (options: GenerateWholeBookOptions) => Promise<WholeBookDraft>;
  readonly generateChapterDraft?: (options: GenerateChapterDraftOptions) => Promise<WholeBookDraft>;
  readonly generateBatchDraft?: (options: GenerateBatchDraftOptions) => Promise<WholeBookDraft>;
  readonly generatePageDraft: (options: GeneratePageOptions) => Promise<PageDraft>;
  readonly polishPageDraft?: (options: PolishPageOptions) => Promise<PageDraft>;
  readonly reviewPageDraft: (options: ReviewPageOptions) => Promise<PageQualityReport>;
  readonly repairPageBrief: (options: RepairPageBriefOptions) => Promise<PageProductionBeat>;
  readonly revisePageDraft: (options: RevisePageOptions) => Promise<PageDraft>;
  readonly runFinalBookQa: (options: FinalBookQaOptions) => Promise<FinalBookQa>;
  readonly shouldIllustratePage: (input: CreateProjectInput, plan: BookPlan, pageIndex: number) => boolean;
  readonly generateImageBytes: (options: GenerateImageBytesOptions) => Promise<GeneratedImageBytes>;
  readonly compileMarkdown: (input: CompileMarkdownInput) => string;
  /** Same compile, plus the per-page anchor plan the PDF page map is measured from. */
  readonly compileMarkdownWithPageAnchors: (input: CompileMarkdownInput) => CompiledBookMarkdown;
  readonly generatePdf: (markdown: string, options: GenerateBookPdfOptions) => Promise<Buffer>;
  /** Same render; with a `pageMapPlan` it also measures where each model page landed. */
  readonly generatePdfWithPageMap: (
    markdown: string,
    options: GenerateBookPdfOptions & { pageMapPlan?: BookPageMapPlan | undefined }
  ) => Promise<GenerateBookPdfResult>;
};
