import {
  bookPlanSchema,
  manuscriptExcerpt,
  takenOverPageText,
  type BookPlan,
  type ReaderChapter,
  type StudioKind,
  type StudioLayout
} from "@book-maker/core";
import { groupBookPages, newRowId, type BookChapterRow, type BookPageRow } from "./manuscriptBook.js";

/**
 * The pure half of a takeover (`.scratch/writing-studio/takeover.md`): which
 * Studio shape a generated book gets, which chapters the author sees, and what
 * each page's text becomes. No database here, so "a generated book prints the
 * same once it is the author's" is testable on its own.
 */

/** The art style a Studio record may carry (`studioSettingsSchema.artStyle`). */
const ART_STYLE_MAX_CHARS = 400;

/**
 * The Studio kind and layout a generated book continues in. The layout follows
 * how the book prints *now*: one sheet per page (a short picture book —
 * `shortKidsStoryPageLayout`) stays one sheet per page as a Studio picture
 * book; everything else flows.
 */
export function takeoverStudioShape(input: { category: string; printsSeparateStoryPages: boolean }): {
  kind: StudioKind;
  layout: StudioLayout;
} {
  const kind: StudioKind =
    input.category === "KIDS" ? "picture" : input.category === "STORY" ? "story" : input.category === "CUSTOM" ? "other" : "nonfiction";
  return { kind, layout: input.printsSeparateStoryPages ? "picture" : "flow" };
}

/**
 * The look Studio "Illustrate" keeps drawing in: the plan's illustration style
 * for a book that has pictures, else the style the reader picked, clipped to
 * what the Studio record accepts. Null for a book that never had either.
 */
