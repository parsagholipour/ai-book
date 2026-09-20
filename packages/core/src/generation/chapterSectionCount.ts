/**
 * How many sections a composed chapter is planned in, and how long its one
 * sustained stretch may be. The form planner (`chapterForms.ts`) assigns the
 * count; this module is the sizing policy behind it.
 *
 * The writer's output is a property of the section, not of the number beside
 * it: on two live Balanced books (2026-09-19, 20 chapters) first drafts came
 * back at 430–650 words a section whether the section was asked for 440 or
 * 1,235, and replaying six of the prompts with the aim and every section's
 * words scaled to the budget's max moved the total nowhere (53–86% of target).
 * A 13-page chapter planned in four sections of 1,235 words delivered 55–82%;
 * the shortfall was the sections' size. Sections are therefore counted from
 * the chapter's words.
 */

/** The most prose one section is asked for, on average. */
export const SECTION_ASK_WORDS = 600;
/** The most sections a chapter is planned in: a 7,400-word chapter gets twelve of ~620 words rather than four essays. */
export const MAX_CHAPTER_SECTIONS = 12;
/** The chapter's one sustained stretch takes 40% of a short chapter and is never asked for more than this. */
export const SUSTAINED_SECTION_WORDS = 1000;

/**
 * The section count a chapter is planned in. By pages, the range is
 * `round(pages / 1.75)` give or take; by words, no section may average more
 * than `SECTION_ASK_WORDS`, which raises the floor of a long chapter (a
 * 4,940-word chapter: nine or ten sections, not four to eight) and leaves a
 * short one alone.
 */
export function sectionCountForPages(pageCount: number, words?: number): { min: number; max: number } {
  const pages = Math.max(1, pageCount);
  const ideal = Math.round(pages / 1.75);
  // Three sections of 1,600 words each read as three self-contained essays;
  // the blind panel called those chapters anthologies. Four is the floor once
  // a chapter has the room.
  const byPages = {
    min: Math.max(2, Math.min(pages >= 8 ? 4 : 3, ideal)),
    max: Math.max(3, Math.min(8, ideal + 2))
  };
  if (words === undefined || !(words > 0)) return byPages;
  const byWords = Math.min(MAX_CHAPTER_SECTIONS, Math.ceil(words / SECTION_ASK_WORDS));
  const min = Math.max(byPages.min, byWords);
  return { min, max: Math.max(min, Math.min(MAX_CHAPTER_SECTIONS, Math.max(byPages.max, byWords + 1))) };
}

/** One count per chapter, walking the range so consecutive chapters differ and the book uses the whole range. */
export function assignedSectionCount(chapterIndex: number, pageCount: number, words?: number): { min: number; max: number } {
  const { min, max } = sectionCountForPages(pageCount, words);
  const span = max - min + 1;
  const offsets = [0, 2, 1, 3, 0, 2, 1, 3];
  const count = min + (offsets[(Math.max(1, chapterIndex) - 1) % offsets.length]! % span);
  return { min: count, max: count };
}

/**
 * The share of the chapter its longest section takes: 40%, or less where 40%
 * would ask one section for more than `SUSTAINED_SECTION_WORDS`. Told "at
 * least 40%" on a 4,940-word chapter, the planner drew a 1,976-word section
 * the writer answered with half of it.
 */
export function sustainedSectionShare(words?: number): number {
  if (words === undefined || !(words > 0)) return 0.4;
  return Math.max(0.15, Math.min(0.4, Math.round((SUSTAINED_SECTION_WORDS / words) * 100) / 100));
}
