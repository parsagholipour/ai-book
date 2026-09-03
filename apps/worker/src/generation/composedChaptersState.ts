import {
  chapterCompositionSchema,
  isRecord,
  type ChapterBrief,
  type ChapterComposition,
  type DescribedPage,
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";

import type { ChapterSetup } from "../runtime/jobTypes.js";

/**
 * The composed-chapters pass's state: what a resumed run finds, how a finished
 * chapter's pages and derived brief are staged, and the stored shape the pass
 * and its finalize step read back. Split from `composedChaptersPass.ts` along
 * this seam when it passed the file-size budget.
 */

export type ComposedResumeState =
  | { kind: "fresh" }
  | { kind: "already-complete" }
  | { kind: "resume"; doneChapterIndexes: number[]; partialChapterIndexes: number[] };

export function composedResumeState(options: {
  ranges: ReadonlyArray<{ chapterIndex: number; title: string; targetPages: number; startPage: number; endPage: number }>;
  storedChapters: ReadonlyArray<{ index: number; title: string; targetPages: number }>;
  storedPages: ReadonlyArray<{ index: number; status: string }>;
}): ComposedResumeState {
  if (options.storedChapters.length === 0 || options.storedChapters.length !== options.ranges.length) {
    return { kind: "fresh" };
  }
  const structureMatches = options.ranges.every((chapterRange) => {
    const stored = options.storedChapters.find((chapter) => chapter.index === chapterRange.chapterIndex);
    return stored !== undefined && stored.title === chapterRange.title && stored.targetPages === chapterRange.targetPages;
  });
  if (!structureMatches) {
    return { kind: "fresh" };
  }
  const lastPage = options.ranges.at(-1)?.endPage ?? 0;
  const seen = new Set<number>();
  for (const page of options.storedPages) {
    if (seen.has(page.index) || page.index < 1 || page.index > lastPage) {
      return { kind: "fresh" };
    }
    seen.add(page.index);
  }
  const done: number[] = [];
  const partial: number[] = [];
  for (const chapterRange of options.ranges) {
    const expected = chapterRange.endPage - chapterRange.startPage + 1;
    let present = 0;
    for (let index = chapterRange.startPage; index <= chapterRange.endPage; index += 1) {
      if (seen.has(index)) present += 1;
    }
    if (present === expected) {
      done.push(chapterRange.chapterIndex);
    } else if (present > 0) {
      partial.push(chapterRange.chapterIndex);
    }
  }
  if (done.length === options.ranges.length) {
    return options.storedPages.some((page) => page.status === "PENDING")
      ? { kind: "resume", doneChapterIndexes: done, partialChapterIndexes: [] }
      : { kind: "already-complete" };
  }
  return { kind: "resume", doneChapterIndexes: done, partialChapterIndexes: partial };
}

export type StoredComposedChapter = {
  id: string;
  index: number;
  title: string;
  targetPages: number;
  composition: ChapterComposition | undefined;
  /** The facts each page established, kept on the derived brief so a resumed finalize still publishes them. */
  pageNotes: Map<number, string[]>;
};

export type StoredComposedPage = {
  index: number;
  status: string;
  title: string;
  markdown: string;
  summary: string;
  imagePrompt: string | null;
};

export async function loadComposedBookState(projectId: string): Promise<{
  chapters: StoredComposedChapter[];
  pages: StoredComposedPage[];
}> {
  const [chapters, pages] = await Promise.all([
    prisma.chapter.findMany({
      where: { projectId },
      orderBy: { index: "asc" },
      select: { id: true, index: true, title: true, targetPages: true, productionBrief: true }
    }),
    prisma.page.findMany({
      where: { projectId },
      orderBy: { index: "asc" },
      select: { index: true, status: true, title: true, markdown: true, summary: true, imagePrompt: true }
    })
  ]);
  return {
    chapters: chapters.map((chapter) => {
      const brief = isRecord(chapter.productionBrief) ? chapter.productionBrief : undefined;
      const composition = brief ? chapterCompositionSchema.safeParse(brief.composition) : undefined;
      const pageNotes = new Map<number, string[]>();
      if (brief && Array.isArray(brief.pages)) {
        for (const page of brief.pages) {
          if (isRecord(page) && typeof page.pageIndex === "number" && Array.isArray(page.requiredContinuity)) {
            pageNotes.set(
              page.pageIndex,
              page.requiredContinuity.filter((note): note is string => typeof note === "string" && note.trim().length > 0)
            );
          }
        }
      }
      return {
        id: chapter.id,
        index: chapter.index,
        title: chapter.title,
        targetPages: chapter.targetPages,
        composition: composition?.success ? composition.data : undefined,
        pageNotes
      };
    }),
    pages
  };
}

export type ComposedPageRow = DescribedPage & { markdown: string };

/**
 * What the console shows about a composed chapter beside its form plan: how
 * the chapter was written and what the whole-book read said about it. Stored
 * on the derived brief next to `composition`, and stripped by every parse of
 * the brief like it.
 */
export type ComposedChapterReport = {
  /** The seams call replaced this chapter's opening and/or closing. */
  seamsApplied?: boolean | undefined;
  /** Where the book's arc came from: stored on the plan, or planned by this run. */
  arc?: "stored" | "model" | undefined;
  /** What the manuscript read said about the whole book, kept on the first chapter's report. */
  readMetrics?: { stopsDevelopingAt?: number | undefined; swappable?: number[] | undefined; answerStatedIn?: number[] | undefined } | undefined;
  formPlanSource: "model" | "repaired" | "rotated" | "fallback";
  formPlanIssues: string[];
  draftWords: number;
  editedWords: number;
  editorChanged: boolean;
  readNotes: string[];
  secondEditApplied: boolean;
  wordBudget: { min: number; target: number; max: number };
  /** Paragraph-length coefficient of variation after the last edit. */
  paragraphCv: number;
  /** Whether the deterministic shape check sent the chapter back to the editor once. */
  shapePassApplied: boolean;
  /** Best-of-two: which draft the cross-family judge chose and whether both orders agreed. */
  bestOf?: { pick: number; agreed: boolean; reasons: string[] };
  /** Material-first: the opening scene composed for the chapter. */
  scene?: { words: number; episodeTitle: string } | undefined;
  /** Material-first: what the dossier held for the chapter. */
  dossier?: { episodes: number; documents: number; excerpts: number } | undefined;
  /** The quote guard's count on the edited chapter: spans checked, verbatim in the dossier, hung on a dossier document without being in it, and stripped of their marks. */
  quotes?: { checked: number; verbatim: number; misattributed: number; stripped: number } | undefined;
  /** Which contract the writer wrote under. */
  contract?: "grounded" | "creative" | undefined;
  /** The couplet rewrite: pairs found in the edited chapter and pairs the editor's replacement was accepted for. */
  couplets?: { found: number; rewritten: number } | undefined;
  /** Whether an epigraph from the dossier was set at the chapter's head. */
  epigraph?: boolean | undefined;
};

/**
 * The read's per-chapter second edits are off: the run that carried them
 * (composed-5) scored inside the noise of the run that did not, and their
 * cost pays for the second draft the judge chooses between. The read still
 * runs; its notes are kept on the chapter report for the console.
 */
/** The read-driven deletion-only cut ran on composed-8/9 (6.73 on composed-7's plan); off until it is tested on its own. */
export const READ_SECOND_EDITS = false;
/**
 * The book arc (core `bookArc.ts`): planned once per book, the pages re-cut
 * by kind, the thesis withheld from the middle chapters. Arm 1 of the
 * paradigm shift (spec.md, composed-24/25, 2026-09-03): nine readers scored
 * it 7.39 against 7.46 for this default, engagement and pacing unmoved, and
 * the read reported the answer stated in nearly every chapter regardless —
 * the writer reconstructs it from the question. Off; the modules stay for
 * the next arm.
 */
export const BOOK_ARC = false;
/** Every chapter's first and last paragraph rewritten together after the read (core `seams.ts`); same arm, same verdict. */
export const SEAMS_TOGETHER = false;
/** Two drafts and a judge settled 2 of composed-7's 15 chapters at double the compose spend; the code path stays for a tier that earns it. */
export const COMPOSE_CANDIDATES = 1;
/** Paragraph-shape numbers to the editor: off for composed-8/9, which scored lower on the same plan; back on with composed-7's editor. */
export const SHAPE_NOTES_TO_EDITOR = true;
/** Measured notes to the editor: off for the subtraction ablation (composed-21, 6.6 against 7.3), back on. */
export const MEASUREMENT_NOTES_TO_EDITOR = true;
/** How much hotter the second candidate samples than the book's own temperature. */
export const SECOND_CANDIDATE_TEMPERATURE_STEP = 0.25;

/**
 * The brief every page-scoped consumer reads is derived from what was
 * written, not assigned before it: one beat per page naming the section the
 * typesetter's cut fell in, the page's own summary as its beat, and the facts
 * it established as its continuity. Only the chapter's last page carries the
 * landing; every other page says it ends where the cut fell. The composition
 * rides beside it and is stripped by every parse of the brief.
 */
export function derivedChapterBrief(
  setup: ChapterSetup,
  composition: ChapterComposition,
  pages: readonly ComposedPageRow[],
  report?: ComposedChapterReport | undefined
): ChapterBrief & { composition: ChapterComposition; report?: ComposedChapterReport } {
  const pageCount = Math.max(1, setup.endPage - setup.startPage + 1);
  const boundaries: number[] = [];
  let cumulative = 0;
  for (const section of composition.sections) {
    cumulative += section.share ?? 1 / composition.sections.length;
    boundaries.push(cumulative);
  }
  const sectionFor = (offset: number) => {
    const position = (offset + 0.5) / pageCount;
    const index = boundaries.findIndex((boundary) => position <= boundary + 1e-9);
    return composition.sections[index === -1 ? composition.sections.length - 1 : index]!;
  };
  return {
    chapterIndex: setup.chapter.index,
    title: setup.chapter.title,
    summary: composition.throughLine,
    continuityFocus: [],
    pages: pages.map((page, offset) => {
      const section = sectionFor(offset);
      const last = page.index === setup.endPage;
      return {
        pageIndex: page.index,
        chapterIndex: setup.chapter.index,
        purpose: `Part of the section "${section.subject}", written as a ${section.form}.`,
        beat: page.summary,
        requiredContinuity: page.continuityNotes,
        endingPressure: last
          ? composition.landing
          : "This page ends where the typesetter cut the chapter; keep the handoff into the next page and add no landing sentence.",
        ...(page.imagePrompt ? { imageMoment: page.imagePrompt } : {})
      };
    }),
    composition,
    ...(report ? { report } : {})
  };
}

export async function stageComposedChapter(options: {
  projectId: string;
  chapterId: string;
  setup: ChapterSetup;
  composition: ChapterComposition;
  pages: readonly ComposedPageRow[];
  report: ComposedChapterReport;
  replace: boolean;
}): Promise<void> {
  const brief = derivedChapterBrief(options.setup, options.composition, options.pages, options.report);
  await prisma.$transaction(async (tx) => {
    if (options.replace) {
      for (const page of options.pages) {
        await tx.page.updateMany({
          where: { projectId: options.projectId, index: page.index, status: "PENDING" },
          data: {
            title: page.title,
            markdown: page.markdown,
            summary: page.summary,
            imagePrompt: page.imagePrompt ?? null
          }
        });
      }
    } else {
      await tx.page.createMany({
        data: options.pages.map((page) => ({
          projectId: options.projectId,
          chapterId: options.chapterId,
          index: page.index,
          title: page.title,
          markdown: page.markdown,
          summary: page.summary,
          imagePrompt: page.imagePrompt ?? null,
          status: "PENDING" as const
        }))
      });
    }
    await tx.chapter.update({
      where: { id: options.chapterId },
      data: { productionBrief: brief as unknown as Prisma.InputJsonValue }
    });
  });
}

export function storedPagesInRange(pages: readonly StoredComposedPage[], setup: ChapterSetup): StoredComposedPage[] {
  return pages.filter((page) => page.index >= setup.startPage && page.index <= setup.endPage);
}
