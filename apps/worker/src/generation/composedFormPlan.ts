import {
  chapterWordBudget,
  exampleCastSchema,
  inferWritingMode,
  instructionalToolkitSchema,
  planChapterForms,
  planInstructionalForms,
  usesFigures,
  usesToolkit,
  type AuthorStance,
  type BookArc,
  type BookEpisodes,
  type BookPlan,
  type ChapterComposition,
  type ChapterFormsResult,
  type CreateProjectInput,
  type InstructionalSetting,
  type TextModelAdapter
} from "@book-maker/core";
import type { ChapterSetup } from "../runtime/jobTypes.js";
import type { loadQualityContext } from "./qualitySettings.js";
import { persistPlanField } from "./composedChaptersMaterial.js";

/**
 * The composed pass's chapter form plan, split from `composedChaptersPass.ts`
 * for the 900-line budget. It reads the book's episodes and never its
 * dossier, so the pass starts it the moment the episodes settle and it plans
 * while the chapters' sources are still being gathered (2026-09-30).
 */
export async function planComposedForms(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  stance: AuthorStance;
  arc: BookArc | undefined;
  setups: readonly ChapterSetup[];
  /** Compositions of the chapters an earlier run finished: kept, and planned against. */
  fixed: readonly ChapterComposition[];
  episodes: BookEpisodes | undefined;
  quality: Awaited<ReturnType<typeof loadQualityContext>>;
  textModel: TextModelAdapter;
  /** The brief's explicit asks (`briefRequirementsForForms`), each given a section. */
  requirements?: readonly string[] | undefined;
  /** A practical guide's or a workbook's country, decided with its research leads. */
  setting?: InstructionalSetting | undefined;
}): Promise<ChapterFormsResult> {
  const { input, plan, stance, arc, quality } = options;
  // A guide's or a workbook's recurring example people (`exampleCast.ts`):
  // the stored cast on a resume, a new one on a fresh instructional book.
  const mode = inferWritingMode(input, plan);
  const exampleCast = plan.exampleCast?.length ? plan.exampleCast : mode === "instructional" || mode === "reference" ? "plan" as const : undefined;
  // Figures: eligible books with the gate on. The planner sees the rule and
  // the key only then, the writer sees the syntax only in a chapter the plan
  // gave a figure, and every later pass sees prose (`composedFigures.ts`).
  const figures = usesFigures(input, plan) && quality.enabled("figures");
  // A practical guide or a workbook plans deliverables, not essay sections (`instructionalBook.ts`); its
  // whole-book decisions are stored like the cast, and a stored one is handed back on every later run.
  const toolkit = usesToolkit(input, plan);
  const forms = await (toolkit ? planInstructionalForms : planChapterForms)({
    input,
    plan,
    // Under an arc the form planner sees the question and never the answer:
    // its subjects and notes reach the writer.
    stance: arc ? { ...stance, thesis: arc.question, positions: [] } : stance,
    ranges: options.setups.map((setup) => {
      const arcChapter = arc?.chapters.find((entry) => entry.index === setup.chapter.index);
      return {
        chapter: setup.chapter,
        startPage: setup.startPage,
        endPage: setup.endPage,
        // The words the writer will be asked for, so the planner counts
        // sections the writer can fill rather than essays it delivers half of.
        words: chapterWordBudget(input, setup.endPage - setup.startPage + 1).target,
        ...(arcChapter ? { kind: arcChapter.kind } : {}),
        ...(arcChapter?.job.does ? { job: arcChapter.job.does } : {})
      };
    }),
    fixed: options.fixed,
    figures,
    // The cases already selected for every chapter, so the planner builds on them rather than choosing a second set.
    episodes: options.episodes,
    // Off, the rotation alone settles the forms (the formPlanRepair gate).
    repair: quality.enabled("formPlanRepair"),
    ...(options.requirements?.length ? { requirements: options.requirements } : {}),
    ...(exampleCast ? { exampleCast } : {}),
    ...(toolkit && plan.toolkit ? { toolkit: plan.toolkit } : {}),
    ...(toolkit && options.setting ? { setting: options.setting } : {}),
    textModel: options.textModel
  });
  if (toolkit && !plan.toolkit && forms.toolkit) {
    await persistPlanField(options.planId, "toolkit", forms.toolkit, (stored) => instructionalToolkitSchema.safeParse(stored).success);
  }
  if (forms.coverage && (forms.coverage.issues.length > 0 || forms.coverage.homed.length > 0)) {
    console.warn("Toolkit requirements homed or still uncovered", {
      event: "generation.composed_chapters.toolkit_coverage",
      projectId: options.projectId,
      ...forms.coverage
    });
  }
  if (exampleCast === "plan" && forms.cast) {
    await persistPlanField(options.planId, "exampleCast", forms.cast, (stored) => exampleCastSchema.safeParse(stored).success && Array.isArray(stored) && stored.length > 0);
  }
  if (forms.issues.length > 0) {
    console.warn("Chapter form plan kept variety issues", {
      event: "generation.composed_chapters.form_plan_issues",
      projectId: options.projectId,
      source: forms.source,
      issues: forms.issues
    });
  }
  return forms;
}
