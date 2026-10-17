import {
  applyBookArcPages,
  applySeam,
  architectBook,
  chapterDegeneracy,
  chapterDigest,
  chapterEdges,
  chapterSeams,
  editChapter,
  figureStandInMarkdown,
  mapWithConcurrency,
  planBookArc,
  proseWordCount,
  reinsertFigureFences,
  rewriteSeams,
  seamsSupported,
  stripFigureFences,
  supportsBookDevelopment,
  type AuthorStance,
  type BookArc,
  type BookDossier,
  type BookPlan,
  type ChapterPlan,
  type CreateProjectInput,
  type PrimarySourceSearch,
  type TextModelAdapter
} from "@book-maker/core";
import type { RunLogger } from "../providers/runLogging.js";
import { config } from "../runtime/config.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import { persistDossierSupplement, recordDossierSources } from "./composedChaptersMaterial.js";
import { stageComposedChapter, type ComposedChapterReport, type StoredComposedPage } from "./composedChaptersState.js";
import { repairComposedClaims } from "./composedClaimReview.js";
import type { ManuscriptReadContext } from "./composedManuscriptRead.js";
import { persistBookArc } from "./composedPreparation.js";
import type { loadQualityContext } from "./qualitySettings.js";
import { mergeSourceDossiers } from "./sourceDossier.js";
export { runComposedDevelopmentalEdit } from "./composedDevelopmentalEdit.js";

/**
 * The composed pass's shelved arms, behind one seam. Each was measured and
 * switched off on every tier, and its core modules stay, tested, for the next
 * experiment (packages/core/src/generation/CLAUDE.md): the book arc and the
 * seams rewrite, the claim review, and the developmental edit. The pass calls
 * each once, where it used to run inline. What can still run is only what a
 * stored plan already carries: a stored arc still re-cuts the pages and
 * reaches the prompts, and a stored plan's case-evidence packets are still
 * reviewed. Best-of-two drafts with a cross-family judge was the fifth arm; its
 * worker wiring is gone and core's `judgeChapterDrafts` stays for
 * `scripts/judge-validation.ts`.
 */

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

/**
 * The book's arc: planned once per book and stored on the plan together with
 * its page cut, so a resumed run re-cuts the same pages; without an arc the
 * pass runs as before. The pass asks for it before the chapter setups because
 * the Chapter rows, the form plan and the word budgets are all derived from
 * the cut — computed after them it reached only the prompts (developer
 * review, 2026-09-03). With `BOOK_ARC` off only a stored arc is used, which
 * the initial planner no longer offers and a revision keeps.
 */
export async function prepareBookArc(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  stance: AuthorStance;
  textModel: TextModelAdapter;
  generationJobId?: string | undefined;
}): Promise<{ plan: BookPlan; arc: BookArc | undefined; arcSource: "stored" | "model" | undefined }> {
  const { projectId, planId, input, stance, textModel, generationJobId } = options;
  let plan = options.plan;
  let arc = planBookArc(plan);
  let arcSource: "stored" | "model" | undefined = arc ? "stored" : undefined;
  if (!arc && BOOK_ARC) {
    await advanceJobStep(generationJobId, "briefs", 13, "Planning the book's arc", { phase: "arc" });
    const architected = await architectBook({ input, plan, stance, textModel });
    if (architected.arc) {
      arc = architected.arc;
      arcSource = "model";
    } else {
      console.warn("Book arc not produced; composing without one", {
        event: "generation.composed_chapters.arc_not_produced",
        projectId,
        reason: architected.failure
      });
    }
  }
  if (arc) {
    const cut = applyBookArcPages(plan, arc, input.targetPages);
    if (cut.applied) {
      plan = cut.plan;
      arc = cut.arc;
      if (cut.reason) {
        console.warn("Book arc page cut repaired", { event: "generation.composed_chapters.arc_pages_repaired", projectId, reason: cut.reason });
      }
    } else {
      console.warn("Book arc page cut not applied", { event: "generation.composed_chapters.arc_pages_not_applied", projectId, reason: cut.reason });
    }
    if (arcSource === "model") {
      await persistBookArc(planId, arc, cut.applied ? cut.plan.chapters : undefined);
    }
  }
  return { plan, arc, arcSource };
}

/**
 * Every chapter's first and last paragraph rewritten in one call, so the seams
 * differ from each other; a paragraph the deterministic check refuses keeps
 * the original. Changed chapters are re-described and re-staged. Runs after
 * the read's cuts, only under `SEAMS_TOGETHER` with an arc, in a language the
 * seam check reads.
 */
