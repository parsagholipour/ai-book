import { z } from "zod";
import { isCancellationError } from "../adapters/retry.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { modelTierForInput } from "../adapters/modelTiers.js";
import type { CreateProjectInput, PageDraft } from "../schemas/book.js";
import type { ModelTier } from "../schemas/mediaSettings.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

const draftJudgementSchema = z.object({
  chosenIndex: z.coerce.number().int().min(0),
  rationale: z.string().default("")
});

/** The fields best-of needs from a draft or polish options object. */
export type BestOfDraftBase = {
  input: CreateProjectInput;
  pageIndex: number;
  pageBrief?: { purpose: string; beat: string } | undefined;
};

export type GenerateBestOfPageDraftsOptions<T extends BestOfDraftBase = BestOfDraftBase> = {
  /** Draft sampler: generatePageDraft, polishPageDraft, or a writer-tools wrap. */
  draftPage: (options: T) => Promise<PageDraft>;
  baseOptions: T;
  candidateCount: number;
  judgeModel: TextModelAdapter;
};

/** Temperature stagger between best-of candidates, when the band has room for it. */
export const CANDIDATE_TEMPERATURE_STEP = 0.15;

/** The widest temperature any provider on this path accepts. */
const MAX_SAMPLING_TEMPERATURE = 2;

/**
 * The temperatures one best-of fan-out samples at, hottest first.
 *
 * **No candidate may sample hotter than the pass would have run at with no
 * candidates at all.** `topTemperature` is that temperature — the book's own
 * `input.temperature` on the draft path, `polishPageTemperature`'s clamped
 * value (`pages.ts`) on the polish path — and the ladder *descends* from it, one
 * step per candidate. Best-of exists to sample **around** what the book asked
 * for, never above it.
 *
 * The ladder used to climb from that temperature instead, which was a
 * degenerate corner behind an ultra-only operator flag until
 * {@link firstPageCandidateCount} made page-1 best-of the default for every
 * balanced-and-up book: at the default `temperature` of 0.8 the candidates were
 * drafted at 0.8, 0.95 and **1.1**. Page 1 is the style lock
 * (`loadStyleLockPages`, `apps/worker/src/generation/bookHelpers.ts`) — pages
 * 1-2 are pinned into every later page's draft prompt *and* into the review
 * that scores it — so a 1.1 candidate that won the judge became the voice the
 * whole book was written and audited against.
 *
 * Descending is also what keeps a book that never best-ofs byte-identical: the
 * hottest rung is exactly where the candidate-free pass already runs, and
 * candidate 0 is what an unjudged best-of falls back to, so a failed judge
 * returns the draft the book would have got anyway.
 *
 * **A band too narrow for the ladder compresses the step; it never widens the
 * band.** `temperature` is `min(0)` (`schemas/mediaSettings.ts`), so a book
 * created at 0.2 cannot fit two 0.15 steps below its own top. Lowering the
 * ladder until it fits — `max(0, top - (count - 1) * step)` — is the same bug
 * pointing the other way: the floor at zero silently widens the band *above*
 * the top, and that 0.2 book sampled candidates at 0.0, 0.15 and **0.30**.
 * Spreading the candidates over whatever band the book allows keeps them
 * distinct and keeps every one of them at or under the top. A book at exactly 0
 * has no band to spread over at all, and {@link generateBestOfPageDrafts}
 * spends nothing there: N samples of a draft the book asked to be deterministic
 * are one draft, plus a judge picking between copies of it.
 */
export function bestOfCandidateTemperatures(topTemperature: number, candidateCount: number): number[] {
  const count = Math.max(1, Math.floor(candidateCount));
  const top = Math.max(0, Math.min(MAX_SAMPLING_TEMPERATURE, topTemperature));
  if (count === 1) {
    return [top];
  }
  const step = Math.min(CANDIDATE_TEMPERATURE_STEP, top / (count - 1));
  return Array.from({ length: count }, (_, index) => top - index * step);
}

export function bestOfCandidateCount(input: CreateProjectInput): number {
  const count = input.mediaSettings.draftCandidates ?? 1;
  return Math.max(1, Math.min(3, Math.floor(count)));
}

