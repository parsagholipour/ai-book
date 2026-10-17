import { writeFile } from "node:fs/promises";
import {
  assertBookLikeMarkdown,
  chapterHeadingLabelPreference,
  chapterHeadingStylePreference,
  includeSourcesPreference,
  markdownOpensOnCoverSheet,
  publicAssetUrl,
  storyPageDesignFor,
  storyPageLayoutFor,
  type BookGenerationStrategy,
  type BookPlan,
  type CompileMarkdownInput,
  type CompiledBookMarkdown,
  type CreateProjectInput,
  type ExportFormat,
  type PersistableBookPdfPageMap,
  type PrintedSheets,
  printedSheetsFor
} from "@book-maker/core";
import { bookMatterForExport, researchCitationsForExport } from "@book-maker/db";
import { config } from "../runtime/config.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import type { PendingExportPaths } from "../generation/exportArtifacts.js";
import type { CompileExportJob } from "../runtime/jobPayloads.js";
import { pdfPageMapAfterCompileRender } from "./compilePdfPageMap.js";

export type RenderedCompile = {
  markdown: string;
  compiled: CompiledBookMarkdown | undefined;
  repairReconstructedMarkdown: boolean;
  pdfPageMapUpdate: PersistableBookPdfPageMap | undefined;
  /**
   * The paid pages this PDF printed, as the render measured them
   * (`printedSheetsFor`): what decides the reader's one length finding,
   * `BOOK_PRINTED_SHORT`. Undefined when nothing comparable was measured.
   */
  printedSheets: PrintedSheets | undefined;
};

/**
 * The book's bytes in scratch: its Markdown, and its PDF with the page map
 * measured from it. Nothing here reads the compile's verdict, which is why
 * `compileExport` starts this beside the brief-coverage read and the structural
 * review instead of after them, and settles the verdict first: a failure here
 * is consulted only once the report is recorded and the supersede read has
 * answered, the order the serial code observed it in. Companion formats render
 * after the verdict, because a companion failure is appended to its report.
 */