export async function rewriteSeamsAfterRead(context: ManuscriptReadContext, bookNotes: string[]): Promise<void> {
  const { projectId, input, plan, arc: bookArc, setups, chapterIds, finalText, reports, edges, digests } = context;
  if (!SEAMS_TOGETHER || !bookArc || !seamsSupported(input.language)) return;
  const seamChapters = setups
    .filter((setup) => finalText.has(setup.chapter.index))
    .map((setup) => {
      const kind = bookArc.chapters.find((entry) => entry.index === setup.chapter.index)?.kind;
      return { index: setup.chapter.index, title: setup.chapter.title, ...(kind ? { kind } : {}), ...chapterSeams(figureStandInMarkdown(finalText.get(setup.chapter.index)!)) };
    });
  await updateJobProgress(context.generationJobId, { progress: 69, message: "Rewriting the chapter openings and closings together" });
  const seams = await rewriteSeams({ input, plan, arc: bookArc, chapters: seamChapters, bookNotes, textModel: context.textModel });
  if (seams.skipped) {
    console.warn("Seams skipped", { event: "generation.composed_chapters.seams_skipped", projectId, reason: seams.skipped });
    return;
  }
  console.warn("Seams rewritten", { event: "generation.composed_chapters.seams", projectId, accepted: seams.accepted, rejected: seams.rejected });
  // The re-describes are independent, so they run three at a time; the
  // staging after them is sequential because it writes page rows.
  const described = await mapWithConcurrency(seams.replacements, 3, async (replacement) => {
    const setup = setups.find((candidate) => candidate.chapter.index === replacement.index);
    const chapterId = setup ? chapterIds.get(setup.chapter.index) : undefined;
    const current = setup ? finalText.get(setup.chapter.index) : undefined;
    if (!setup || !chapterId || !current) return undefined;
    const { prose: currentProse, fences: currentFences } = stripFigureFences(current);
    const seamedProse = applySeam(currentProse, replacement);
    if (seamedProse === currentProse) return undefined;
    const seamed = reinsertFigureFences(seamedProse, currentFences);
    return { setup, chapterId, current, seamed, pages: await context.describePages(setup, seamed) };
  });
  for (const entry of described) {
    if (!entry) continue;
    const { setup, chapterId, current, seamed, pages } = entry;
    const previous = reports.get(setup.chapter.index) ?? context.reportFor(setup, proseWordCount(current), proseWordCount(seamed), false, seamed);
    const report: ComposedChapterReport = { ...previous, seamsApplied: true };
    reports.set(setup.chapter.index, report);
    await stageComposedChapter({ projectId, chapterId, setup, composition: context.compositionFor(setup), pages, report, replace: true });
    finalText.set(setup.chapter.index, seamed);
    edges.set(setup.chapter.index, chapterEdges(seamed));
    digests.set(setup.chapter.index, chapterDigest(pages.map((page) => page.summary)));
  }
}

/**
 * The developmental edit (`composedDevelopmentalEdit.ts`): a nonfiction book
 * on a fresh run whose every page is still PENDING, under the
 * `developmentalEdit` gate, which is shelved — off on every tier since the
 * 2026-09-05 measurement — so only a revision an experiment writes turns it on.
 * With it the edit replaces the manuscript read.
 */
export function developmentalEditApplies(
  input: CreateProjectInput,
  plan: BookPlan,
  quality: Awaited<ReturnType<typeof loadQualityContext>>,
  pages: readonly Pick<StoredComposedPage, "status">[]
): boolean {
  return !config.MOCK_AI && supportsBookDevelopment(input, plan) && quality.enabled("developmentalEdit") && pages.every((page) => page.status === "PENDING");
}

/**
 * The prose-evidence review (`composedClaimReview.ts`): two targeted repairs,
 * then whatever stands is recorded on the chapter and flagged at compile time
 * (composedEvidenceResiduals.ts), never a failed book. The broad claim review
 * is dormant behind `SOURCE_CLAIM_REVIEW`, so this reviews only a chapter
 * whose plan carries case-evidence packets — which only the shelved
 * `caseEvidence` and `bookDevelopment` gates write — and every other chapter
 * comes back unchanged before any call.
 */
export async function reviewChapterClaims(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  chapter: ChapterPlan;
  markdown: string;
  textModel: TextModelAdapter;
  searchSources: PrimarySourceSearch;
  runLog: Pick<RunLogger, "append"> | undefined;
  /** The pass's dossier, which a source search the review makes is merged into. */
  dossier: BookDossier | undefined;
  /** The chapter's compose options, as every editor call of the chapter takes them. */
  editOptions: () => Promise<Omit<Parameters<typeof editChapter>[0], "markdown">>;
}): Promise<Pick<ComposedChapterReport, "evidence" | "sourceClaims"> & { markdown: string }> {
  const { projectId, planId, input, dossier } = options;
  const maxWords = Math.ceil(proseWordCount(options.markdown) * 1.1);
  const verified = await repairComposedClaims({ projectId, input, plan: options.plan, chapter: options.chapter, markdown: options.markdown, textModel: options.textModel, searchSources: options.searchSources, runLog: options.runLog,
    edit: async (text, correction) => (await editChapter({ ...(await options.editOptions()), markdown: text, allowExtension: false, degeneracyMaxWords: maxWords, readerNotes: [...correction.instructions], factualCorrection: correction })).markdown,
    degenerate: (text) => chapterDegeneracy(text, { maxWords, language: input.language }).degenerate,
    persistSources: async (supplement) => {
      await persistDossierSupplement(planId, supplement);
      await recordDossierSources(projectId, supplement);
      if (dossier) Object.assign(dossier, mergeSourceDossiers(dossier, supplement));
    }
  });
  const repair = verified.repair;
  return {
    markdown: repair ? repair.markdown : options.markdown,
    ...(repair ? { evidence: { findings: repair.findings, repairs: repair.repairs, unresolved: repair.unresolved, dropped: repair.dropped } } : {}),
    ...(verified.sourceClaims ? { sourceClaims: verified.sourceClaims } : {})
  };
}
