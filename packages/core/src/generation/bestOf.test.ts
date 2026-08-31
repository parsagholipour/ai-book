import { describe, expect, it } from "vitest";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  JsonResult,
  TextModelAdapter,
  TextResult,
  ToolCallsResult
} from "../adapters/types.js";
import type { CreateProjectInput, PageDraft } from "../schemas/book.js";
import type { ModelTier } from "../schemas/mediaSettings.js";
import {
  bestOfCandidateTemperatures,
  firstPageCandidateCount,
  generateBestOfPageDrafts,
  pageCandidateCount,
  type BestOfDraftBase
} from "./bestOf.js";

function inputForTier(modelTier?: ModelTier, draftCandidates?: number): CreateProjectInput {
  return {
    prompt: "A story about Jack.",
    category: "STORY",
    targetPages: 8,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral" as const,
      ...(modelTier ? { modelTier } : {}),
      ...(draftCandidates === undefined ? {} : { draftCandidates })
    }
  };
}

/**
 * The whole priced table, written out rather than derived: a candidate is a
 * full page draft (a writer-tool loop on the sequential ultra path), so these
 * four numbers are provider spend at the head of every book. Typed as a
 * `Record<ModelTier, …>` so a new tier fails to compile here as well as in
 * `bestOf.ts`, instead of quietly inheriting the most expensive row.
 */
const EXPECTED_FIRST_PAGE_CANDIDATES: Record<ModelTier, number> = {
  fast: 1,
  balanced: 2,
  premium: 3,
  ultra: 3
};

const MODEL_TIERS = Object.keys(EXPECTED_FIRST_PAGE_CANDIDATES) as ModelTier[];

describe("firstPageCandidateCount", () => {
  for (const tier of MODEL_TIERS) {
    it(`drafts ${EXPECTED_FIRST_PAGE_CANDIDATES[tier]} candidate(s) of page 1 on ${tier}`, () => {
      expect(firstPageCandidateCount(inputForTier(tier), 1)).toBe(EXPECTED_FIRST_PAGE_CANDIDATES[tier]);
    });

    it(`drafts one candidate of every later page on ${tier}`, () => {
      expect(firstPageCandidateCount(inputForTier(tier), 2)).toBe(1);
      expect(firstPageCandidateCount(inputForTier(tier), 8)).toBe(1);
    });
  }

  it("treats a book with no recorded tier as balanced", () => {
    expect(firstPageCandidateCount(inputForTier(), 1)).toBe(EXPECTED_FIRST_PAGE_CANDIDATES.balanced);
    expect(firstPageCandidateCount(inputForTier(), 2)).toBe(1);
  });
});

describe("pageCandidateCount", () => {
  const pageCases = [
    { label: "page 1", pageIndex: 1 },
    { label: "a later page", pageIndex: 2 }
  ] as const;
  const gateCases = [
    { label: "gate disabled", enabled: false },
    { label: "gate enabled", enabled: true }
  ] as const;
  const configuredCandidateCounts = [undefined, 1, 2, 3] as const;

  for (const tier of MODEL_TIERS) {
    for (const pageCase of pageCases) {
      for (const gateCase of gateCases) {
        for (const draftCandidates of configuredCandidateCounts) {
          const configuredLabel = draftCandidates === undefined ? "unset" : String(draftCandidates);

          it(`${tier}, ${pageCase.label}, ${gateCase.label}, draftCandidates ${configuredLabel}`, () => {
            const tierCount = pageCase.pageIndex === 1 ? EXPECTED_FIRST_PAGE_CANDIDATES[tier] : 1;
            const enabledPolishCount = gateCase.enabled ? (draftCandidates ?? 1) : 1;
            const result = pageCandidateCount(
              inputForTier(tier, draftCandidates),
              pageCase.pageIndex,
              gateCase.enabled
            );

            expect(result).toBe(Math.max(tierCount, enabledPolishCount));
            expect(result).toBeGreaterThanOrEqual(1);
            expect(result).toBeLessThanOrEqual(3);
          });
        }
      }
    }
  }
});

/**
 * Stands in for the worker's `StopRequestedError`, which `packages/core` cannot
 * import (`apps/* -> packages/db -> packages/core`). Identity is the whole
 * fixture: `isCancellationError` matches on the `name`, so this is exactly what
 * `LoggingEmbeddingAdapter.embed` and its siblings raise off
 * `assertJobNotStopped` as far as this module can tell.
 */
class StopRequestedError extends Error {
  constructor() {
    super("Generation stopped");
    this.name = "StopRequestedError";
  }
}

