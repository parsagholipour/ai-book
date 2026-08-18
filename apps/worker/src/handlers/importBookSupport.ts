import {
  jsonRecord,
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

/** Style profile stored by a completed import, if any. */
export function importStyleProfileFromMediaSettings(mediaSettings: unknown): Record<string, unknown> | null {
  const profile = jsonRecord(jsonRecord(jsonRecord(jsonRecord(mediaSettings).mobile).import).styleProfile);
  return Object.keys(profile).length > 0 ? profile : null;
}

/** Detected language when usable, the project's existing language otherwise. */
export function normalizeImportedLanguage(detected: string | undefined, fallback: string): string {
  const cleaned = detected?.trim() ?? "";
  return cleaned.length >= 2 && cleaned.length <= 40 ? cleaned : fallback;
}
