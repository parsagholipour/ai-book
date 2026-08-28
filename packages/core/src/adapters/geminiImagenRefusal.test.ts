import { afterEach, describe, expect, it, vi } from "vitest";
import { isImageContentRefusalError } from "./imageRefusal.js";
import { imageRefusalCategory } from "./imageRefusalVerdict.js";
import { missingImagenImageError } from "./geminiImagenRefusal.js";
import { GeminiImageAdapter } from "./gemini.js";

/**
 * The reading `missingImagenImageError` does over an Imagen answer, one step
 * below the adapter that calls it.
 *
 * Every case here turns on the same distinction: `safetyAttributes` is a
 * standing score table the endpoint returns whether or not anything tripped,
 * while `raiFilteredReason` is the filter's own statement about *this* block.
 * Only the second may decide anything, because `reason` is bare-word-tested by
 * the child-safety veto and the table names `Porn` on every answer there is.
 */

const COPYRIGHT_BLOCK = "Filtered: the prompt names a copyrighted character.";

const refusalFor = (attributes: Record<string, unknown>, raiFilteredReason = COPYRIGHT_BLOCK) =>
  missingImagenImageError("imagen-4.0-generate-001", {
    generatedImages: [{ raiFilteredReason }],
    positivePromptSafetyAttributes: { contentType: "Positive Prompt", ...attributes }
  });

const STANDING_LIST = ["Death, Harm & Tragedy", "Porn", "Violence"];

/** Imagen's own standing RAI list, verbatim from the endpoint's documented answer. */
const IMAGEN_STANDING_CATEGORIES = [
  "Death, Harm & Tragedy",
  "Firearms & Weapons",
  "Hate",
  "Health",
  "Illicit Drugs",
  "Politics",
  "Porn",
  "Religion & Belief",
  "Toxic",
  "Violence",
  "Vulgarity",
  "War & Conflict"
];

