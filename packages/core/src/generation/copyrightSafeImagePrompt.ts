import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { estimateTokensByScript, type ScriptTokenWeights } from "../textTokens.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { isLibraryMentionNameCharacterAt } from "./libraryMentions.js";
import { foldArabicIndicDigits, foldInterchangeableArabicLetters, stripInvisibleMarks } from "./orthographyFolds.js";

/**
 * Turning an image prompt an IP filter refused into one describing an original
 * character in the same role.
 *
 * A reader asking for a book about a character they love is asking for
 * something ordinary, and "a young masked hero in a red-and-blue suit who
 * climbs walls" is the honest version of it — an original design, not a
 * laundered one. Which is also the whole safety argument for doing this
 * automatically: the rewrite may only remove *protected names*, so a prompt
 * that is objectionable for any other reason comes back objectionable in
 * exactly the same way and is refused again. `imageRefusalCategory` decides
 * what may reach here; this module decides what a rewrite is allowed to be.
 */

export const COPYRIGHT_SAFE_IMAGE_PROMPT_PURPOSE = "rewrite-image-prompt-copyright-safe";

/**
 * Beyond this the rewrite is not worth a model call — no real prompt is this
 * long. This gate is about *spend*, and it is the only thing it is about.
 */
const MAX_REWRITABLE_PROMPT_CHARS = 12_000;

/**
 * How much longer than the prompt it rewrote a reply is allowed to be.
 *
 * A rewrite grows *by design*: "Spider-Man" is ten characters and "a young
 * masked hero in a red-and-blue suit who climbs walls" is fifty-eight, the
 * schema below permits twenty such names, and a prompt may name each of them
 * as often as it likes. Half again is room for all of that and still refuses a
 * reply that is a different document rather than this one with the names
 * taken out.
 */
const REWRITE_GROWTH_ALLOWANCE = 1.5;

/**
 * The reply's ceiling, which is deliberately **not** the gate above it.
 *
 * The two answer different questions — "is this prompt small enough to be
 * worth paying to rewrite" and "is the model's answer usable" — and they were
 * one number, which made a prompt anywhere near the gate unrewritable by
 * construction: the rewrite grows, the reply came back over the same cap,
 * `z.string().max()` refused it, `generateJsonWithRetry` spent its repair
 * attempt on the identical schema, and two paid text calls resolved to
 * `failed` with the picture still refused. An 11,900-character cover prompt
 * reaches that on its own, and that length is the supported range rather than
 * an absurdity — nothing caps `illustrationPlan.coverPrompt`,
 * `makeFallbackPlan` (`prompting/templates.ts`) fills it with the project's
 * whole prompt, and `buildCoverArtworkPrompt` (`cover.ts`) prints it verbatim
 * inside its own frame.
 *
 * Nothing downstream picks the number. No image adapter measures a prompt, and
 * the providers had already accepted this one at its original length — they
 * refused it on *content*. What really bounds a reply is the per-call
 * `maxTokens` fuse below, which is why this is only a second lock: it catches
 * a model that answered with something other than the prompt it was handed,
 * and it has to sit above the gate or it catches every rewrite instead.
 */
const MAX_REWRITTEN_PROMPT_CHARS = Math.ceil(MAX_REWRITABLE_PROMPT_CHARS * REWRITE_GROWTH_ALLOWANCE);

const copyrightSafeImagePromptSchema = z.object({
  prompt: z.string().min(1).max(MAX_REWRITTEN_PROMPT_CHARS),
  changed: z.boolean(),
  replaced: z.array(z.string().max(120)).max(20).default([])
});

export type CopyrightSafeImagePrompt = {
  prompt: string;
  /** The protected names the model reports removing, for the run log and the asset row. */
  replaced: string[];
};