export function takeoverArtStyle(options: { plan: unknown; imageStyle: unknown; hasPictures: boolean }): string | null {
  const parsed = bookPlanSchema.safeParse(options.plan);
  const planStyle = parsed.success ? parsed.data.illustrationPlan.globalStyle.trim() : "";
  const picked = typeof options.imageStyle === "string" ? options.imageStyle.trim() : "";
  const style = (options.hasPictures && planStyle && !/^no illustrations?\b/i.test(planStyle) ? planStyle : picked).trim();
  if (!style) return null;
  if (style.length <= ART_STYLE_MAX_CHARS) return style;
  const cut = style.slice(0, ART_STYLE_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return (space > ART_STYLE_MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).trim();
}

export type TakeoverChapterSlot = {
  id: string;
  index: number;
  title: string;
  summary: string;
  targetPages: number;
  /** No `Chapter` row holds this index yet. */
  create: boolean;
};

export type TakeoverPageWrite = { id: string; index: number; chapterId: string | null; markdown: string; revision: number };

export type TakeoverBookPlan = {
  /** Set only when the book's chapters change to the ones its reader saw. */
  chapterSlots: TakeoverChapterSlot[] | null;
  /**
   * The pages move between chapters. False when only the printed titles
   * differ (a composed book's sanitizer renamed a bare "Chapter 3"): then only
   * the titles move, and every other thing the plan and rows know is kept.
   */
  repartitioned: boolean;
  chapterDeleteIds: string[];
  /** Pages whose text or chapter changes; each gets its revision bumped. */
  pageWrites: TakeoverPageWrite[];
  /** Every attached non-cover image row: the picture prints from its line from now on. */
  detachImageIds: string[];
};

/**
 * The chapters the reader saw, as `Chapter`-row slots — or null when the rows
 * already are them. The published Contents is that record for a book printed in
 * a model partition; a composed book's Contents repeats its rows (titles
 * through the composed sanitizer, which is why the titles are taken from it).
 */
function readerSlots(
  chapters: readonly BookChapterRow[],
  pages: readonly BookPageRow[],
  readerChapters: readonly ReaderChapter[] | undefined
): { slots: TakeoverChapterSlot[]; repartitioned: boolean } | null {
  if (!readerChapters || readerChapters.length < 2) {
    return null;
  }
  const rowByIndex = new Map(chapters.map((chapter) => [chapter.index, chapter]));
  const slots = readerChapters.map((reader, offset): TakeoverChapterSlot => {
    const index = offset + 1;
    const existing = rowByIndex.get(index);
    const owned = pages.filter((page) => page.index >= reader.startPageIndex && page.index <= reader.endPageIndex);
    const summarySource = owned.map((page) => page.markdown).join("\n\n");
    return {
      id: existing?.id ?? newRowId("ch"),
      index,
      title: reader.title.trim() || existing?.title.trim() || `Chapter ${index}`,
      summary: manuscriptExcerpt(summarySource, 240) || reader.title.trim() || `Chapter ${index}`,
      targetPages: Math.max(1, owned.length),
      create: !existing
    };
  });
  const groups = [...groupBookPages(chapters, pages).entries()];
  const samePartition =
    groups.length === slots.length &&
    slots.every((slot, offset) => {
      const [key, owned] = groups[offset]!;
      const reader = readerChapters[offset]!;
      return (
        key === slot.id &&
        !slot.create &&
        owned[0]?.index === reader.startPageIndex &&
        owned[owned.length - 1]?.index === reader.endPageIndex
      );
    });
  if (!samePartition) {
    return { slots, repartitioned: true };
  }
  const sameTitles = slots.every((slot) => rowByIndex.get(slot.index)?.title.trim() === slot.title);
  return sameTitles ? null : { slots, repartitioned: false };
}

/**
 * What the takeover writes to the book's rows. Every page's text becomes what
 * the generated compile printed for it (`takenOverPageText`): the hero as its
 * first line, a whole-page wrapper unwrapped, a heading the generated rule
 * dropped dropped — `chapter` naming the printed chapter the page opens, so a
 * repeat of its heading goes.
 */
export function planTakeoverBook(input: {
  chapters: readonly BookChapterRow[];
  pages: readonly BookPageRow[];
  readerChapters: readonly ReaderChapter[] | undefined;
  language: string;
}): TakeoverBookPlan {
  const pages = [...input.pages].sort((left, right) => left.index - right.index);
  const reader = readerSlots(input.chapters, pages, input.readerChapters);
  const slots = reader?.slots ?? null;
  // The chapter each page ends up in, and the chapter each chapter-opening page opens.
  const chapterOf = new Map<string, string | null>();
  const opens = new Map<string, { index: number; title: string }>();
  if (slots) {
    for (const [offset, reader] of (input.readerChapters ?? []).entries()) {
      const slot = slots[offset]!;
      for (const page of pages) {
        if (page.index < reader.startPageIndex || page.index > reader.endPageIndex) continue;
        chapterOf.set(page.id, slot.id);
        if (page.index === reader.startPageIndex) opens.set(page.id, { index: slot.index, title: slot.title });
      }
    }
  } else {
    [...groupBookPages(input.chapters, pages).entries()].forEach(([key, owned], offset) => {
      const title = input.chapters.find((chapter) => chapter.id === key)?.title ?? "";
      const first = owned[0];
      if (first) opens.set(first.id, { index: offset + 1, title });
    });
  }

  const pageWrites: TakeoverPageWrite[] = [];
  for (const page of pages) {
    // A page the generated rule printed nothing of (a lone title heading)
    // keeps its text rather than becoming the empty page the author compile refuses.
    const markdown =
      takenOverPageText(page, { chapter: opens.get(page.id), language: input.language, heroPath: page.heroPath }) ||
      page.markdown.trim();
    const chapterId = slots ? (chapterOf.get(page.id) ?? page.chapterId) : page.chapterId;
    if (markdown !== page.markdown.trim() || chapterId !== page.chapterId) {
      pageWrites.push({ id: page.id, index: page.index, chapterId, markdown, revision: page.revision + 1 });
    }
  }
  const keptIds = new Set((slots ?? []).map((slot) => slot.id));
  return {
    chapterSlots: slots,
    repartitioned: reader?.repartitioned ?? false,
    chapterDeleteIds: slots ? input.chapters.filter((chapter) => !keptIds.has(chapter.id)).map((chapter) => chapter.id) : [],
    pageWrites,
    detachImageIds: pages.flatMap((page) => page.imageIds)
  };
}

/**
 * The plan with its chapters replaced by the re-partitioned ones — everything
 * else it knows about the book (premise, voice, characters, promises, the
 * illustration style) kept. A continuation numbers its new chapters off the
 * plan, so plan and rows may not disagree. Null when the stored plan does not
 * parse (the rows alone then speak for the chapters, as they do at compile).
 */
export function planWithTakeoverChapters(
  planningPackage: unknown,
  slots: readonly TakeoverChapterSlot[],
  repartitioned: boolean
): BookPlan | null {
  const parsed = bookPlanSchema.safeParse(planningPackage);
  if (!parsed.success) {
    return null;
  }
  if (!repartitioned && parsed.data.chapters.length === slots.length) {
    // Same chapters, printed names: every beat and brief the plan holds stays.
    return bookPlanSchema.parse({
      ...parsed.data,
      chapters: parsed.data.chapters.map((chapter, offset) => ({ ...chapter, title: slots[offset]!.title }))
    });
  }
  return bookPlanSchema.parse({
    ...parsed.data,
    chapters: slots.map((slot) => ({
      index: slot.index,
      title: slot.title,
      summary: slot.summary,
      targetPages: slot.targetPages,
      keyBeats: []
    }))
  });
}