describe("missingImagenImageError", () => {
  it("leaves a copyright rewrite reachable when the table scores an unrelated category", () => {
    // The shape a real copyright-blocked prompt came back with. Every gate that
    // folded a *scored* category into the reason let this one through: 0.1 on
    // `Porn` is enough for `> 0`, `NEVER_REWRITABLE_CODE` matches `/porn/i`,
    // and the rewrite this whole path exists for was refused before the run log
    // heard about it. The 0.8 beside it is the argument against every threshold
    // — a category at the top of the range that belonged to no part of the
    // block.
    const error = refusalFor({ categories: STANDING_LIST, scores: [0, 0.1, 0.8] });

    expect(isImageContentRefusalError(error)).toBe(true);
    expect(error).toMatchObject({ reason: "RAI_FILTERED" });
    expect(imageRefusalCategory(error)).toBe("copyright");
  });

  it("still vetoes a block the filter itself calls child safety", () => {
    // The veto is not inert on this endpoint, it just reads the half with
    // evidence in it. A rewrite may only remove protected names, so it must
    // never be bought for a refusal that named this — whatever else the same
    // sentence names.
    const error = refusalFor(
      { categories: STANDING_LIST, scores: [0, 0, 0] },
      "Blocked for child safety. The prompt also names a copyrighted character. Support codes: 58061214"
    );

    expect(isImageContentRefusalError(error)).toBe(true);
    expect(imageRefusalCategory(error)).toBe("other");
  });

  it("vetoes on a category the sentence names that the prose half would miss", () => {
    // `NEVER_REWRITABLE_VOCABULARY` spells the harm word `pornograph\w*`, so a
    // sentence naming the category `Porn` outright reaches nothing on the prose
    // side. Folded into `reason` — and only because the sentence named it — it
    // meets `NEVER_REWRITABLE_CODE`'s `/porn/i` instead.
    const error = refusalFor(
      { categories: STANDING_LIST, scores: [0, 0.9, 0] },
      "Filtered for Porn. The prompt also names a copyrighted character."
    );

    expect(error).toMatchObject({ reason: "RAI_FILTERED: Porn" });
    expect(imageRefusalCategory(error)).toBe("other");
  });

  it("takes the sentence's word for a category the table never scored", () => {
    // The intersection runs the other way too: the assertion is the sentence's,
    // the spelling is the table's, and a zero beside the name is a reading of
    // the prompt rather than a statement about the block.
    const error = refusalFor(
      { categories: STANDING_LIST, scores: [0, 0, 0] },
      "Filtered for Porn. The prompt also names a copyrighted character."
    );

    expect(error).toMatchObject({ reason: "RAI_FILTERED: Porn" });
    expect(imageRefusalCategory(error)).toBe("other");
  });

  it("does not let a scene word in the sentence become the filter's verdict", () => {
    // The rule `isNeverRewritableRefusal` is written under, one door along: a
    // bare word test over prose meets the scene sooner or later, and the scene
    // here is a children's book. A filter verb has to govern the category
    // across a closed gap, so a verdict at the start of a sentence cannot claim
    // a word at the end of it.
    const error = refusalFor(
      { categories: STANDING_LIST, scores: [0, 0, 0] },
      "The request was blocked. The scene shows a child reading beside a copyrighted character."
    );

    expect(error).toMatchObject({ reason: "RAI_FILTERED" });
    expect(imageRefusalCategory(error)).toBe("copyright");
  });

  it("does not fold a category the boilerplate merely mentions", () => {
    // The threshold sentence is what most Imagen blocks come back with, and the
    // standing table names every category there is beside it.
    const error = refusalFor(
      { categories: ["Porn", "Child", "Violence"], scores: [0.4, 0.4, 0.4] },
      "The image was filtered because the prompt names a copyrighted character. Support codes: 29310472"
    );

    expect(error).toMatchObject({ reason: "RAI_FILTERED" });
    expect(imageRefusalCategory(error)).toBe("copyright");
  });

  it("reads a category out of a labelled heading too", () => {
    const error = refusalFor(
      { categories: STANDING_LIST, scores: [0, 0, 0] },
      "Category: Porn. The prompt also names a copyrighted character."
    );

    expect(error).toMatchObject({ reason: "RAI_FILTERED: Porn" });
    expect(imageRefusalCategory(error)).toBe("other");
  });

  it("records the whole table as diagnostics, scored or not", () => {
    const error = refusalFor({ categories: STANDING_LIST, scores: [0, 0.1, 0.8] });

    expect((error as { diagnostics?: string }).diagnostics).toBe(
      "PROMPT Death, Harm & Tragedy=0, PROMPT Porn=0.1, PROMPT Violence=0.8"
    );
    // And it stays out of the message, because the message is prose and prose
    // is evidence.
    expect((error as Error).message).not.toContain("Porn");
  });

  describe("a scores array that cannot be read", () => {
    // Each of these used to fall *toward* the veto, one category at a time, and
    // each one on its own was a permanent refusal for a book that asked for a
    // character by name. They decide nothing now: an unreadable reading is
    // written down as `?` and the category is a candidate word either way.
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["omitted", {}, "PROMPT Death, Harm & Tragedy=?, PROMPT Porn=?, PROMPT Violence=?"],
      ["shorter than the categories", { scores: [0] }, "PROMPT Death, Harm & Tragedy=0, PROMPT Porn=?, PROMPT Violence=?"],
      [
        "string-typed",
        { scores: ["0", "0", "0.8"] },
        "PROMPT Death, Harm & Tragedy=?, PROMPT Porn=?, PROMPT Violence=?"
      ],
      [
        "not an array at all",
        { scores: 0.8 },
        "PROMPT Death, Harm & Tragedy=?, PROMPT Porn=?, PROMPT Violence=?"
      ],
      [
        "holding a NaN",
        { scores: [Number.NaN, Number.NaN, Number.NaN] },
        "PROMPT Death, Harm & Tragedy=?, PROMPT Porn=?, PROMPT Violence=?"
      ]
    ];

    it.each(cases)("keeps the rewrite reachable when scores are %s", (_label, attributes, diagnostics) => {
      const error = refusalFor({ categories: STANDING_LIST, ...attributes });

      expect(error).toMatchObject({ reason: "RAI_FILTERED" });
      expect((error as { diagnostics?: string }).diagnostics).toBe(diagnostics);
      expect(imageRefusalCategory(error)).toBe("copyright");
    });
  });

  it("names no category when the table is missing or unusable", () => {
    const error = refusalFor({ categories: "Porn" });

    expect(error).toMatchObject({ reason: "RAI_FILTERED" });
    expect((error as { diagnostics?: string }).diagnostics).toBeUndefined();
    expect(imageRefusalCategory(error)).toBe("copyright");
  });

  it("reads a separator-stuffed sentence in bounded time", () => {
    // `raiFilteredReason` is provider text, and the gap between a filter verb
    // and a category used to be spelled so that adjacent `\s*` could each claim
    // the same run of spaces — three parses per separator, tried exhaustively
    // before the match failed. One regex per category and a standing table
    // twelve entries long multiplied it: `" - ".repeat(16)` measured 2.79 s
    // through this call, and every millisecond of it is the worker's only
    // thread inside a generate-image job, which is how BullMQ comes to call the
    // job stalled and hand it to a second worker. The budget here is ~10× the
    // post-fix cost of the *larger* input below and ~1/10th of the old cost of
    // the smaller one, so it cannot pass by accident either way.
    for (const separators of [16, 28]) {
      const started = performance.now();
      const error = refusalFor(
        { categories: IMAGEN_STANDING_CATEGORIES, scores: IMAGEN_STANDING_CATEGORIES.map(() => 0) },
        `blocked${" - ".repeat(separators)}ZZZ`
      );
      expect(performance.now() - started).toBeLessThan(250);
      // And the reading is unchanged: nothing in that sentence is a category.
      expect(error).toMatchObject({ reason: "RAI_FILTERED" });
    }
  });

  it("is an ordinary failure when no entry names a filter", () => {
    // A picture that never arrived is not a picture that was refused: the
    // scores are returned for a drawn picture as readily as for a filtered one,
    // so reading them as a verdict would settle an Imagen blip as permanent.
    const error = missingImagenImageError("imagen-4.0-generate-001", {
      generatedImages: [{ safetyAttributes: { categories: STANDING_LIST, scores: [0, 0.9, 0.8] } }],
      positivePromptSafetyAttributes: { categories: STANDING_LIST, scores: [0, 0.9, 0.8] }
    });

    expect(isImageContentRefusalError(error)).toBe(false);
    expect((error as Error).message).toContain("did not return image bytes");
  });
});

