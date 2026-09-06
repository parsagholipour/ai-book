import re
root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'

# ---- core: chapterJudge.ts
open(root+'packages/core/src/generation/chapterJudge.ts','w').write('''import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import type { BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

/**
 * The one stage in the composed-chapters pipeline that chooses. Every other
 * stage generates once and keeps, so variety is asserted by rules, and rules
 * are performed. Two drafts of a chapter, a forced choice by a judge from
 * another model family, both orders, and a disagreement is a tie that keeps
 * the first draft. The rubric is the blind panel's, not the writer's: rhythm,
 * commitment, forward motion, varied endings; never topic, facts or length.
 */

export const JUDGE_CHAPTER_DRAFTS_PURPOSE = "judge-chapter-drafts";

const verdictSchema = z.object({
  winner: z.enum(["A", "B"]),
  reason: z.string().default("")
});

export type ChapterDraftVerdict = {
  /** Index into `drafts` of the chosen draft. */
  pick: number;
  /** Both orders named the same draft. */
  agreed: boolean;
  reasons: string[];
};

const JUDGE_RUBRIC =
  "You are choosing between two drafts of the same chapter of a book for a demanding general reader. Which of the two would that reader keep reading? Judge paragraph rhythm (do paragraphs differ in length and shape, is there a sustained stretch and a short turn), whether sentences commit (or re-balance what they just said with a counterweight), whether the chapter moves forward or re-states, whether paragraphs and sections end differently from one another, and whether people, places and documents are present rather than abstractions. Ignore the topic, the facts, and which draft is longer. Do not prefer the draft that hedges more carefully. A forced choice: return one JSON object {\\"winner\\": \\"A\\" or \\"B\\", \\"reason\\": one sentence naming the decisive difference}. Never answer with a tie.";

async function judgeOnce(
  judge: TextModelAdapter,
  header: Record<string, unknown>,
  first: string,
  second: string
): Promise<{ winner: "A" | "B"; reason: string }> {
  const result = await generateJsonWithRetry(judge, {
    purpose: JUDGE_CHAPTER_DRAFTS_PURPOSE,
    temperature: 0.2,
    maxTokens: 400,
    schema: verdictSchema,
    messages: [
      { role: "system", content: JUDGE_RUBRIC },
      { role: "user", content: JSON.stringify({ ...header, draftA: first, draftB: second }, null, 2) }
    ]
  });
  return result.data;
}

export async function judgeChapterDrafts(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter: ChapterPlan;
  drafts: readonly string[];
  judge: TextModelAdapter;
}): Promise<ChapterDraftVerdict> {
  if (options.drafts.length < 2) {
    return { pick: 0, agreed: true, reasons: [] };
  }
  const [first, second] = [options.drafts[0]!, options.drafts[1]!];
  const header = {
    book: { title: options.plan.title, audience: options.plan.audience },
    chapter: { index: options.chapter.index, title: options.chapter.title }
  };
  const [forward, reversed] = await Promise.all([
    judgeOnce(options.judge, header, first, second),
    judgeOnce(options.judge, header, second, first)
  ]);
  // In the reversed order "A" is the second draft.
  const forwardPick = forward.winner === "A" ? 0 : 1;
  const reversedPick = reversed.winner === "A" ? 1 : 0;
  const agreed = forwardPick === reversedPick;
  return {
    pick: agreed ? forwardPick : 0,
    agreed,
    reasons: [forward.reason, reversed.reason].filter(Boolean)
  };
}
''')

# ---- core: composeChapter temperature override
p=root+'packages/core/src/generation/composedChapter.ts'
s=open(p).read()
old='''  storyStateLines?: string[] | undefined;
  textModel: TextModelAdapter;
};

export type ComposedChapterText = { markdown: string; words: number; attempts: number };'''
new='''  storyStateLines?: string[] | undefined;
  textModel: TextModelAdapter;
  /** A second candidate samples hotter than the book's own temperature; the judge decides. */
  temperature?: number | undefined;
};

export type ComposedChapterText = { markdown: string; words: number; attempts: number };'''
assert old in s, "compose options"; s=s.replace(old,new,1)
i=s.index('export async function composeChapter('); j=s.index('export type EditChapterOptions')
body=s[i:j]
assert body.count('temperature: options.input.temperature,')==1, "compose temperature"
body=body.replace('temperature: options.input.temperature,','temperature: options.temperature ?? options.input.temperature,',1)
s=s[:i]+body+s[j:]
open(p,'w').write(s)

