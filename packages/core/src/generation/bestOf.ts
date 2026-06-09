import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import type { CreateProjectInput, PageDraft } from "../schemas/book.js";
import { generateJsonWithJailbreak } from "./generateWithJailbreak.js";
import type { GeneratePageOptions } from "./pages.js";

const draftJudgementSchema = z.object({
  chosenIndex: z.coerce.number().int().min(0),
  rationale: z.string().default("")
});

export type GenerateBestOfPageDraftsOptions = {
  /** Draft sampler, normally the strategy's generatePageDraft. */
  draftPage: (options: GeneratePageOptions) => Promise<PageDraft>;
  baseOptions: GeneratePageOptions;
  candidateCount: number;
  judgeModel: TextModelAdapter;
};

/** Temperature stagger between best-of candidates. */
const CANDIDATE_TEMPERATURE_STEP = 0.15;

export function bestOfCandidateCount(input: CreateProjectInput): number {
  const count = input.mediaSettings.draftCandidates ?? 1;
  return Math.max(1, Math.min(3, Math.floor(count)));
}

/**
 * Best-of-N drafting: samples candidate drafts at staggered temperatures and
 * asks a judge model to pick the strongest per a craft rubric. Falls back to
 * the first successful draft when judging fails.
 */
export async function generateBestOfPageDrafts(options: GenerateBestOfPageDraftsOptions): Promise<PageDraft> {
  const candidateCount = Math.max(1, Math.min(3, Math.floor(options.candidateCount)));
  if (candidateCount === 1) {
    return options.draftPage(options.baseOptions);
  }

  const baseTemperature = options.baseOptions.input.temperature;
  const attempts = await Promise.allSettled(
    Array.from({ length: candidateCount }, (_, index) =>
      options.draftPage({
        ...options.baseOptions,
        input: {
          ...options.baseOptions.input,
          temperature: Math.max(0, Math.min(2, baseTemperature + index * CANDIDATE_TEMPERATURE_STEP))
        }
      })
    )
  );
  const drafts = attempts.flatMap((attempt) => (attempt.status === "fulfilled" ? [attempt.value] : []));
  if (drafts.length === 0) {
    const firstFailure = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected"
    );
    throw firstFailure?.reason instanceof Error
      ? firstFailure.reason
      : new Error("All best-of page draft candidates failed.");
  }
  if (drafts.length === 1) {
    return drafts[0]!;
  }

  try {
    const chosenIndex = await judgePageDrafts({
      input: options.baseOptions.input,
      pageIndex: options.baseOptions.pageIndex,
      pageBriefSummary: options.baseOptions.pageBrief
        ? `${options.baseOptions.pageBrief.purpose} ${options.baseOptions.pageBrief.beat}`
        : undefined,
      drafts,
      judgeModel: options.judgeModel
    });
    return drafts[chosenIndex] ?? drafts[0]!;
  } catch {
    return drafts[0]!;
  }
}

async function judgePageDrafts(options: {
  input: CreateProjectInput;
  pageIndex: number;
  pageBriefSummary?: string | undefined;
  drafts: PageDraft[];
  judgeModel: TextModelAdapter;
}): Promise<number> {
  const result = await generateJsonWithJailbreak(options.judgeModel, {
    purpose: "judge-page-drafts",
    lessCensored: options.input.mediaSettings.lessCensored === true,
    jailbreakRole: "reviewer",
    temperature: 0.1,
    maxTokens: 600,
    schema: draftJudgementSchema,
    messages: [
      {
        role: "system",
        content: [
          "You are a senior fiction and non-fiction line editor judging competing drafts of the same book page.",
          "Pick the single strongest draft using this rubric, in priority order:",
          "1. Faithfulness to the page brief and concrete forward progression.",
          "2. Natural human prose: no scaffold phrases, no formulaic AI rhetoric, no placeholder text.",
          "3. Continuity with the book voice and characters.",
          "4. Specificity: concrete detail beats generic summary.",
          "Return JSON with chosenIndex (0-based index of the winning draft) and a one-sentence rationale."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            pageIndex: options.pageIndex,
            pageBrief: options.pageBriefSummary,
            category: options.input.category,
            candidates: options.drafts.map((draft, index) => ({
              index,
              title: draft.title,
              markdown: draft.markdown,
              summary: draft.summary
            }))
          },
          null,
          2
        )
      }
    ]
  });

  const chosenIndex = result.data.chosenIndex;
  if (chosenIndex < 0 || chosenIndex >= options.drafts.length) {
    return 0;
  }
  return chosenIndex;
}
