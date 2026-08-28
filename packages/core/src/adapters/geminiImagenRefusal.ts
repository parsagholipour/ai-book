import { ImageContentRefusedError } from "./imageRefusal.js";

/**
 * Why an Imagen response carries no picture.
 *
 * This endpoint does not answer in candidates: a filtered request comes back
 * an ordinary 200 with the bytes missing, and what it says about the filter
 * arrives as three different *kinds* of statement. The classifier keeps two of
 * them apart deliberately — `codes` against `prose` in `imageRefusal.ts` — and
 * the third is not a statement about this block at all, so each has to be
 * handed to the right half.
 *
 * `raiFilteredReason` is the only thing here that asserts anything about *this*
 * request: it is the filter answering, in prose written for a person ("Your
 * current safety filter threshold filtered out 1 output image(s)", or a
 * usage-guidelines sentence with numeric support codes appended). It is the
 * `detail`. `safetyAttributes` is the third kind: a standing score table,
 * returned for a picture that was drawn as readily as for one that was not,
 * naming every category the RAI classifier scores whether or not anything
 * tripped. It is the `diagnostics` — recorded, never read into a verdict.
 *
 * **The table is not a weaker verdict; it is not a verdict.** Asking for it
 * with `includeSafetyAttributes` and folding its category names into `reason`
 * put the word `Porn` into the veto-carrying field of ordinary refusals, and
 * `NEVER_REWRITABLE_CODE` is a bare word test over exactly that field — so an
 * Imagen copyright block vetoed itself and the rewrite was unreachable on this
 * provider. Score-gating the fold did not save it: an empirical probe of a
 * copyright-blocked prompt scored `[0, 0.1, 0.8]` across
 * `["Death, Harm & Tragedy", "Porn", "Violence"]`, so the request that was
 * blocked *for copyright* carried a 0.1 on `Porn` and a **0.8 on Violence**.
 * A category at the top of the range belonged to no part of the block, which
 * is the counterexample that kills every threshold: nothing in the table
 * separates "the classifier saw something" from "the filter blocked on this",
 * because the table is not about the block and `safetyFilterLevel`'s cut is
 * never reported.
 *
 * What the response *does* say per block is the sentence. So the categories
 * reach `reason` by exactly one route: {@link imagenNamedCategories} keeps a
 * category the RAI sentence **itself names**. That is the filter having written
 * the word into its own statement about this request, which is what makes a
 * bare word test over it safe — and it is what keeps `RAI_FILTERED` from being
 * the whole verdict, without letting a standing table be any of it. It also
 * closes the one gap the prose half has on this endpoint: `NEVER_REWRITABLE_VOCABULARY`
 * spells the harm words for prose (`pornograph\w*`), so a sentence naming the
 * category `Porn` outright would slip past it, while `Porn` in `reason` does not.
 *
 * Only the RAI reason makes it a refusal: that field is the SDK's record of
 * a filter *answering*, while the attributes are scores. They may describe a
 * refusal already established and never declare one, so a missing picture with
 * no RAI reason stays as retryable as a bare `STOP` on the native models — the
 * direction that costs a retry rather than a character's reference sheet. The
 * `positivePromptSafetyAttributes.blocked` this used to fall back on was never
 * a field: `SafetyAttributes` carries `categories`, `scores` and `contentType`
 * and the SDK maps only those three, so that branch could only ever synthesize
 * the word "SAFETY" out of nothing — into `detail`, where nothing downstream
 * could tell it from a reason the provider had given.
 *
 * **The response has no reason of its own, either.** This used to fall back to
 * a top-level `response.raiFilteredReason`, and `GenerateImagesResponse` has no
 * such field: the SDK's `generateImages` rebuilds its answer as exactly
 * `generatedImages`, `positivePromptSafetyAttributes` and `sdkHttpResponse`, so
 * a top-level reason on the wire is dropped before this ever sees it. With that
 * read gone, an answer where no entry names a filter names no filter at all —
 * which is why {@link imagenFilteredImage} no longer guesses at `images[0]`.
 * Falling back to the first entry could only ever have contributed *categories*
 * to a refusal it had no reason for, and a refusal with no reason returns above
 * as the ordinary failure it is.
 *
 * Imagen names no IP category of its own: `RECITATION` and
 * `IMAGE_RECITATION` are values of the native models' `FinishReason` enum
 * with no counterpart here, the RAI reason being an unenumerated string. An
 * Imagen copyright filter therefore reaches the rewrite path only when that
 * string says so in words, and nothing here maps a numeric support code onto
 * a meaning it was never given.
 */