/**
 * A prompt to draw from, or which of the two ways there is none.
 *
 * Both of those leave the caller's refusal standing, and they are not the same
 * event for whoever reads the run log: `declined` is the model saying the
 * prompt names nothing protected, `failed` is a call that was paid for and
 * never produced an answer. Folded into one `undefined` they were
 * indistinguishable — which is exactly how an output budget too small to hold
 * the reply (see `rewriteOutputTokenBudget`) read as a clean decline, forever,
 * for every book in a script that budget was wrong about.
 */
export type CopyrightSafeImagePromptOutcome =
  | ({ outcome: "rewritten" } & CopyrightSafeImagePrompt)
  | { outcome: "declined" }
  | { outcome: "failed"; error: unknown };

/**
 * A rewrite that still names something it reported removing.
 *
 * An error rather than a quieter outcome because that is what carries it into
 * the run log: `CopyrightSafeRetryImageAdapter` serializes a `failed` outcome's
 * error into `image.generate.copyright_rewrite_failed`, and `serializeError`
 * spreads an error's own properties, so the names that survived are recorded
 * beside the message rather than flattened into a sentence.
 */
export class CopyrightRewriteLeakError extends Error {
  constructor(readonly survivingNames: string[]) {
    super(`the rewritten prompt still names ${survivingNames.join(", ")}`);
    this.name = "CopyrightRewriteLeakError";
  }
}

export type RewriteImagePromptOptions = {
  textModel: TextModelAdapter;
  prompt: string;
  /**
   * What the providers said when they refused, passed through so the model can
   * see which part of the prompt was objected to. The whole message rather
   * than the reason code: "Output data is suspected of being involved in IP
   * infringement" tells it something, `DataInspectionFailed` does not.
   */
  reason: string;
  /**
   * Errors this returns true for propagate instead of resolving to a `failed`
   * outcome. The worker passes its stop signal: a reader who stopped the run
   * must not have it continue into a second image call.
   */
  bailOnError?: ((error: unknown) => boolean) | undefined;
};

/**
 * The rewritten prompt, or the reason there is nothing to retry with — the
 * model failed, found nothing protected, or handed back what it was given.
 *
 * It does not throw (except for `bailOnError`), because its caller is holding a
 * refusal that is already the answer. A rewrite that cannot be produced leaves
 * that refusal standing rather than replacing it with a different failure.
 */
export async function rewriteImagePromptForCopyright(
  options: RewriteImagePromptOptions
): Promise<CopyrightSafeImagePromptOutcome> {
  const original = options.prompt.trim();
  if (!original || original.length > MAX_REWRITABLE_PROMPT_CHARS) {
    return { outcome: "declined" };
  }

  try {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: COPYRIGHT_SAFE_IMAGE_PROMPT_PURPOSE,
      temperature: 0.2,
      maxTokens: rewriteOutputTokenBudget(original),
      schema: copyrightSafeImagePromptSchema,
      messages: [
        { role: "system", content: REWRITE_RULES },
        { role: "user", content: `The providers refused with: ${refusalText(options.reason)}\n\nPrompt:\n${original}` }
      ]
    });

    const rewritten = result.data.prompt.trim();
    if (!result.data.changed || !rewritten || rewritten === original) {
      return { outcome: "declined" };
    }
    const surviving = survivingReplacedNames(rewritten, result.data.replaced);
    if (surviving.length > 0) {
      // `failed`, not `declined`, and not a rewrite with `replaced` corrected.
      // `declined` is the model reading the prompt and finding nothing
      // protected in it, which is the opposite of what happened, and the run
      // log is where anyone would go to tell those apart. Correcting the list
      // instead would keep the *record* honest and buy the render anyway — the
      // prompt about to be drawn still names the character, so either the
      // filter refuses it a second time for money, or the second provider
      // draws the protected character under a row that truthfully says nothing
      // was removed. The reply is unusable, so nothing is retried with it and
      // the caller keeps the refusal it already had.
      return { outcome: "failed", error: new CopyrightRewriteLeakError(surviving) };
    }
    return { outcome: "rewritten", prompt: rewritten, replaced: result.data.replaced };
  } catch (error) {
    if (options.bailOnError?.(error)) {
      throw error;
    }
    return { outcome: "failed", error };
  }
}