# ---- core: barrel, mechanical purpose, fake
p=root+'packages/core/src/index.ts'
s=open(p).read()
if 'chapterJudge.js' not in s:
    s=s.replace('export * from "./generation/proseMeasurements.js";','export * from "./generation/proseMeasurements.js";\nexport * from "./generation/chapterJudge.js";',1)
    open(p,'w').write(s)
p=root+'packages/core/src/adapters/modelTiers.ts'
s=open(p).read()
old='''  "describe-pages",
'''
new='''  "describe-pages",
  // A forced choice between two drafts of one chapter (`chapterJudge.ts`); the
  // pass hands it a fast-judgment adapter from another model family anyway.
  "judge-chapter-drafts",
'''
assert old in s; s=s.replace(old,new,1); open(p,'w').write(s)
p=root+'packages/core/src/adapters/fake.ts'
s=open(p).read()
old='''    if (options.purpose === "critique-plan") {'''
new='''    if (options.purpose === "judge-chapter-drafts") {
      return { winner: "A", reason: "Fake judge keeps the first draft." };
    }

    if (options.purpose === "critique-plan") {'''
assert old in s; s=s.replace(old,new,1); open(p,'w').write(s)

# ---- worker: judge adapter
p=root+'apps/worker/src/providers/loggedAdapters.ts'
s=open(p).read()
s+='''
/**
 * The judge for best-of-two chapter drafts: the Quality tab's fast-judgment
 * route, which is a different model family from the tier's writer, logged and
 * costed like every other call of the job. The writer judging its own drafts
 * favours its own text; a second family does not.
 */
export function createLoggedJudgeTextModel(job: WorkerRuntimeJob, input: CreateProjectInput): TextModelAdapter {
  const logger = createRunLogger(job);
  const { generationJobId, projectId } = job.data;
  const delegate = config.MOCK_AI
    ? createCoreProviders(config, input).text
    : createLiveGenerationTextModel(config, {
        tier: modelTierForInput(input),
        fastJudgments: true,
        loadRouting: loadLiveGenerationTextRouting(logger),
        onFallbackEvent: (event) => logger.append(`text.routing.${event.event}`, event).then(() => undefined)
      });
  return new LoggingTextModelAdapter(delegate, logger, generationJobId, projectId, loggedTextModel(input));
}
'''
if 'createProviders as createCoreProviders' not in s:
    s='import { createProviders as createCoreProviders } from "@book-maker/core";\n'+s
open(p,'w').write(s)

# ---- worker: pass
p=root+'apps/worker/src/generation/composedChaptersPass.ts'
s=open(p).read()
old='''  editChapter,
  formatStoryStateLines,'''
new='''  editChapter,
  formatStoryStateLines,
  judgeChapterDrafts,'''
assert old in s; s=s.replace(old,new,1)
old='''  type ProviderSet
} from "@book-maker/core";'''
new='''  type ProviderSet,
  type TextModelAdapter
} from "@book-maker/core";'''
assert old in s; s=s.replace(old,new,1)
old='''  /** Whether the deterministic shape check sent the chapter back to the editor once. */
  shapePassApplied: boolean;
};'''
new='''  /** Whether the deterministic shape check sent the chapter back to the editor once. */
  shapePassApplied: boolean;
  /** Best-of-two: which draft the cross-family judge chose and whether both orders agreed. */
  bestOf?: { pick: number; agreed: boolean; reasons: string[] };
};

/**
 * The read's per-chapter second edits are off: the run that carried them
 * (composed-5) scored inside the noise of the run that did not, and their
 * cost pays for the second draft the judge chooses between. The read still
 * runs; its notes are kept on the chapter report for the console.
 */
const READ_SECOND_EDITS = false;
/** How much hotter the second candidate samples than the book's own temperature. */
const SECOND_CANDIDATE_TEMPERATURE_STEP = 0.25;'''
assert old in s; s=s.replace(old,new,1)
old='''  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}): Promise<void> {
  const { projectId, planId, input, plan, providers, strategy, generationJobId } = options;'''
new='''  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
  /** A judge from another model family; with one, every chapter is drafted twice and chosen. */
  judgeTextModel?: TextModelAdapter | undefined;
}): Promise<void> {
  const { projectId, planId, input, plan, providers, strategy, generationJobId, judgeTextModel } = options;'''
