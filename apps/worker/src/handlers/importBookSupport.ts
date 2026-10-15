import {
  assessContentRestrictions,
  BOOK_MATTER_TEXT_FIELDS,
  jsonRecord,
  type BookMatter,
  type BookMatterTextField,
  type ContentRestrictionReason,
  type ManuscriptStyleProfile,
  type ParsedManuscript,
  type SegmentedManuscript
} from "@book-maker/core";

/**
 * Pure helpers for the IMPORT_BOOK job: turning a segmented manuscript into
 * Chapter/Page row shapes and import metadata. Kept free of database and
 * queue dependencies so they are directly unit-testable.
 */

export type ImportPageRow = {
  index: number;
  title: string;
  markdown: string;
  summary: string;
};

export type ImportChapterRow = {
  index: number;
  title: string;
  summary: string;
  targetPages: number;
  pages: ImportPageRow[];
};

/** Chapters/pages with global sequential page indexes starting at 1. */
export function importChapterRows(segmented: SegmentedManuscript): ImportChapterRow[] {
  let pageIndex = 0;
  return segmented.chapters.map((chapter, chapterOffset) => ({
    index: chapterOffset + 1,
    title: chapter.title,
    summary: chapter.summary,
    targetPages: chapter.pages.length,
    pages: chapter.pages.map((page) => {
      pageIndex += 1;
      return {
        index: pageIndex,
        title: page.title,
        markdown: page.markdown,
        summary: page.summary
      };
    })
  }));
}

export function importStats(
  parsed: ParsedManuscript,
  segmented: SegmentedManuscript
): Record<string, number | string> {
  return {
    charCount: parsed.charCount,
    wordCount: parsed.wordCount,
    chapterCount: segmented.chapters.length,
    pageCount: segmented.pageCount,
    segmentation: segmented.segmentation
  };
}

/**
 * Merges the distilled style profile into mediaSettings.mobile.import so
 * continuation and rewrites can match the author's voice later. Leaves every
 * other mediaSettings key untouched.
 */
export function mediaSettingsWithImportStyle(
  mediaSettings: unknown,
  style: ManuscriptStyleProfile
): Record<string, unknown> {
  const settings = jsonRecord(mediaSettings);
  const mobile = jsonRecord(settings.mobile);
  const importMeta = jsonRecord(mobile.import);
  return {
    ...settings,
    mobile: {
      ...mobile,
      import: {
        ...importMeta,
        styleProfile: style
      }
    }
  };
}

/**
 * The author's style profile: the one a completed import stored, or — for a
 * book written in the Writing Studio — the one its STYLE_PROFILE pass learned
 * (`mediaSettings.mobile.studio.styleProfile`), so a continuation writes in the
 * author's voice either way. The import's wins when both exist.
 */
export function importStyleProfileFromMediaSettings(mediaSettings: unknown): Record<string, unknown> | null {
  const mobile = jsonRecord(jsonRecord(mediaSettings).mobile);
  for (const source of [mobile.import, mobile.studio]) {
    const profile = jsonRecord(jsonRecord(source).styleProfile);
    if (Object.keys(profile).length > 0) {
      return profile;
    }
  }
  return null;
}

/** Detected language when usable, the project's existing language otherwise. */
export function normalizeImportedLanguage(detected: string | undefined, fallback: string): string {
  const cleaned = detected?.trim() ?? "";
  return cleaned.length >= 2 && cleaned.length <= 40 ? cleaned : fallback;
}

/** The byline, subtitle and matter a legacy import restores from the manuscript. */
export type RestoredImportMatter = { authorName?: string; subtitle?: string; bookMatter?: BookMatter };

/** A restored field the printed-text screen refused: which one and why, never its words. */
export type RefusedImportMatterField = {
  field: "authorName" | "subtitle" | BookMatterTextField;
  reason: ContentRestrictionReason;
};

/**
 * Screens a legacy import's restored matter one field at a time, as printed
 * text, and drops only the fields refused by their own words. The upload route
 * refuses such a file before anything exists, while the reader is there to fix
 * it; a queued legacy job has no one to answer, and its old import never lifted
 * this matter at all, so one objectionable line costs that line, not the book.
 * A dropped © holder falls back to the byline, which is what absence means.
 */
export function screenRestoredImportMatter(
  restored: RestoredImportMatter,
  copyrightRestrictionsEnabled: boolean
): { restored: RestoredImportMatter; refused: RefusedImportMatterField[] } {
  const refused: RefusedImportMatterField[] = [];
  const keeps = (field: RefusedImportMatterField["field"], value: string | undefined): value is string => {
    if (!value) return false;
    const assessment = assessContentRestrictions(value, { copyrightRestrictionsEnabled, printed: true });
    if (!assessment.allowed) refused.push({ field, reason: assessment.reason });
    return assessment.allowed;
  };
  const authorName = keeps("authorName", restored.authorName) ? restored.authorName : undefined;
  const subtitle = keeps("subtitle", restored.subtitle) ? restored.subtitle : undefined;
  const bookMatter: BookMatter = { ...restored.bookMatter };
  for (const field of BOOK_MATTER_TEXT_FIELDS) {
    if (bookMatter[field] !== undefined && !keeps(field, bookMatter[field])) delete bookMatter[field];
  }
  return {
    restored: {
      ...(authorName ? { authorName } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(Object.keys(bookMatter).length > 0 ? { bookMatter } : {})
    },
    refused
  };
}