/**
 * The names the model says it removed that are still in the prompt it handed
 * back.
 *
 * `replaced` is a self-report, and it is the one part of the reply nothing else
 * re-reads. It rides the result to the asset row as
 * `metadata.copyrightRewrite.replaced` (`imageGenerationMetadata`,
 * `apps/worker/src/generation/bookHelpers.ts`), which is the only record this
 * product keeps of a picture having been drawn from something other than what
 * the book asked for: `ImageAsset.prompt` is the request, and that row is the
 * claim about what replaced it. A false one is worse than none.
 *
 * The rule being checked is the model's own — `REWRITE_RULES` spells it out,
 * "must not survive anywhere in your rewrite, including inside a comparison
 * such as … 'in Spider-Man style'" — which is exactly why it needs checking. A
 * model told a rule can still break it, and the shape it breaks it in reads
 * perfectly: `{ changed: true, replaced: ["Spider-Man"], prompt: "A young
 * masked hero in a red-and-blue suit, in Spider-Man style, on a rooftop." }`
 * satisfies every other gate here — it changed, it is non-empty, it is not the
 * original — then buys a second full primary→fallback render of a prompt that
 * still names the character, which the filter refuses for the reason it refused
 * the first. Where the second provider draws it anyway, the row says
 * "Spider-Man removed" over a picture of Spider-Man.
 *
 * **Whole-token and folded**, because the two other readings are each wrong in
 * a way that costs something. Byte-for-byte, "in spider-man style" is not a
 * leak and the check is decoration. Substring-happily, a name is found inside
 * every longer word containing it — and these are arbitrary strings, so a
 * removed `Sam` would veto "same", the sub-token collision
 * `matchLibraryCharacter` was already burned by one directory over. So a match
 * has to stand as its own word — `tokenStartsAt` and `tokenEndsAt` below, this
 * module's own rule and symmetric in both, over the character class
 * `libraryMentions.ts` declares (`\p{L}\p{N}\p{M}\p{Pc}` plus ZWNJ/ZWJ, so a
 * Devanagari matra or a Persian joiner continues a word that an ASCII `\b`
 * would end mid-name). That class is the only thing shared, and the note on
 * `tokenStartsAt` is why the mention scanner's own pair could not be:
 * a hyphen joins a word there too, but it is asked about one end only, because
 * the other end of an `@token` is the `@`.
 *
 * Which spellings count as the same name is `foldRespelling` below, and it is
 * neither of the two folds this repo already has. `toLowerCase` alone — what
 * this was — reads only the case, so a rewrite that merely *re-spells* the name
 * walks through: a ZWNJ dropped inside «Spider‌-Man», the decomposed spelling of
 * "Pokémon" against the composed one in `replaced`, a non-breaking hyphen for
 * the ASCII one, a curly apostrophe for a straight one. Each of those bought a
 * second full primary→fallback render of a prompt that still names the
 * character, and a settled row saying it did not.
 *
 * What is left is one false positive nothing here can see — a franchise whose
 * name is also an ordinary word ("Up", "Cars", "Frozen") that the rewrite keeps
 * in its ordinary sense. That costs the caller its one salvage attempt and
 * leaves it exactly where never rewriting would have, holding the refusal it
 * already had. A missed leak costs a paid render and, when it lands, a settled
 * provenance record that is false. Only the second is unrecoverable, so an
 * unreadable tie goes to refusing — the same way `matchLibraryCharacter`
 * resolves an ambiguous containment to null. That tie-break is for a span this
 * check genuinely cannot read, and a compound is not one of them: "Bear-Luna"
 * is one word and it is not "Luna". Which is why the hyphen rule below is
 * symmetric rather than cautious in one direction — refusing there is not
 * caution, it is answering a question nobody asked.
 */