export function missingImagenImageError(model: string, response: any): Error {
  const filteredImage = imagenFilteredImage(response);
  const raiReason = trimmedGeminiString(filteredImage?.raiFilteredReason);
  if (!raiReason) {
    return new Error(`Gemini image model ${model} did not return image bytes.`);
  }
  // The picture's attributes and the prompt's stay labelled apart: they say the
  // request was what tripped rather than the drawing, which is a different fact
  // about the same refusal. On a blocked request the picture usually has none —
  // a filtered prediction carries a reason and nothing else — so the prompt's
  // are most of what there is.
  const picture = imagenSafetyTable(filteredImage?.safetyAttributes);
  const prompt = imagenSafetyTable(response?.positivePromptSafetyAttributes);
  const named = imagenNamedCategories(raiReason, [...picture.categories, ...prompt.categories]);
  const diagnostics = [...picture.readings, ...prompt.readings.map((reading) => `PROMPT ${reading}`)];
  return new ImageContentRefusedError({
    provider: "gemini",
    model,
    reason: named.length > 0 ? `RAI_FILTERED: ${named.join(", ")}` : "RAI_FILTERED",
    detail: raiReason,
    ...(diagnostics.length > 0 ? { diagnostics: diagnostics.join(", ") } : {})
  });
}

/**
 * The `generatedImages` entry that names the filter. A filtered picture is an
 * entry carrying a reason instead of bytes rather than a missing entry, and
 * with `numberOfImages: 1` it is the only one — but it is the reason that
 * identifies it, never the index.
 */
function imagenFilteredImage(response: any): any {
  const images: any[] = Array.isArray(response?.generatedImages) ? response.generatedImages : [];
  return images.find((image) => trimmedGeminiString(image?.raiFilteredReason));
}

/**
 * One `SafetyAttributes` read twice: the category names as a vocabulary, and
 * the whole table as a line for a human.
 *
 * `categories` is the provider's standing RAI list — "Death, Harm & Tragedy",
 * "Porn", "Violence", "Toxic", … — and `scores` is the parallel reading it gave
 * each one. Neither half is filtered here, because neither half decides
 * anything: the names go on to be matched against what the filter actually
 * said, and the readings go to `diagnostics`, which nothing tests.
 *
 * That is what makes the degenerate shapes harmless rather than load bearing.
 * A `scores` array that is omitted, shorter than `categories`, or holding
 * strings used to be the difference between a copyright rewrite and a permanent
 * refusal, because an unreadable score fell *toward* the veto. It falls nowhere
 * now: an unreadable reading is written down as `?` and the category is a
 * candidate word exactly as it would have been with a number beside it. The
 * old rationale — "unscored is not scored zero, so an answer that cannot be
 * read has to fall toward the veto" — also had the asymmetry backwards from
 * the one `isNeverRewritableRefusal` is written under. Being wrong toward the
 * veto is what costs a picture nobody may ask for again; being wrong away from
 * it costs one rewritten prompt that a child-safety filter refuses in exactly
 * the same way, because a rewrite may only remove protected *names*.
 */
function imagenSafetyTable(attributes: any): { categories: string[]; readings: string[] } {
  const rawCategories: unknown = attributes?.categories;
  if (!Array.isArray(rawCategories)) {
    return { categories: [], readings: [] };
  }
  const scores: unknown[] = Array.isArray(attributes?.scores) ? attributes.scores : [];
  const categories: string[] = [];
  const readings: string[] = [];
  rawCategories.forEach((rawCategory: unknown, index: number) => {
    const name = trimmedGeminiString(rawCategory);
    if (name === undefined) {
      return;
    }
    const score = scores[index];
    categories.push(name);
    readings.push(`${name}=${typeof score === "number" && Number.isFinite(score) ? score : "?"}`);
  });
  return { categories, readings };
}