export async function renderCompiledBook(options: {
  job: CompileExportJob;
  projectId: string;
  generationJobId: string;
  project: Parameters<typeof bookMatterForExport>[0] & {
    research: Parameters<typeof researchCitationsForExport>[0];
    mediaSettings: unknown; prompt: string; authorName: string | null;
  };
  plan: BookPlan;
  input: CreateProjectInput;
  strategy: BookGenerationStrategy;
  authorManuscript: boolean;
  pages: CompileMarkdownInput["pages"];
  readerChapters: CompileMarkdownInput["readerChapters"];
  cover: { path: string } | undefined;
  detachedRepair: boolean;
  publishedMarkdown: string | undefined;
  repairFormat: ExportFormat | null;
  pdfTargetPageCount: number | undefined;
  pending: PendingExportPaths;
  finalization: { phase(phase: "render"): Promise<void> } | null;
}): Promise<RenderedCompile> {
  const { projectId, generationJobId, project, plan, input, strategy, authorManuscript, cover, detachedRepair, publishedMarkdown, repairFormat, pending } = options;
  await advanceJobStep(generationJobId, "compile", 55);
  await options.finalization?.phase("render");
  await updateJobProgress(generationJobId, {
    progress: 62,
    message: "Placing reader chapters"
  });
  const compileCurrentMarkdown = async (): Promise<CompiledBookMarkdown> => {
    const researchSources = await researchCitationsForExport(project.research);
    return strategy.compileMarkdownWithPageAnchors({
      plan,
      storyPageLayout: storyPageLayoutFor(input, options.pages),
      // The row's preference and prompt, never the plan's snapshot: changing the
      // design is a live preference that only queues a recompile, and the API's
      // inline rebuild resolves it from the same row.
      storyPageDesign: storyPageDesignFor({
        mediaSettings: project.mediaSettings,
        category: input.category,
        prompt: project.prompt,
        plan
      }),
      authorManuscript,
      category: input.category,
      language: input.language,
      readerChapters: options.readerChapters,
      ...(cover
        ? {
            cover: {
              imagePath: publicAssetUrl(config.PUBLIC_API_URL, cover.path),
              imageAlt: `Cover for ${plan.title}`
            }
          }
        : {}),
      pages: options.pages,
      researchSources,
      // From the project row rather than `input`, whose mediaSettings come from
      // the plan's frozen snapshot: dropping the Sources list or restyling the
      // chapter headings is a live reader preference that only queues a recompile.
      ...(project.authorName ? { authorName: project.authorName } : {}),
      matter: await bookMatterForExport(project),
      includeSources: includeSourcesPreference(project.mediaSettings),
      chapterHeadingStyle: chapterHeadingStylePreference(project.mediaSettings),
      chapterHeadingLabel: chapterHeadingLabelPreference(project.mediaSettings)
    });
  };
  // The exact published manuscript remains the repair source whenever it is
  // available. User edits intentionally invalidate it before queueing their
  // compile, though, and both queue failure and a `not-ready` fan-in hand the
  // resulting COMPLETE + missing-files state to this detached lane. Refusing to
  // reconstruct there made every status poll enqueue another repair that could
  // never succeed. The fallback is built solely from this revision's durable
  // project rows, without QA/model calls, and is installed with the derivative
  // below so subsequent repairs are exact again.
  const repairReconstructedMarkdown = detachedRepair && publishedMarkdown === undefined;
  // A repair publishes the exact published `book.md`, whose bytes carry no
  // anchor offsets — but a free deterministic recompile (no model call: the
  // published Contents pins the chapter partition, and `allowModelCall` is off)
  // routinely reproduces those bytes exactly. When it does, its anchor plan is
  // honest for the published manuscript and the repair renders measured — the
  // printed Contents keeps its measured numbers instead of regressing to model
  // indexes. When it does not, the exact published bytes win, unmeasured: no
  // markers, no Contents reprint. That is a different Chromium pass than the
  // one the stored map was measured from (the reprint exists because digit
  // width moves breaks), so the stored ranges give way to a cover-skip stub —
  // chrome keeps the footer numbering, chat drops back to model indexes. A book
  // chat cannot translate is the graceful path; a map from a different
  // pagination is the wrong-page edit the map exists to stop.
  const recompiled = await compileCurrentMarkdown();
  const compiled =
    detachedRepair && publishedMarkdown !== undefined && recompiled.markdown !== publishedMarkdown
      ? undefined
      : recompiled;
  const markdown = compiled ? compiled.markdown : publishedMarkdown;
  if (markdown === undefined) {
    throw new Error("Export compile produced no manuscript");
  }
  assertBookLikeMarkdown(markdown, { authorManuscript });
  await advanceJobStep(generationJobId, "write", 80);
  // Render in scoped local scratch. Only the final revision claim permits
  // publishing these bytes to the project’s durable object keys.
  if (repairFormat === null || repairReconstructedMarkdown) {
    await writeFile(pending.markdown, markdown, "utf8");
  }
  let pdfPageMapUpdate: PersistableBookPdfPageMap | undefined;
  let printedSheets: PrintedSheets | undefined;
  if (repairFormat === null || repairFormat === "pdf") {
    await advanceJobStep(generationJobId, "pdf", 88);
    const pdfResult = await strategy.generatePdfWithPageMap(markdown, {
      imageSource: "object-storage",
      publicApiUrl: config.PUBLIC_API_URL,
      outputPath: pending.pdf,
      documentTitle: plan.title,
      language: input.language,
      targetPageCount: options.pdfTargetPageCount,
      // Scopes the renderer's file access to this book's own illustrations.
      projectId,
      ...(compiled ? { pageMapPlan: compiled } : {})
    });
    // A complete measurement wins. Every failed or plan-less measurement
    // replaces stored ranges with cover numbering for these newly rendered
    // bytes: matching manuscript text does not prove matching pagination.
    pdfPageMapUpdate = await pdfPageMapAfterCompileRender(options.job, pdfResult, {
      planned: compiled !== undefined,
      hasCoverPage: compiled?.hasCoverPage ?? markdownOpensOnCoverSheet(markdown)
    });
    printedSheets = printedSheetsFor({
      paidPages: options.pdfTargetPageCount,
      separateStoryLayout: compiled?.storyPageLayout === "separate",
      pagination: pdfResult.pagination,
      pageMap: pdfResult.pageMap
    });
  }
  return { markdown, compiled, repairReconstructedMarkdown, pdfPageMapUpdate, printedSheets };
}
