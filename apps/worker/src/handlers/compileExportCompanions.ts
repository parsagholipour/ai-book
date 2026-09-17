import {
  COMPANION_EXPORT_FORMATS,
  appendQualityIssue,
  companionExportFailedIssueCode,
  generateBookDocx,
  generateBookEpub,
  isCompanionExportFormat,
  type CompanionExportFormat,
  type ExportRepairFormat,
  type ManuscriptQualityReport
} from "@book-maker/core";
import { config } from "../runtime/config.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import {
  EVERY_COMPANION_PRODUCED,
  type CompanionsProduced,
  type PendingExportPaths
} from "../generation/exportArtifacts.js";
import { recordCompileQualityReport } from "./compileExportStandDown.js";

/**
 * The best-effort formats a compile renders beside the PDF.
 *
 * Neither may fail an export that already produced the markdown and PDF: a
 * render that fails twice is recorded as a warning on the quality report — so
 * the app shows the gap instead of a silently missing download — and the
 * publication retires that format's predecessor and its provenance, so an older
 * revision can never masquerade as this one. The repair lane rebuilds it later.
 */

type CompanionRenderer = {
  step: string;
  progress: number;
  render: (options: CompanionRenderInput) => Promise<unknown>;
  failureMessage: string;
  guidance: string;
  progressMessage: string;
};

type CompanionRenderInput = {
  markdown: string;
  outputPath: string;
  title: string;
  author: string | undefined;
  language: string | undefined;
  projectId: string;
};

const COMPANION_RENDERERS: Record<CompanionExportFormat, CompanionRenderer> = {
  epub: {
    step: "epub",
    progress: 95,
    render: (input) =>
      generateBookEpub(input.markdown, {
        title: input.title,
        ...(input.author ? { author: input.author } : {}),
        language: input.language,
        imageSource: "object-storage",
        publicApiUrl: config.PUBLIC_API_URL,
        outputPath: input.outputPath,
        // Scopes the illustrations this book may package to its own, the way the
        // PDF's renderer policy scopes what the render may read.
        projectId: input.projectId
      }),
    failureMessage: "EPUB export failed; PDF and markdown are available.",
    guidance: "Download the PDF, or re-run the export to retry the EPUB.",
    progressMessage: "EPUB export failed; markdown and PDF were still produced."
  },
  docx: {
    step: "docx",
    progress: 98,
    render: (input) =>
      generateBookDocx(input.markdown, {
        title: input.title,
        ...(input.author ? { author: input.author } : {}),
        language: input.language,
        imageSource: "object-storage",
        publicApiUrl: config.PUBLIC_API_URL,
        outputPath: input.outputPath,
        projectId: input.projectId
      }),
    failureMessage: "Word export failed; PDF and EPUB are available.",
    guidance: "Download the PDF, or re-run the export to retry the Word file.",
    progressMessage: "Word export failed; markdown and PDF were still produced."
  }
};

/** Which companions a compile renders: all of them, or the one a repair asked for. */
export function companionFormatsToRender(repairFormat: ExportRepairFormat | null): CompanionExportFormat[] {
  if (repairFormat === null) {
    return [...COMPANION_EXPORT_FORMATS];
  }
  return isCompanionExportFormat(repairFormat) ? [repairFormat] : [];
}

export async function renderCompanionExports(options: {
  formats: readonly CompanionExportFormat[];
  markdown: string;
  pending: PendingExportPaths;
  projectId: string;
  generationJobId: string;
  title: string;
  author: string | null;
  language: string | undefined;
  qualityReport: ManuscriptQualityReport;
}): Promise<{ produced: CompanionsProduced; qualityReport: ManuscriptQualityReport }> {
  const produced: CompanionsProduced = { ...EVERY_COMPANION_PRODUCED };
  let qualityReport = options.qualityReport;
  for (const format of options.formats) {
    const renderer = COMPANION_RENDERERS[format];
    await advanceJobStep(options.generationJobId, renderer.step, renderer.progress);
    const input: CompanionRenderInput = {
      markdown: options.markdown,
      outputPath: options.pending[format],
      title: options.title,
      author: options.author ?? undefined,
      language: options.language,
      projectId: options.projectId
    };
    try {
      try {
        await renderer.render(input);
      } catch (error) {
        if (isStopRequestedError(error)) {
          throw error;
        }
        // Local conversion can fail transiently (e.g. resource pressure); one
        // plain retry before recording the failure.
        await renderer.render(input);
      }
    } catch (error) {
      if (isStopRequestedError(error)) {
        throw error;
      }
      produced[format] = false;
      console.error(`${format.toUpperCase()} generation failed for project ${options.projectId}:`, error);
      // Chained onto whatever an earlier companion appended, so two failures
      // keep both warnings.
      qualityReport = appendQualityIssue(qualityReport, {
        code: companionExportFailedIssueCode(format),
        severity: "warning",
        source: "deterministic",
        message: renderer.failureMessage,
        guidance: renderer.guidance,
        affectedPageIndexes: []
      });
      await recordCompileQualityReport(options.generationJobId, qualityReport);
      await updateJobProgress(options.generationJobId, { message: renderer.progressMessage });
    }
  }
  return { produced, qualityReport };
}