function draftNamed(title: string): PageDraft {
  return { title, markdown: `# ${title}`, summary: `${title} summary.`, continuityNotes: [] };
}

/** A judge that answers with `chosenIndex`, or throws whatever it was handed. */
function judgeModel(answer: { chosenIndex: number } | Error): TextModelAdapter {
  return {
    async generateJson<T>(_options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
      if (answer instanceof Error) {
        throw answer;
      }
      return { data: answer as T, text: JSON.stringify(answer), model: "test-model", provider: "test" };
    },
    async generateText(_options: GenerateTextOptions): Promise<TextResult> {
      throw new Error("Not used");
    },
    async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
      throw new Error("Not used");
    },
    async generateWithTools(_options: GenerateWithToolsOptions): Promise<ToolCallsResult> {
      throw new Error("Not used");
    }
  };
}

function bestOfOptions(
  draftPage: (options: BestOfDraftBase) => Promise<PageDraft>,
  judge: { chosenIndex: number } | Error = { chosenIndex: 0 }
) {
  return {
    draftPage,
    baseOptions: { input: inputForTier("premium"), pageIndex: 1 },
    candidateCount: 2,
    judgeModel: judgeModel(judge)
  };
}

describe("generateBestOfPageDrafts", () => {
  it("preserves compact draft context mode across every candidate", async () => {
    type ContextualDraftBase = BestOfDraftBase & { pageDraftContextMode: "compact" };
    const modes: string[] = [];

    await generateBestOfPageDrafts<ContextualDraftBase>({
      draftPage: async (options) => {
        modes.push(options.pageDraftContextMode);
        return draftNamed(`Draft ${options.input.temperature}`);
      },
      baseOptions: {
        input: inputForTier("premium"),
        pageIndex: 4,
        pageDraftContextMode: "compact"
      },
      candidateCount: 2,
      judgeModel: judgeModel({ chosenIndex: 0 })
    });

    expect(modes).toEqual(["compact", "compact"]);
  });

  it("propagates a candidate's stop even when a sibling candidate succeeded", async () => {
    const stopped = new StopRequestedError();
    const draftPage = async (options: BestOfDraftBase): Promise<PageDraft> => {
      if (options.input.temperature === 0.8) {
        throw stopped;
      }
      return draftNamed("Survivor");
    };

    // A surviving draft would send the handler into the review call — one more
    // provider call, billed, on a run the reader already cancelled.
    await expect(generateBestOfPageDrafts(bestOfOptions(draftPage))).rejects.toBe(stopped);
  });

  it("lets a stop beat a network error that rejected at a lower index", async () => {
    const stopped = new StopRequestedError();
    const draftPage = async (options: BestOfDraftBase): Promise<PageDraft> => {
      // Candidate 0 is the ladder's top rung, the book's own temperature; the
      // stagger puts the stop at candidate 1, where the old lowest-index
      // selection could not see it.
      throw options.input.temperature === 0.8
        ? Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
        : stopped;
    };

    // Reported as an ordinary failure this settles down the recovery policy and
    // may retry and re-bill; as a stop it becomes an `UnrecoverableError`.
    await expect(generateBestOfPageDrafts(bestOfOptions(draftPage))).rejects.toBe(stopped);
  });

  it("propagates a stop raised by the judge instead of falling back to a draft", async () => {
    const stopped = new StopRequestedError();
    const draftPage = async (options: BestOfDraftBase): Promise<PageDraft> =>
      draftNamed(`Draft ${options.input.temperature}`);

    await expect(generateBestOfPageDrafts(bestOfOptions(draftPage, stopped))).rejects.toBe(stopped);
  });

  it("still falls back to the first draft when the judge fails for any other reason", async () => {
    const draftPage = async (options: BestOfDraftBase): Promise<PageDraft> =>
      draftNamed(options.input.temperature === 0.8 ? "First" : "Second");

    const draft = await generateBestOfPageDrafts(bestOfOptions(draftPage, new Error("judge unavailable")));

    expect(draft.title).toBe("First");
  });

  it("still returns the surviving draft when one candidate fails for an ordinary reason", async () => {
    const draftPage = async (options: BestOfDraftBase): Promise<PageDraft> => {
      if (options.input.temperature === 0.8) {
        throw new Error("provider returned 500");
      }
      return draftNamed("Survivor");
    };

    const draft = await generateBestOfPageDrafts(bestOfOptions(draftPage));

    expect(draft.title).toBe("Survivor");
  });

  it("reports the lowest-index failure when every candidate fails for an ordinary reason", async () => {
    const draftPage = async (options: BestOfDraftBase): Promise<PageDraft> => {
      throw new Error(options.input.temperature === 0.8 ? "first failure" : "second failure");
    };

    await expect(generateBestOfPageDrafts(bestOfOptions(draftPage))).rejects.toThrow("first failure");
  });
});