/**
 * The same reading, but reached the way production reaches it — through the
 * real `GoogleGenAI` client over a stubbed transport, because between the wire
 * and `missingImagenImageError` sits an SDK step that can *delete* the verdict.
 *
 * `models.generateImages` walks the predictions and, for any entry whose
 * `safetyAttributes.contentType` is `"Positive Prompt"`, lifts the attributes
 * to top-level `positivePromptSafetyAttributes` and drops the entry — its
 * `raiFilteredReason` with it. Nothing recovers one: the SDK rebuilds its
 * answer as `generatedImages` / `positivePromptSafetyAttributes` /
 * `sdkHttpResponse`, `SafetyAttributes` maps only `categories`, `scores` and
 * `contentType`, and `sdkHttpResponse` carries headers with no body. And
 * `includeSafetyAttributes` is the only thing that makes Imagen stamp any
 * prediction at all, so the flag that buys the diagnostics is the flag that
 * arms the discard.
 *
 * What keeps the two from colliding is the endpoint, not the SDK: Imagen
 * returns the prompt's attributes as their *own* prediction, and "if an output
 * image is filtered its safety attributes aren't returned" — so the entry
 * carrying the reason carries no `safetyAttributes`, has no `contentType` to be
 * stamped with, and is never a candidate for the discard. Both halves are
 * pinned below, because a stubbed `ai.models` would forward whatever it was
 * handed and see none of this.
 */
describe("an Imagen block through the real SDK client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const RAI_SENTENCE =
    "Unable to show generated images. All images were filtered out because they violated " +
    "Vertex AI's usage guidelines. Try rephrasing the prompt. Support codes: 29310472";

  const PROMPT_ATTRIBUTES = {
    contentType: "Positive Prompt",
    safetyAttributes: { categories: ["Porn", "Violence"], scores: [0.2, 0.1] }
  };

  const answerWith = (predictions: unknown[]) => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ predictions }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    return new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" })
      .generateImage({ prompt: "Illustrate Nora." })
      .catch((thrown: unknown) => thrown);
  };

  it("survives the SDK when the reason rides its own prediction", async () => {
    // The documented shape: the filtered output image reports a reason and no
    // attributes, and the prompt's table is a separate entry. The entry the SDK
    // discards is the one with nothing to lose, so the refusal arrives whole —
    // and the diagnostics arrive with it, which is the flag paying for itself.
    // If an SDK bump ever widened that discard, this is what would fail.
    const error = await answerWith([{ raiFilteredReason: RAI_SENTENCE }, PROMPT_ATTRIBUTES]);

    expect(isImageContentRefusalError(error)).toBe(true);
    expect(error).toMatchObject({ reason: "RAI_FILTERED" });
    expect((error as { detail?: string }).detail).toContain("usage guidelines");
    expect((error as { diagnostics?: string }).diagnostics).toBe("PROMPT Porn=0.2, PROMPT Violence=0.1");
  });

  it("would lose the verdict if the reason ever rode the prompt's entry", async () => {
    // The boundary, stated rather than assumed. A reason on a stamped entry is
    // deleted by the SDK: `generatedImages` comes back empty, nothing names a
    // filter, and every Imagen block degrades to the retryable `Error` that
    // `includeRaiReason` was turned on to replace — the original bug, back
    // through its own fix. Imagen cannot produce that entry, which is the only
    // reason `includeSafetyAttributes` is safe to ask for; this test is what
    // says so out loud, so a future reader weighing the flag has the failure
    // mode in front of them instead of having to rediscover it.
    const error = await answerWith([{ raiFilteredReason: RAI_SENTENCE, ...PROMPT_ATTRIBUTES }]);

    expect(isImageContentRefusalError(error)).toBe(false);
    expect((error as Error).message).toContain("did not return image bytes");
  });
});