assert old in s, "pass options"; s=s.replace(old,new,1)
old='''    const draft = await composeChapter(await composeOptionsFor(setup, drafts));
    drafts.set(setup.chapter.index, draft.markdown);'''
new='''    const composeOptions = await composeOptionsFor(setup, drafts);
    const candidates = judgeTextModel
      ? await Promise.all([
          composeChapter(composeOptions),
          composeChapter({ ...composeOptions, temperature: Math.min(1, input.temperature + SECOND_CANDIDATE_TEMPERATURE_STEP) })
        ])
      : [await composeChapter(composeOptions)];
    let draft = candidates[0]!;
    if (judgeTextModel && candidates.length === 2) {
      const verdict = await judgeChapterDrafts({
        input,
        plan,
        chapter: setup.chapter,
        drafts: candidates.map((candidate) => candidate.markdown),
        judge: judgeTextModel
      });
      draft = candidates[verdict.pick] ?? draft;
      bestOfVerdicts.set(setup.chapter.index, verdict);
    }
    drafts.set(setup.chapter.index, draft.markdown);'''
assert old in s, "compose loop"; s=s.replace(old,new,1)
old='''  const drafts = new Map<number, string>();
  const reports = new Map<number, ComposedChapterReport>();'''
new='''  const drafts = new Map<number, string>();
  const bestOfVerdicts = new Map<number, { pick: number; agreed: boolean; reasons: string[] }>();
  const reports = new Map<number, ComposedChapterReport>();'''
assert old in s, "maps"; s=s.replace(old,new,1)
old='''    const report: ComposedChapterReport = {
      ...reportFor(setup, countReadableWords(draftMarkdown), countReadableWords(markdown), editorChanged),
      paragraphCv: paragraphShapeReport(markdown).cv,
      shapePassApplied
    };'''
new='''    const bestOf = bestOfVerdicts.get(setup.chapter.index);
    const report: ComposedChapterReport = {
      ...reportFor(setup, countReadableWords(draftMarkdown), countReadableWords(markdown), editorChanged),
      paragraphCv: paragraphShapeReport(markdown).cv,
      shapePassApplied,
      ...(bestOf ? { bestOf } : {})
    };'''
assert old in s, "report"; s=s.replace(old,new,1)
old='''    const flagged = read.chapters.filter((entry) => entry.edit);'''
new='''    const flagged = READ_SECOND_EDITS ? read.chapters.filter((entry) => entry.edit) : [];
    if (!READ_SECOND_EDITS) {
      for (const entry of read.chapters) {
        const setup = setups.find((candidate) => candidate.chapter.index === entry.chapterIndex);
        const previous = setup ? reports.get(setup.chapter.index) : undefined;
        if (setup && previous) reports.set(setup.chapter.index, { ...previous, readNotes: entry.notes });
      }
    }'''
assert old in s, "read flagged"; s=s.replace(old,new,1)
open(p,'w').write(s)

# ---- worker: generateBook passes the judge
p=root+'apps/worker/src/handlers/generateBook.ts'
s=open(p).read()
old='''    case "composed-chapters":
      await generateBookComposedChapters({
        projectId,
        planId,
        input,
        plan,
        providers,
        strategy,
        generationJobId
      });'''
new='''    case "composed-chapters":
      await generateBookComposedChapters({
        projectId,
        planId,
        input,
        plan,
        providers,
        strategy,
        generationJobId,
        judgeTextModel: createLoggedJudgeTextModel(job, input)
      });'''
assert old in s, "generateBook case"; s=s.replace(old,new,1)
old='''import { createLoggedProviders } from "../providers/loggedAdapters.js";'''
new='''import { createLoggedJudgeTextModel, createLoggedProviders } from "../providers/loggedAdapters.js";'''
assert old in s, "generateBook import"; s=s.replace(old,new,1)
open(p,'w').write(s)
print("run B patch applied")

# ---- worker test mock: the handler test names the logged-providers exports it uses
p=root+'apps/worker/src/handlers/generateBook.test.ts'
s=open(p).read()
old='''vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({}) }));'''
new='''vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({}), createLoggedJudgeTextModel: () => ({}) }));'''
assert old in s, "generateBook test mock"; s=s.replace(old,new,1)
open(p,'w').write(s)
print("test mock patched")