/**
 * The categories the filter gave as its verdict on this block.
 *
 * The intersection is half the point. A category name on its own is the table
 * speaking, and the table speaks on every answer; the same name inside
 * `raiFilteredReason` may be the filter speaking about this request, which is
 * the only thing `reason` may carry. So the table contributes vocabulary — the
 * provider's spelling of its own categories — and the sentence contributes the
 * assertion.
 *
 * The other half is that a bare word test over prose meets the *scene* sooner
 * or later, which is the rule `isNeverRewritableRefusal` is written under and
 * the mistake this module has now made twice. `"I can't create an image of
 * Spider-Man teaching a child to read."` names the category `Child` and asserts
 * nothing about any filter — it restates the request — so an ungoverned
 * intersection vetoes the textbook case all over again, one door further along.
 * A filter verb therefore has to *govern* the category, across a closed gap of
 * connectives and punctuation and nothing open-ended: "filtered for Porn" and
 * "blocked due to Child Safety" count, a category merely somewhere in the same
 * sentence does not. Case-insensitive, because the sentence is written for a
 * person and the table is Title Case; bounded with a lookahead rather than `\b`,
 * since a `\b` beside a category that ends in punctuation asserts the opposite
 * of what it reads like.
 */
function imagenNamedCategories(raiReason: string, categories: string[]): string[] {
  const named = categories.filter((category) =>
    new RegExp(String.raw`\b${FILTER_VERDICT}${VERDICT_GAP}${escapeRegExpLiteral(category)}(?!\w)`, "i").test(raiReason)
  );
  return [...new Set(named)];
}

/** A filter reporting its own decision, in the words a provider writes one in. */
const FILTER_VERDICT = String.raw`(?:filter\w*|block\w*|flag\w*|reject\w*|violat\w*|categor(?:y|ies)|reasons?)`;

/**
 * What may stand between that verdict and the category it is a verdict about:
 * one connective, one determiner, one label word, or the punctuation of a
 * `Category: Porn` heading. Nothing open-ended, because an open window is
 * exactly what lets a filter verb at the start of a sentence claim a scene word
 * at the end of it.
 *
 * **No two parts of it may want the same space.** This was written as
 * `(?:\s*[:=,-]\s*|\s+(?:out|for|…)\b)*\s*`, and the punctuation arm's own two
 * `\s*` overlapped each other *and* the trailing one: given `" - - - "` the run
 * before a dash could be claimed by the previous repetition's tail, by the next
 * repetition's head, or split between them, so the engine had three ways to
 * spell every separator and tried all of them before failing. Measured against
 * `"blocked" + " - ".repeat(n) + "ZZZ"` and the category `Porn`, that is a clean
 * ×9 per two separators — 1 ms at n=10, 10 ms at 12, 89 ms at 14, 813 ms at 16,
 * 7.2 s at 18 — and `raiFilteredReason` is provider text run through one such
 * regex *per category* in the standing table, which `includeSafetyAttributes`
 * makes twelve entries long. Synchronously, on the worker's only thread, inside
 * a generate-image job: long enough for BullMQ to call the job stalled and hand
 * it to another worker.
 *
 * So the whitespace is owned in exactly one place — a leading run, then one
 * after each token — and a token is never whitespace, so no two runs can be
 * adjacent and nothing has a second parse. The repetition is bounded as well:
 * a gap of eight connectives is already far more than "one connective, one
 * determiner, one label word", and a ceiling is what keeps a future arm from
 * quietly buying the exponent back. The language is unchanged, and
 * `geminiImagenRefusal.test.ts` holds the same phrasings either side of it.
 */
const VERDICT_GAP = String.raw`\s*(?:(?:[:=,-]|\b(?:out|for|due|to|as|by|of|on|because|under|is|was|were|the|a|an|its|our|their|content|categor(?:y|ies)|reasons?)\b)\s*){0,8}`;

/** A category name is provider text, so it is quoted rather than trusted as a pattern. */
function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * A Gemini response field that actually said something. Every read of a reason,
 * a finish message or a category goes through it — a field the SDK left empty
 * and a field it never mapped are the same absence, and neither is evidence.
 */
export function trimmedGeminiString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
