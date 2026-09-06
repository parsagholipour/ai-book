/**
 * The compiled export formats, and what each one is.
 *
 * Every list that enumerates a book's downloadable files derives from this one:
 * the scratch-file sweep's extensions, the provenance sidecars, the worker's
 * pending paths and artifact publications, the mobile DTO, the repair priority,
 * the compile step labels. They used to be spelled `"pdf" | "epub"` in a dozen
 * places that did not typecheck against each other, and adding the Word export
 * meant finding all of them. Now a new format is one entry here plus a renderer.
 *
 * Deliberately import-free: `exportTempSweep.ts` and `exportProvenance.ts` sit
 * beneath everything else in this directory and must stay cheap to load.
 */

export const EXPORT_FORMATS = ["pdf", "epub", "docx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * The best-effort formats. A compile publishes without them: a companion that
 * fails to render records a warning issue on the quality report and retires its
 * predecessor, and the export-repair lane rebuilds it on demand. The PDF is not
 * one of these — it is the book.
 */
export const COMPANION_EXPORT_FORMATS = ["epub", "docx"] as const;
export type CompanionExportFormat = (typeof COMPANION_EXPORT_FORMATS)[number];

type ExportFormatSpec = {
  readonly contentType: string;
  /** The reader-facing name of the format, for filenames and labels. */
  readonly label: string;
  /**
   * True when the download is gated on an active plan. The subscription gates
   * the *format*; the per-book export unlock gates the *book*, and applies to
   * every format alike.
   */
  readonly requiresSubscription: boolean;
};

const EXPORT_FORMAT_SPECS: Record<ExportFormat, ExportFormatSpec> = {
  pdf: { contentType: "application/pdf", label: "PDF", requiresSubscription: false },
  epub: { contentType: "application/epub+zip", label: "EPUB", requiresSubscription: false },
  docx: {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word",
    requiresSubscription: true
  }
};

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value);
}

export function isCompanionExportFormat(format: ExportFormat | null | undefined): format is CompanionExportFormat {
  return format !== null && format !== undefined && (COMPANION_EXPORT_FORMATS as readonly string[]).includes(format);
}

/** The published name of an export inside its project directory. */
export function publishedExportFilename(format: ExportFormat): string {
  return `book.${format}`;
}

export function exportContentType(format: ExportFormat): string {
  return EXPORT_FORMAT_SPECS[format].contentType;
}

export function exportFormatLabel(format: ExportFormat): string {
  return EXPORT_FORMAT_SPECS[format].label;
}

export function exportRequiresSubscription(format: ExportFormat): boolean {
  return EXPORT_FORMAT_SPECS[format].requiresSubscription;
}

/**
 * The quality-report issue code a compile records when a companion format
 * fails to render. `EPUB_EXPORT_FAILED` predates this registry and is read back
 * by the mobile serializers, so the spelling is the format upper-cased and
 * nothing cleverer.
 */
export function companionExportFailedIssueCode(format: CompanionExportFormat): string {
  return `${format.toUpperCase()}_EXPORT_FAILED`;
}