/**
 * How many drafts the opening page is sampled at before a judge picks one.
 *
 * Exhaustive by type, because the cheap-looking spelling of this table defaults
 * to its most expensive branch. It was `tier === "balanced" ? 2 : 3`, which
 * reads as a table right up until a fifth `ModelTier` exists: a new, cheaper
 * tier would have fallen through to three drafts of page 1 on every book on it,
 * with nothing failing to compile and no symptom but the provider bill. Keyed
 * by the enum for the same reason `JOB_STEP_TEMPLATES` (`../jobSteps.ts`) is —
 * a tier nobody priced here is a compile error until somebody does.
 */
const FIRST_PAGE_CANDIDATES_BY_TIER: Record<ModelTier, number> = {
  fast: 1,
  balanced: 2,
  premium: 3,
  ultra: 3
};

/**
 * **A candidate is a whole page draft, not a cheap extra call.** Callers hand
 * `generateBestOfPageDrafts` their own `draftPage`, so each candidate costs
 * exactly what the single draft it replaces would have. On the sequential path
 * (`apps/worker/src/handlers/generatePage.ts`) that wrapper is
 * `generatePageDraftWithWriterTools` whenever the `writerTools` gate is on, and
 * page 1 does not escape the loop: `shouldSkipWriterTools` (`writerTools.ts`)
 * skips it only when the story state *and* the research notes are empty, while
 * `loadProjectStoryState` has already seeded that state from `plan.promises`.
 * So three candidates are three multi-turn tool loops in flight at the head of
 * the book's fan-out, and a factual book reaches the same place through its
 * research notes. Only the polish path (`polishPageWithQualityGates`) is one
 * call per candidate. The counts are a deliberate spend, and the tier is what
 * decides which books can afford it.
 *
 * What that buys is the page it is least survivable to get wrong. Pages 1-2 are
 * the style lock (`loadStyleLockPages`,
 * `apps/worker/src/generation/bookHelpers.ts`), pinned into every later page's
 * draft prompt *and* into the review that scores it — so a weak opening is not
 * one bad page, it is the voice the rest of the book is written to and audited
 * against, copied forward long before anything downstream can notice.
 */
export function firstPageCandidateCount(input: CreateProjectInput, pageIndex: number): number {
  if (pageIndex !== 1) {
    return 1;
  }
  return FIRST_PAGE_CANDIDATES_BY_TIER[modelTierForInput(input)];
}

/**
 * Combines the two independent doors into best-of page generation.
 *
 * The operator door is the `bestOfPolish` quality gate — compiled default
 * ultra, but whatever tiers an operator has checked — opened only as wide as
 * the project's `draftCandidates` through {@link bestOfCandidateCount}. With
 * the gate off, that configured count does not affect page generation.
 *
 * The opening-page door is {@link firstPageCandidateCount}, decided by the
 * model tier alone with no flag to set. Fast's opening-page count is one, so a
 * fast book reaches best-of only through the operator door.
 *
 * These doors compose with `Math.max`, never multiplication: enabling the
 * operator gate cannot multiply the tier's opening-page spend. Both inputs to
 * the maximum are already constrained to the existing one-to-three candidate
 * bounds, so the composed result stays within those bounds too.
 */
export function pageCandidateCount(
  input: CreateProjectInput,
  pageIndex: number,
  bestOfPolishEnabled: boolean
): number {
  return Math.max(
    bestOfPolishEnabled ? bestOfCandidateCount(input) : 1,
    firstPageCandidateCount(input, pageIndex)
  );
}

/**
 * Best-of-N drafting: samples candidate drafts down the temperature ladder
 * {@link bestOfCandidateTemperatures} builds and asks a judge model to pick the
 * strongest per a craft rubric. Falls back to the first successful draft — the
 * hottest rung, the draft the pass would have produced on its own — when a
 * candidate or the judge fails; a stop request excepted, which leaves through
 * every path here rather than being raced against a sibling; see the invariant
 * on the fan-out below.
 */