/**
 * The ladder as the sequential draft path sees it: `generatePage.ts` hands
 * `baseOptions` the book's own input, untouched, so what these record is what a
 * real page-1 fan-out sends the provider.
 */
async function draftLadderFor(book: CreateProjectInput, candidateCount: number): Promise<number[]> {
  const sampled: number[] = [];
  await generateBestOfPageDrafts({
    draftPage: async (options: BestOfDraftBase) => {
      sampled.push(options.input.temperature);
      return draftNamed(`Draft ${options.input.temperature}`);
    },
    baseOptions: { input: book, pageIndex: 1 },
    candidateCount,
    judgeModel: judgeModel({ chosenIndex: 0 })
  });
  return sampled;
}

describe("the draft path's candidate ladder", () => {
  it("never samples hotter than the book asked for, at the default temperature", async () => {
    const book = inputForTier("premium");
    const ladder = await draftLadderFor(book, 3);

    // The ladder used to climb from the book's temperature, so this fan-out
    // drafted page 1 at 0.8, 0.95 and 1.1 — and page 1 is the style lock, so a
    // 1.1 candidate that won the judge became the voice of the whole book.
    expect(ladder).toHaveLength(3);
    expect(new Set(ladder).size).toBe(3);
    expect(Math.max(...ladder)).toBeCloseTo(book.temperature, 10);
    for (const temperature of ladder) {
      expect(temperature).toBeLessThanOrEqual(book.temperature);
      expect(temperature).toBeGreaterThanOrEqual(0);
    }
  });

  it("compresses the step rather than climbing out of a narrow band", async () => {
    // `temperature` is `min(0)`, so 0.2 is a legal book and 0.2 is narrower than
    // two full steps. Spread over the band the book allows, the candidates stay
    // distinct and stay under its top; staggering from a floored base gave this
    // book 0.0, 0.15 and 0.30.
    const cool = { ...inputForTier("premium"), temperature: 0.2 };
    const ladder = await draftLadderFor(cool, 3);

    expect(new Set(ladder).size).toBe(3);
    expect(Math.max(...ladder)).toBeCloseTo(0.2, 10);
    expect(Math.min(...ladder)).toBeGreaterThanOrEqual(0);
    expect(ladder[0]! - ladder[1]!).toBeCloseTo(ladder[1]! - ladder[2]!, 10);
  });

  it("drafts once, at the book's own temperature, when it asked for deterministic sampling", async () => {
    const deterministic = { ...inputForTier("premium"), temperature: 0 };

    // Three samples of a deterministic draft are one draft plus a judge picking
    // between copies of it. The old ladder answered this book with 0, 0.15 and
    // 0.30 — three calls, two of them hotter than it asked for.
    expect(await draftLadderFor(deterministic, 3)).toEqual([0]);
  });

  it("hands a book that does not best-of the options it was given", async () => {
    const baseOptions = { input: inputForTier("fast"), pageIndex: 1 };
    let received: BestOfDraftBase | undefined;

    await generateBestOfPageDrafts({
      draftPage: async (options: BestOfDraftBase) => {
        received = options;
        return draftNamed("Only");
      },
      baseOptions,
      candidateCount: 1,
      judgeModel: judgeModel({ chosenIndex: 0 })
    });

    // Identity, not equality: a single-candidate call must be the call the page
    // would have made with no best-of in the pipeline at all.
    expect(received).toBe(baseOptions);
  });
});

describe("bestOfCandidateTemperatures", () => {
  it("descends from the top by one step per candidate", () => {
    const ladder = bestOfCandidateTemperatures(0.8, 3);

    expect(ladder[0]).toBeCloseTo(0.8, 10);
    expect(ladder[0]! - ladder[1]!).toBeCloseTo(ladder[1]! - ladder[2]!, 10);
    expect(ladder[2]).toBeLessThan(ladder[0]!);
  });

  it("clamps a top outside the provider range instead of sampling outside it", () => {
    expect(bestOfCandidateTemperatures(9, 1)).toEqual([2]);
    expect(Math.max(...bestOfCandidateTemperatures(-1, 3))).toBe(0);
  });
});
