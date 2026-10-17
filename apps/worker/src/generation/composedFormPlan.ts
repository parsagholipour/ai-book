import { z } from "zod";
import {
  chapterCompositionSchema,
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
import { stableJson } from "./composedPrepRecord.js";

/**
 * A form plan as the speculative composition prep stores it on the plan
 * (`planningPackage.compositions`), with a digest of every input that varies
 * between runs of one book — the stance it was planned against, the chapter
 * ranges, the episodes and setting, the brief's asks. The book run reuses it
 * only when its own digest is the same, so a reused plan is the answer the
 * planner would have been asked for again (harness redesign H4).
 */
const storedChapterFormsSchema = z.object({
  version: z.literal(1),
  inputs: z.string(),
  compositions: z.array(chapterCompositionSchema).min(1),
  issues: z.array(z.string()),
  source: z.enum(["model", "rotated", "fallback"]),
  cast: exampleCastSchema.optional(),
  toolkit: instructionalToolkitSchema.optional(),
  coverage: z.object({ issues: z.array(z.string()), homed: z.array(z.string()), shared: z.array(z.string()) }).optional()
});
export type StoredChapterForms = z.infer<typeof storedChapterFormsSchema>;

function formsFromRecord(record: StoredChapterForms): ChapterFormsResult {
  return {
    compositions: record.compositions,
    issues: record.issues,
    source: record.source,
    ...(record.cast ? { cast: record.cast } : {}),
    ...(record.toolkit ? { toolkit: record.toolkit } : {}),
    ...(record.coverage ? { coverage: record.coverage } : {})
  };
}

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
  /** A form plan the speculative prep stored (`planningPackage.compositions`): handed back when this run's inputs match it. */
  stored?: unknown;
  /** False for the prep, which writes the plan, the cast and the toolkit together through `onRecord`. */
  persist?: boolean | undefined;
  onRecord?: ((record: StoredChapterForms) => Promise<void>) | undefined;
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
  // Under an arc the form planner sees the question and never the answer:
  // its subjects and notes reach the writer.
  const plannerStance = arc ? { ...stance, thesis: arc.question, positions: [] } : stance;
  const ranges = options.setups.map((setup) => {
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
  });
  // What varies between runs of one book. The cast and toolkit the prep stored with its plan are left out:
  // whether a cast is asked for is the same question either way, and the stored one is that plan's own answer.
  const inputs = stableJson({
    stance: plannerStance, ranges, episodes: options.episodes, requirements: options.requirements ?? [],
    setting: toolkit ? options.setting : undefined, figures, toolkit, cast: Boolean(exampleCast)
  });
  if (options.fixed.length === 0 && options.stored !== undefined) {
    const stored = storedChapterFormsSchema.safeParse(options.stored);
    if (stored.success && stored.data.inputs === inputs) {
      console.info("Chapter form plan reused from the speculative prep", { event: "generation.composed_chapters.forms_reused", projectId: options.projectId, chapters: stored.data.compositions.length });
      return formsFromRecord(stored.data);
    }
    console.warn("Stored chapter form plan does not match this run's inputs; planning again", { event: "generation.composed_chapters.forms_not_reused", projectId: options.projectId, parsed: stored.success });
  }
  const planned = await (toolkit ? planInstructionalForms : planChapterForms)({
    input,
    plan,
    stance: plannerStance,
    ranges,
    fixed: options.fixed,
    figures,
    // The cases already selected for every chapter, so the planner builds on them rather than choosing a second set.
    episodes: options.episodes,
    ...(options.requirements?.length ? { requirements: options.requirements } : {}),
    ...(exampleCast ? { exampleCast } : {}),
    ...(toolkit && plan.toolkit ? { toolkit: plan.toolkit } : {}),
    ...(toolkit && options.setting ? { setting: options.setting } : {}),
    textModel: options.textModel
  });
  // Read the way the stored copy is read back, so a run planning its own forms and one reusing the prep's hand
  // the writer the same objects.
  const record = storedChapterFormsSchema.safeParse(JSON.parse(JSON.stringify({ version: 1, inputs, ...planned })));
  const forms = record.success ? formsFromRecord(record.data) : planned;
  if (record.success && options.onRecord) await options.onRecord(record.data);
  if (options.persist === false) return forms;
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
