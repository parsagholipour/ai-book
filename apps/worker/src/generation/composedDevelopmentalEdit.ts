import { createHash } from "node:crypto";
import {
  FIGURE_WORD_EQUIVALENT, chapterWordBudget, editManuscriptDevelopment, figureStandInMarkdown, isRecord,
  paragraphShapeReport, proseWordCount, reinsertFigureFences, reviewChapterCaseEvidence, stripFigureFences,
  chapterDegeneracy, type BookPlan, type ChapterComposition, type ComposeChapterOptions,
  type CreateProjectInput, type DevelopmentEditResult, type TextModelAdapter
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import type { ChapterSetup } from "../runtime/jobTypes.js";
import { parseEvidenceFinding } from "./composedEvidenceRepair.js";
import {
  derivedChapterBrief, loadComposedBookState, type ComposedChapterReport, type ComposedPageRow,
  type StoredComposedPage
} from "./composedChaptersState.js";

export function composedManuscriptDigest(chapters: ReadonlyArray<{ index: number; markdown: string }>): string {
  return createHash("sha256").update(JSON.stringify(chapters.map((chapter) => [chapter.index, chapter.markdown.replace(/\s+/g, " ").trim()]))).digest("hex");
}

export async function runComposedDevelopmentalEdit(options: {
  projectId: string; planId: string; input: CreateProjectInput; plan: BookPlan;
  textModel: TextModelAdapter; setups: ChapterSetup[]; chapterIds: Map<number, string>;
  finalText: Map<number, string>; reports: Map<number, ComposedChapterReport>;
  compositionFor: (setup: ChapterSetup) => ChapterComposition;
  composeOptionsFor: (setup: ChapterSetup, drafts: Map<number, string>) => Promise<ComposeChapterOptions>;
  describePages: (setup: ChapterSetup, markdown: string) => Promise<ComposedPageRow[]>;
  lineEdit: boolean; generationJobId?: string | undefined;
}): Promise<void> {
  const state = await loadComposedBookState(options.projectId);
  const chapters = options.setups.map((setup) => ({ index: setup.chapter.index, title: setup.chapter.title, markdown: options.finalText.get(setup.chapter.index) ?? "" }));
  const beforeDigest = composedManuscriptDigest(chapters);
  const row = await prisma.planVersion.findUnique({ where: { id: options.planId }, select: { planningPackage: true } });
  const marker = isRecord(row?.planningPackage) && isRecord(row.planningPackage.developmentalEdit) ? row.planningPackage.developmentalEdit : undefined;
  if (marker?.version === 1 && marker.resultDigest === beforeDigest) return;
  // A restart during finalize must never rewrite a mix of published and pending pages.
  if (state.pages.some((page) => page.status !== "PENDING")) return;
  if (state.pages.length !== options.input.targetPages || chapters.some((chapter) => !chapter.markdown.trim())) {
    throw new Error("Developmental editing requires the complete staged manuscript.");
  }
  const budgets = options.setups.map((setup) => chapterWordBudget(options.input, setup.endPage - setup.startPage + 1, { figureWords: stripFigureFences(options.finalText.get(setup.chapter.index) ?? "").fences.length * FIGURE_WORD_EQUIVALENT }));
  const wordBudget = budgets.reduce((sum, budget) => ({ min: sum.min + budget.min, target: sum.target + budget.target, max: sum.max + budget.max }), { min: 0, target: 0, max: 0 });
  await updateJobProgress(options.generationJobId, { progress: 69, message: "Editing the manuscript's progression and overlapping sections" });
  const result = await editManuscriptDevelopment({
    input: options.input, plan: options.plan,
    chapters: chapters.map((chapter) => ({ ...chapter, markdown: figureStandInMarkdown(chapter.markdown) })),
    wordBudget, textModel: options.textModel, mode: "extractive", crossChapterCasesOnly: true
  });
  const candidates = new Map(result.chapters.map((chapter) => [chapter.index, chapter.markdown]));
  const prepared: PreparedDevelopmentChapter[] = [];
  const unchangedPages: StoredComposedPage[] = [];
  // The planner selects existing paragraphs; only changed chapters need evidence review and pagination.
  for (const setup of options.setups) {
    const original = options.finalText.get(setup.chapter.index)!;
    const markdown = candidates.get(setup.chapter.index)!;
    if (markdown === figureStandInMarkdown(original)) {
      unchangedPages.push(...state.pages.filter((page) => page.index >= setup.startPage && page.index <= setup.endPage));
      continue;
    }
    const { fences } = stripFigureFences(original);
    const review = await reviewChapterCaseEvidence({ markdown, packets: options.plan.dossier?.evidencePackets ?? [], textModel: options.textModel });
    const evidence = { findings: review.issues.length, repairs: 0, unresolved: review.issues.map(parseEvidenceFinding), dropped: review.dropped.length };
    if (evidence.unresolved.length || evidence.dropped) {
      console.warn("Developmental edit left unsupported case claims", { event: "generation.composed_chapters.evidence_unresolved", projectId: options.projectId, chapterIndex: setup.chapter.index, stage: "developmental-edit", ...evidence });
    }
    const restored = reinsertFigureFences(markdown, fences);
    if (chapterDegeneracy(restored, { maxWords: Math.max(proseWordCount(original), proseWordCount(restored)) + 1, language: options.input.language }).degenerate) {
      throw new Error(`Developmental edit of chapter ${setup.chapter.index} failed prose integrity.`);
    }
    const pages = await options.describePages(setup, restored);
    const oldReport = options.reports.get(setup.chapter.index);
    const chapterBudget = chapterWordBudget(options.input, setup.endPage - setup.startPage + 1);
    const report: ComposedChapterReport = {
      formPlanSource: "model", formPlanIssues: [], draftWords: proseWordCount(original), editedWords: proseWordCount(restored),
      editorChanged: restored !== original, readNotes: [], secondEditApplied: false,
      wordBudget: chapterBudget, paragraphCv: paragraphShapeReport(restored).cv, shapePassApplied: false,
      ...oldReport,
      developmentalEdit: {
        appliedGroups: result.appliedGroups.filter((id) => result.plan.groups.find((group) => group.id === id)?.changes.some((change) => change.chapterIndex === setup.chapter.index)),
        rejectedGroups: result.rejectedGroups,
        beforeWords: proseWordCount(original), afterWords: proseWordCount(restored)
      },
      // This review read the final text, so it supersedes the compose-time residuals the compile matches pages against.
      evidence
    };
    report.editedWords = proseWordCount(restored);
    report.editorChanged = restored !== original;
    report.paragraphCv = paragraphShapeReport(restored).cv;
    prepared.push({ setup, chapterId: options.chapterIds.get(setup.chapter.index)!, composition: options.compositionFor(setup), markdown: restored, pages, report });
  }
  const changed = new Map(prepared.map((chapter) => [chapter.setup.chapter.index, chapter]));
  const finalChapters = chapters.map((chapter) => ({ ...chapter, markdown: changed.get(chapter.index)?.markdown ?? chapter.markdown }));
  const afterWords = finalChapters.reduce((sum, chapter) => sum + proseWordCount(chapter.markdown), 0);
  if (afterWords > wordBudget.max) {
    throw new Error(`The edited manuscript has ${afterWords} words; the requested book allows at most ${wordBudget.max}. It remains staged for a substantive length repair.`);
  }
  const lengthShortfall = Math.max(0, wordBudget.min - afterWords);
  if (lengthShortfall > 0) {
    console.warn("Developmental edit left the book under its word floor", {
      event: "generation.composed_chapters.length_shortfall",
      projectId: options.projectId, afterWords, floor: wordBudget.min, shortfall: lengthShortfall
    });
  }
  await commitComposedDevelopment({
    projectId: options.projectId, planId: options.planId, expectedPlan: row?.planningPackage, originalPages: state.pages, chapters: prepared, unchangedPages,
    marker: {
      version: 1, sourceDigest: beforeDigest, resultDigest: composedManuscriptDigest(finalChapters),
      beforeWords: result.beforeWords, afterWords, appliedGroups: result.appliedGroups, rejectedGroups: result.rejectedGroups,
      ...(lengthShortfall > 0 ? { lengthShortfall } : {})
    }
  });
  for (const chapter of prepared) {
    options.finalText.set(chapter.setup.chapter.index, chapter.markdown);
    options.reports.set(chapter.setup.chapter.index, chapter.report);
  }
}

type PreparedDevelopmentChapter = {
  setup: ChapterSetup; chapterId: string; composition: ChapterComposition;
  markdown: string; pages: ComposedPageRow[]; report: ComposedChapterReport;
};

/** Linked moves and their restart marker publish as a single transaction. */
export async function commitComposedDevelopment(options: {
  projectId: string; planId: string; expectedPlan: unknown; originalPages: StoredComposedPage[];
  chapters: PreparedDevelopmentChapter[];
  unchangedPages?: StoredComposedPage[];
  marker: {
    version: number; sourceDigest: string; resultDigest: string; beforeWords: number; afterWords: number;
    appliedGroups: string[]; rejectedGroups: DevelopmentEditResult["rejectedGroups"];
    lengthShortfall?: number | undefined;
  };
}): Promise<void> {
  const pages = [...options.chapters.flatMap((chapter) => chapter.pages), ...(options.unchangedPages ?? [])];
  const indexes = pages.map((page) => page.index);
  if (indexes.length !== options.originalPages.length || new Set(indexes).size !== indexes.length || options.originalPages.some((page) => !indexes.includes(page.index))) throw new Error("The developmental edit does not cover every staged page exactly once.");
  await prisma.$transaction(async (tx) => {
    const row = await tx.planVersion.findUnique({ where: { id: options.planId }, select: { planningPackage: true } });
    if (!row || !isRecord(row.planningPackage) || JSON.stringify(row.planningPackage) !== JSON.stringify(options.expectedPlan)) throw new Error("The plan changed during developmental editing; linked edits were not saved.");
    const originals = new Map(options.originalPages.map((page) => [page.index, page]));
    // Compare-and-swap every staged page, including unchanged rows, before the linked marker publishes.
    for (const page of pages) {
      const original = originals.get(page.index);
      if (!original) throw new Error("The developmental edit no longer covers the staged pages.");
      const changed = await tx.page.updateMany({
        where: { projectId: options.projectId, index: page.index, status: "PENDING", title: original.title, markdown: original.markdown, summary: original.summary, imagePrompt: original.imagePrompt },
        data: { title: page.title, markdown: page.markdown, summary: page.summary, imagePrompt: page.imagePrompt ?? null }
      });
      if (changed.count !== 1) throw new Error("A staged page changed during developmental editing; no linked edits were saved.");
    }
    for (const chapter of options.chapters) {
      const brief = derivedChapterBrief(chapter.setup, chapter.composition, chapter.pages, chapter.report);
      await tx.chapter.update({ where: { id: chapter.chapterId }, data: { productionBrief: brief as unknown as Prisma.InputJsonValue } });
    }
    const saved = await tx.planVersion.updateMany({
      where: { id: options.planId, planningPackage: { equals: row.planningPackage as Prisma.InputJsonValue } },
      data: { planningPackage: { ...row.planningPackage, developmentalEdit: options.marker } as unknown as Prisma.InputJsonValue }
    });
    if (saved.count !== 1) throw new Error("The plan changed during developmental editing; linked edits were rolled back.");
  }, { isolationLevel: "Serializable", timeout: 30_000 });
}