export async function generateBestOfPageDrafts<T extends BestOfDraftBase>(
  options: GenerateBestOfPageDraftsOptions<T>
): Promise<PageDraft> {
  const candidateCount = Math.max(1, Math.min(3, Math.floor(options.candidateCount)));
  const temperatures = bestOfCandidateTemperatures(options.baseOptions.input.temperature, candidateCount);
  // One rung is not a ladder. A single candidate is the ordinary case; a band
  // with no width is a book that asked for deterministic sampling, where the
  // candidates would be copies of each other and the judge would be picking
  // between them. Both hand the pass its own options untouched, so a book that
  // does not best-of makes exactly the call it made before best-of existed.
  if (new Set(temperatures).size === 1) {
    return options.draftPage(options.baseOptions);
  }

  const attempts = await Promise.allSettled(
    temperatures.map((temperature) =>
      options.draftPage({
        ...options.baseOptions,
        input: { ...options.baseOptions.input, temperature }
      })
    )
  );
  const drafts = attempts.flatMap((attempt) => (attempt.status === "fulfilled" ? [attempt.value] : []));
  const failures = attempts.flatMap((attempt) => (attempt.status === "rejected" ? [attempt.reason as unknown] : []));

  /**
   * **A cancellation escapes the fan-out; it is never raced against a sibling.**
   * `allSettled` is the right tool for candidates — one provider failure out of
   * three must not cost the page its other two drafts — but it files a stop as
   * just another rejected slot, and page 1 of every balanced-and-up book now
   * comes through here ({@link firstPageCandidateCount}), so this is the head of
   * essentially every book rather than an ultra-only opt-in.
   *
   * It goes wrong two ways. A sibling that *fulfilled* hides the stop outright:
   * the reader hits Stop mid-draft, this hands back the surviving draft, and the
   * handler walks straight into the review call — a provider call the reader
   * cancelled and is still billed for, because the run only notices at the next
   * `assertJobNotStopped`. And when nothing survives, the error selection below
   * takes the *lowest-index* rejection, so an ordinary network error at
   * candidate 0 masks the stop at candidate 1 — which settles down the wrong
   * path altogether: `processJob` (`apps/worker/src/processJob.ts`) turns a
   * `StopRequestedError` into an `UnrecoverableError` so BullMQ lets it lie,
   * while an ordinary failure goes through the recovery policy and may retry and
   * re-bill the whole page.
   *
   * So: wait for every candidate, then decide rather than race — the shape
   * `settleIndependentLoads` (`apps/worker/src/generation/independentLoads.ts`) holds
   * over the page's independent loads, and the rule `runToolLoop` holds one layer
   * down, where only a tool *failure* may become a tool result. The predicate is
   * {@link isCancellationError}, which reads the error's *identity* — an
   * `AbortError`/`StopRequestedError` `name`, an `ABORT_ERR` code, over every
   * nested `cause` — because the class itself, the worker's `StopRequestedError`,
   * sits on the far side of `apps/* -> packages/db -> packages/core` and cannot
   * be imported here.
   */
  for (const failure of failures) {
    if (isCancellationError(failure)) {
      throw failure;
    }
  }

  if (drafts.length === 0) {
    const firstFailure = failures[0];
    throw firstFailure instanceof Error ? firstFailure : new Error("All best-of page draft candidates failed.");
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
  } catch (error) {
    // The judge is a provider call like any other, so it raises the stop too,
    // and the same rule applies to it: falling back to the first draft here
    // writes and bills the page the reader cancelled, exactly as returning a
    // surviving candidate above would. Everything else a judge can throw is a
    // judgement nobody needs — an unjudged best-of is the first draft, not a
    // failed page.
    if (isCancellationError(error)) {
      throw error;
    }
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
  const result = await generateJsonWithRetry(options.judgeModel, {
    purpose: "judge-page-drafts",
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
          ...(options.pageIndex === 1
            ? [
                "This is the book's opening page: weigh the strength and speed of the hook heavily - how fast the first paragraph gives a reader a concrete reason to keep reading."
              ]
            : []),
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