function survivingReplacedNames(rewritten: string, replaced: readonly string[]): string[] {
  const haystack = foldRespelling(rewritten);
  const surviving: string[] = [];
  for (const name of replaced) {
    // A blank entry is a needle that matches everywhere, so it would veto every
    // rewrite; `z.string().max(120)` admits one and the model pads lists.
    const needle = foldRespelling(name);
    if (!needle || surviving.includes(name)) continue;
    if (containsWholeToken(haystack, needle)) {
      surviving.push(name);
    }
  }
  return surviving;
}

/**
 * The comparison form of a name and of the prompt it is scored against: **the
 * fold normalises how a character was encoded, and never which characters a
 * word has.**
 *
 * That line is the whole of it, and it is the line neither existing fold sits
 * on. `foldCharacterName` (`libraryCharacters.ts`) crosses it deliberately —
 * NFD then `stripOptionalSpellingMarks`, which deletes Latin accents, Hebrew
 * niqqud and Arabic harakat, plus alef maksura onto yeh — because it is asking
 * "are these two spellings one person's name" of two *names*, against a
 * snapshot list of at most ten. This asks "does this document still contain
 * this exact name" of a name and a prompt that runs to twelve thousand
 * characters, so every pair those steps merge gets a document's worth of
 * chances to collide, and a collision is a rewrite that worked being discarded
 * as a leak. Deleting a mark is what does that: Vietnamese tone marks
 * distinguish six words from one another, Arabic and Hebrew children's books
 * are the vocalized ones, and «على» ("on", one of the commonest words in
 * Arabic) is not «علی» (Ali). None of those is a spelling of anything — they
 * are different words — so the marks and the maksura stay.
 *
 * What is left is five steps that each leave the letters alone:
 *
 * - **NFC.** Canonical equivalence is Unicode's own statement that two strings
 *   *are* the same text, so this is equality rather than folding; the composed
 *   and decomposed spellings of "Pokémon" are one name in every language that
 *   has an opinion. NFKC is deliberately not used: it is a table of judgements
 *   nobody here has read, and its compatibility digits and letters turn
 *   punctuation into word characters, which moves a token boundary in the one
 *   direction that *hides* a leak.
 * - **The invisible marks** (`stripInvisibleMarks`) — ZWNJ, ZWJ, the bidi
 *   controls, the BOM. A joiner inside «Spider‌-Man» is not a different name; it
 *   is not even a different *rendering*. Stripping it does not reopen the
 *   «علی‌رضا» hole one directory over, because the letters it sat between are
 *   still adjacent afterwards and the boundary test still refuses the match.
 * - **Arabic kaf and yeh** onto the Persian codepoints for the same two letters
 *   (`foldInterchangeableArabicLetters`), which is the half of
 *   `foldArabicKafYehOntoPersian` that merges no words. A model trained on
 *   Arabic writes «ي»/«ك» into a Persian prompt; that is a keyboard, not a
 *   rename.
 * - **Arabic-Indic and Persian digits** onto ASCII (`foldArabicIndicDigits`),
 *   for the same reason: «R۲-D۲» is R2-D2.
 * - **The hyphen and the apostrophe**, each onto the one spelling of itself
 *   ({@link WORD_JOINING_HYPHEN_CHARS} and {@link RESPELLED_APOSTROPHES}). A
 *   non-breaking hyphen is what a model reaches for inside a name it does not
 *   want broken over a line, and the curly apostrophe is what every model
 *   writes; neither tells two characters apart.
 *
 * What the line costs is a name re-spelled with a mark it does not normally
 * carry — "Spidér-Man" is not caught. That is a shape a cooperating model
 * rewriting its own prompt does not produce, while an accent-blind fold
 * mis-reads real prose on every Vietnamese and every vocalized Arabic prompt
 * there is.
 *
 * Whitespace is collapsed on both sides last, because a prompt is a multi-line
 * document and a two-word name broken over a line break is the same name.
 */
