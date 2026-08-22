import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { generateBestOfPageDrafts } from "./bestOf.js";
import { REWRITE_TEMPERATURE_CEILING, polishPageDraft, polishPageTemperature } from "./pages.js";

/**
 * The polish pass's temperature, and the one thing that reads it apart from the
 * provider: `generateBestOfPageDrafts`, whose ladder descends from whatever this
 * path hands it. Every assertion here is about one rule — no candidate samples
 * hotter than the pass would have run at on its own — so nothing below names
 * 0.65 or 0.15 in its own words.
 */

const input = {
  prompt: "Jack The Martyr, a character-led story about sacrifice and consequence.",
  category: "STORY",
  targetPages: 4,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
} as CreateProjectInput;

const plan = makeFallbackPlan(input);

const markdown =
  "The chapel door had been painted black so many times that the grain underneath looked bruised. Jack pressed two fingers to the iron latch and felt it tremble before anyone touched it from the other side.";

const draft = { title: "The Wall Bell", markdown, summary: "Jack is caught mid-climb.", continuityNotes: [] };

/** Records the temperature of every polish call, and answers the judge honestly. */
function recordingModel() {
  const polishTemperatures: number[] = [];
  const model: TextModelAdapter = {
    async generateText() {
      return { text: "", model: "test-model", provider: "test" };
    },
    async generateJson(options) {
      if (options.purpose === "judge-page-drafts") {
        return {
          data: options.schema.parse({ chosenIndex: 0, rationale: "First." }),
          text: "{}",
          model: "test-model",
          provider: "test"
        };
      }
      polishTemperatures.push(options.temperature ?? Number.NaN);
      return { data: options.schema.parse(draft), text: "{}", model: "test-model", provider: "test" };
    },
    async *streamText() {
      yield "";
    },
    generateWithTools: unsupportedGenerateWithTools
  };
  return { polishTemperatures, model };
}

function polishOptions(book: CreateProjectInput, textModel: TextModelAdapter) {
  return {
    input: book,
    plan,
    pageIndex: 1,
    draft,
    previousPages: [],
    nextPages: [],
    continuityNotes: [],
    researchNotes: [],
    textModel
  };
}

/** What one polish call — the whole of a book that never best-ofs — samples at. */
async function soloPolishTemperature(book: CreateProjectInput): Promise<number> {
  const recorder = recordingModel();
  await polishPageDraft(polishOptions(book, recorder.model));
  expect(recorder.polishTemperatures).toHaveLength(1);
  return recorder.polishTemperatures[0]!;
}

/**
 * The polish path's own wiring, mirrored from `polishPageWithQualityGates`
 * (`apps/worker/src/generation/qualityDrafting.ts`): best-of is handed the
 * temperature a candidate-free polish would have run at, and builds its ladder
 * down from there.
 */
async function bestOfPolishTemperatures(book: CreateProjectInput, candidateCount: number): Promise<number[]> {
  const recorder = recordingModel();
  const base = polishOptions(book, recorder.model);
  await generateBestOfPageDrafts({
    draftPage: (options) => polishPageDraft({ ...base, input: options.input }),
    baseOptions: { ...base, input: { ...book, temperature: polishPageTemperature(book) } },
    candidateCount,
    judgeModel: recorder.model
  });
  return recorder.polishTemperatures;
}

describe("best-of polish temperatures", () => {
  it("staggers page-1 candidates below the temperature a lone polish runs at", async () => {
    const solo = await soloPolishTemperature(input);
    const staggered = await bestOfPolishTemperatures(input, 3);

    expect(staggered).toHaveLength(3);
    expect(new Set(staggered).size).toBe(3);
    // The protection is the point of the exercise: the hottest candidate is the
    // temperature a candidate-free polish already runs at, so no book that
    // skips best-of moves, and nothing samples above it.
    expect(Math.max(...staggered)).toBeCloseTo(solo, 10);
    for (const temperature of staggered) {
      expect(temperature).toBeLessThanOrEqual(solo);
    }
    // Evenly spaced, read off the ladder rather than restated: handing best-of
    // the book's raw 0.8 instead clamped the top rungs together and bought
    // sampling noise for the extra polish calls and the judge.
    expect(staggered[0]! - staggered[1]!).toBeCloseTo(staggered[1]! - staggered[2]!, 10);
    expect(staggered[0]! - staggered[1]!).toBeGreaterThan(0);
  });

  it("keeps every candidate of a book cooler than the ceiling inside its own temperature", async () => {
    // `temperature` is `min(0)`, so a project can be created at 0.2 — a band too
    // narrow for the full stagger. Lowering the ladder until it fit used to
    // floor at zero and stagger back up out of the band: 0.0, 0.15 and 0.30, the
    // last of them half again what the book asked for, and far too cool for
    // `polishPageDraft`'s own clamp to catch.
    const cool = { ...input, temperature: 0.2 } as CreateProjectInput;
    const solo = await soloPolishTemperature(cool);
    expect(solo).toBeCloseTo(0.2, 10);

    const staggered = await bestOfPolishTemperatures(cool, 3);

    expect(staggered).toHaveLength(3);
    expect(new Set(staggered).size).toBe(3);
    expect(Math.max(...staggered)).toBeCloseTo(solo, 10);
    for (const temperature of staggered) {
      expect(temperature).toBeLessThanOrEqual(solo);
      expect(temperature).toBeGreaterThanOrEqual(0);
    }
  });

  it("spends one polish call on a book that asked for deterministic sampling", async () => {
    // At 0 there is no band to spread over, so candidates would be copies of
    // each other and the judge would pick between them. The old ladder answered
    // this book with 0, 0.15 and 0.30 — three calls, two of them above what it
    // asked for.
    const deterministic = { ...input, temperature: 0 } as CreateProjectInput;

    expect(await bestOfPolishTemperatures(deterministic, 3)).toEqual([0]);
  });

  it("polishes at the shared rewrite ceiling, and a cooler book at its own temperature", async () => {
    // The ceiling is one constant, read here rather than restated: moving
    // `REWRITE_TEMPERATURE_CEILING` moves this assertion and `repairPageBrief`'s
    // twin in pagesPageMap.test.ts together.
    expect(await soloPolishTemperature(input)).toBeCloseTo(REWRITE_TEMPERATURE_CEILING, 10);
    expect(polishPageTemperature(input)).toBeCloseTo(REWRITE_TEMPERATURE_CEILING, 10);

    const cool = { ...input, temperature: REWRITE_TEMPERATURE_CEILING - 0.1 } as CreateProjectInput;
    expect(polishPageTemperature(cool)).toBeCloseTo(cool.temperature, 10);
  });
});