function foldRespelling(text: string): string {
  return foldArabicIndicDigits(
    foldInterchangeableArabicLetters(stripInvisibleMarks(text.normalize("NFC")))
  )
    .replace(RESPELLED_HYPHENS, "-")
    .replace(RESPELLED_APOSTROPHES, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * The apostrophes that spell the apostrophe: the two curly quotes, the modifier
 * letter (which several orthographies use for it) and the fullwidth one.
 *
 * Folded onto ASCII rather than onto each other, and that direction matters
 * beyond tidiness: `U+02BC` is `Lm`, so `libraryMentions.ts`'s name class reads
 * it as a *letter* while `'` is punctuation. Left alone, "Bilboʼs" would be one
 * token and "Bilbo's" two, and a removed "Bilbo" would survive in one spelling
 * and not the other.
 */
const RESPELLED_APOSTROPHES = /[\u2018\u2019\u02BC\uFF07]/gu;

/**
 * Every occurrence is tried, not the first: a name buried inside one word can
 * sit beside the same name standing on its own, and only the second is a leak.
 */
function containsWholeToken(haystack: string, needle: string): boolean {
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    if (tokenStartsAt(haystack, at) && tokenEndsAt(haystack, at + needle.length)) return true;
  }
  return false;
}

/**
 * Hyphens that join two words into one — **and the same list is what the fold
 * unifies**, so a spelling cannot join a compound here and fail to match a
 * needle there.
 *
 * The set `libraryMentions.ts` declares plus the two width variants, spelled
 * again rather than imported, because the two rules are only the same shape.
 * There a hyphen decides whether a typed `@Luna` may bind the reader's saved
 * face inside an `@Luna-Bear`; here it decides whether a name reported removed
 * is still standing in a prompt about to be drawn. Neither owes the other its
 * dashes.
 *
 * The dashes proper — the figure dash, en, em and the minus sign — are
 * deliberately **out**. They are punctuation between words rather than a
 * hyphen's other spelling, so folding them in would quietly widen the
 * word-joining rule as well: a removed "Luna" standing on its own in "the
 * Bear–Luna treaty" is a leak, and only the hyphen reading makes it not one.
 */
const WORD_JOINING_HYPHEN_CHARS = "\\u002D\\u2010\\u2011\\uFE63\\uFF0D";
const WORD_JOINING_HYPHEN = new RegExp(`[${WORD_JOINING_HYPHEN_CHARS}]`, "u");
const RESPELLED_HYPHENS = new RegExp(`[${WORD_JOINING_HYPHEN_CHARS}]`, "gu");

/**
 * Whether a match at `start` opens a word rather than sitting inside one — the
 * mirror of `tokenEndsAt`, which is the whole reason it exists separately.
 *
 * **`libraryMentions.ts` has no leading rule to borrow, and correctly so: its
 * left boundary is the `@` itself.** `isLibraryMentionNameCharacterAt(text,
 * at - 1)` there asks whether the *marker* is buried in a word — which is how
 * `bram@example.com` keeps its `@` — and no hyphen can ever precede the name,
 * because the `@` does. So the pair is asymmetric on purpose, and reading it as
 * a word-boundary rule takes one clause too few: `-` is not a name character,
 * so a hyphen in front of a match suppressed nothing. A removed `Luna`
 * correctly ignored a "Luna-Bear" the rewrite kept and then fired on a
 * "Bear-Luna" — and welding a word onto the archetype is precisely what
 * `REWRITE_RULES` asks the model to invent, so "Bear-Luna", "Neo-Tokyo" and
 * "Spider-Bot" are the shape of a rewrite that *worked*. Each was discarded as
 * a leak, leaving the caller holding its refusal with two paid text calls
 * spent. `matchLibraryCharacter`'s `containsTokenRun` reads a compound the same
 * way and from both sides, because it splits on spaces: "luna-bear" is one
 * token and "luna" is not it, in either position.
 */
function tokenStartsAt(text: string, start: number): boolean {
  if (start <= 0) return true;
  if (isLibraryMentionNameCharacterAt(text, start - 1)) return false;
  // A hyphen with nothing on its far side is ordinary punctuation — "a rabbit
  // -luna naps" is a surviving Luna — so only one joining two words joins.
  return !(
    WORD_JOINING_HYPHEN.test(text.charAt(start - 1)) &&
    isLibraryMentionNameCharacterAt(text, start - 2)
  );
}

/** Whether a match ending at `end` closes a word rather than running into the next. */
function tokenEndsAt(text: string, end: number): boolean {
  if (end >= text.length) return true;
  if (isLibraryMentionNameCharacterAt(text, end)) return false;
  return !(
    WORD_JOINING_HYPHEN.test(text.charAt(end)) && isLibraryMentionNameCharacterAt(text, end + 1)
  );
}

/**
 * How long a reply this rewrite may run to, counted per script rather than per
 * character.
 *
 * The whole prompt has to come back inside the JSON, so the budget follows its
 * length rather than a constant — but `ceil(chars / 2)` said that in Latin.
 * Two characters per token is already generous for English, which runs nearer
 * four, and roughly *half* of what a Persian, Arabic or CJK prompt needs, where
 * a character is close to a token of its own. A 3,000-character Persian prompt
 * was given 1,500 tokens for a reply that must contain all 3,000 characters
 * back: the reply truncated, the schema refused it, the failure resolved to
 * "nothing to retry with", and the caller kept a refusal it had paid twice to
 * be told about — `generateJsonWithRetry` spends a repair attempt on the same
 * budget before it gives up. Silent, and only ever on books not written in
 * English, which is most of them here.
 *
 * `maxTokens` is a runaway fuse, not a reservation: nothing is paid for a
 * budget that goes unused, so the only expensive mistake is a budget too small.
 * The weights are therefore deliberately over-generous in both classes, the
 * same reading `wholeBookMaxTokens` (`pages.ts`) takes of its own multiplier.
 * The counting itself is `estimateTokensByScript` (`textTokens.ts`), which
 * `estimateTokenCountFromText` (`apps/worker/src/providers/usageAccounting.ts`)
 * reads too — at its own weights, because that one prices a call that has
 * already happened rather than fusing one that has not.
 * `approximateTokens` (`context/contextPack.ts`) is still the flat `chars / 4`
 * and stays that way on purpose: it is one half of a pair with `trimToBudget`'s
 * `tokenBudget * 4`, and the two are only self-consistent while they share a
 * divisor. Neither of those can truncate a reply by being wrong.
 */
function rewriteOutputTokenBudget(prompt: string): number {
  return Math.max(
    REWRITE_MIN_OUTPUT_TOKENS,
    Math.min(REWRITE_MAX_ECHO_TOKENS, rewrittenEchoTokenEstimate(prompt)) + REWRITE_JSON_SCAFFOLDING_TOKENS
  );
}

/**
 * Tokens the reply needs for the **rewritten** prompt alone, before the JSON
 * around it.
 *
 * Sized off what comes back rather than off what went in, for the same reason
 * `MAX_REWRITTEN_PROMPT_CHARS` is not the gate: the reply carries the prompt
 * with every protected name swapped for a longer description, so a budget
 * measured on the original is short by exactly the growth the rewrite exists
 * to produce. That is a *truncated* reply rather than a refused one — an
 * unterminated string, which `repairCommonJson` cannot close — and it lands on
 * the same two paid calls and the same `failed`.
 */
function rewrittenEchoTokenEstimate(text: string): number {
  return Math.ceil(estimateTokensByScript(text, ECHO_TOKEN_WEIGHTS) * REWRITE_GROWTH_ALLOWANCE);
}

/**
 * Generous on purpose, in both classes.
 *
 * Two characters per token is about half what Latin prose really costs, and one
 * token per character is at or above what the dense scripts cost. Neither error
 * is paid for: `maxTokens` is a runaway fuse, not a reservation, so a budget
 * that goes unused costs nothing while a budget that is too small truncates the
 * echo — which is the failure this whole comment block is about. A cost
 * estimator wants the opposite calibration and states its own, which is why
 * `estimateTokensByScript` (`textTokens.ts`) shares the script classification
 * between them and neither the weights nor the rounding floor.
 */
const ECHO_TOKEN_WEIGHTS = { latinCharsPerToken: 2, denseCharsPerToken: 1 } satisfies ScriptTokenWeights;
/** The JSON keys, the `replaced` names, and whatever escaping the model chooses. */
const REWRITE_JSON_SCAFFOLDING_TOKENS = 400;
const REWRITE_MIN_OUTPUT_TOKENS = 800;
/**
 * The fuse is on the **echo**, not on the reply, and the scaffolding is added
 * after it.
 *
 * It is the character ceiling read as tokens: in the densest script a
 * character is about a token of its own, so the longest reply the schema will
 * take is about `MAX_REWRITTEN_PROMPT_CHARS` tokens coming back. Derived from
 * what may come *back*, never from what may go in — a fuse sized on the gate
 * is the same conflation `MAX_REWRITTEN_PROMPT_CHARS` exists to undo, one
 * layer down, and it clips exactly the rewrites the schema now accepts.
 *
 * Clamping the *sum* at this number is the other half of the same mistake: it
 * spends the top of the range on the echo and leaves the JSON around it
 * whatever is over — 400 tokens down to 399 from an 11,601-token echo, and
 * exactly zero at the cap. A reply that runs out mid-string is not a short
 * rewrite but an unterminated one — `repairCommonJson` (`adapters/json.ts`)
 * closes trailing commas and unquoted keys and never an open string — so it
 * fails to parse, `generateJsonWithRetry` spends its repair attempt on the same
 * budget and fails the same way, and the caller keeps the refusal it has now
 * paid two calls to be told about.
 *
 * Clamping the input instead would be worse than the truncation it prevents: a
 * rewrite is only usable if the whole prompt comes back, so a prompt cut short
 * on the way in draws a picture missing its own scene. Being generous costs
 * nothing — `maxTokens` is a fuse, and this repo already asks for 64,000 on the
 * batch draft path (`pages.ts`).
 */
const REWRITE_MAX_ECHO_TOKENS = MAX_REWRITTEN_PROMPT_CHARS;

/** A refusal can carry a provider's whole prose reply; the model needs the gist, not all of it. */
function refusalText(reason: string): string {
  const trimmed = reason.trim() || "a copyright filter";
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}

const REWRITE_RULES = [
  "An image provider's copyright filter refused this illustration prompt. Rewrite it so it asks for an ORIGINAL character instead of a protected one.",
  'Replace every proper name of a copyrighted or trademarked character, team, franchise, brand or logo with a short generic description of the same archetype — "Spider-Man" becomes "a young masked hero in a red-and-blue suit who climbs walls".',
  'A removed name must not survive anywhere in your rewrite, including inside a comparison such as "like Spider-Man" or "in Spider-Man style".',
  "Change nothing else. Keep the scene, the action, the setting, the mood, the art style, the other characters, and every instruction about reference images, layout, aspect ratio or text exactly as they are, word for word wherever you can.",
  "Add nothing the original did not ask for, and do not soften, censor, shorten or reword anything that is not a protected name.",
  'If the prompt names nothing protected, return it unchanged with "changed": false — do not invent a change to make.',
  'Reply as JSON: {"prompt": "<the full rewritten prompt>", "changed": true|false, "replaced": ["<each protected name you removed>"]}'
].join("\n");
