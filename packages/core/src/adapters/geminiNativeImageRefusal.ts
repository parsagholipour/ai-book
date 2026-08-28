import { ImageContentRefusedError, isSpokenImageRefusal, spokenImageRefusalReason } from "./imageRefusal.js";
import { trimmedGeminiString } from "./geminiImagenRefusal.js";

/**
 * Why a native image response carries no picture.
 *
 * Gemini declines by *answering*: the HTTP call succeeds and the reason lives
 * in `promptFeedback.blockReason`, in the candidate's `finishReason`, or — when
 * the model would rather talk than draw — in the text part it returned in the
 * picture's place. All three used to be dropped for a bare "did not return
 * image bytes", which is how a whole book failed with its cause reachable only
 * by guessing at the prompt.
 *
 * The verdict has to *name an objection*, though, and that is one rule read
 * twice rather than two rules. A word that only says the turn ended without a
 * picture — `STOP`, and the SDK's own `NO_IMAGE` and `IMAGE_OTHER`, which
 * Google documents as "expected to generate an image, but none was generated"
 * and "stopped for a reason not otherwise specified" — is the shape of an
 * intermittent render failure as much as of a refusal, and calling it a refusal
 * makes the transient one permanent: it skips `withRecoverableNetworkRetry`, it
 * is unrecoverable to the job, and a character reference sheet records it on the
 * plan version forever. Those stay a refusal only when the model *said* so
 * ({@link isSpokenImageRefusal}); otherwise they are an ordinary failure the
 * ladder above is right to try again.
 *
 * Which is why both provider fields take an allowlist. `blockReason` used to
 * take none — the argument being that the field exists only when a filter
 * blocked, so any value of it is a verdict — and that argument does not survive
 * its own enum. `BLOCKED_REASON_UNSPECIFIED` is the proto zero value, which is
 * what an *unset* field deserializes to, so a backend that spells it out turns
 * an ordinary picture-less turn into a permanent refusal named
 * `BLOCKED_REASON_UNSPECIFIED`: the bare-`STOP` bug exactly, one field over.
 * And `OTHER` is `IMAGE_OTHER` under a different name — the SDK glosses it "for
 * other reasons. For example, it may be due to the prompt's language, or
 * because it contains other harmful content", so it covers an unsupported
 * script (this product publishes in nine of them) as readily as a content
 * filter, and neither of those is a fact worth settling forever on the strength
 * of the word "other". A rejected reason is not thrown away: it travels to
 * {@link spokenImageRefusalReason} as the qualifier it is, the way DashScope's
 * `InvalidParameter` does, so the provider's word still reaches the run log
 * without deciding anything.
 *
 * The fourth field is `safetyRatings`, and it is the only one here that says
 * *what* the filter objected to. See {@link nativeSafetyRatings} for why only
 * half of it may say so.
 */
export function missingNativeImageError(model: string, response: any, candidate: any, parts: any[]): Error {
  const finishReason = trimmedGeminiString(candidate?.finishReason);
  const blockReason = trimmedGeminiString(response?.promptFeedback?.blockReason);
  const spoken = parts
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .join(" ")
    .trim();
  const detail = [
    trimmedGeminiString(candidate?.finishMessage),
    trimmedGeminiString(response?.promptFeedback?.blockReasonMessage),
    spoken
  ]
    .filter(Boolean)
    .join(" ");
  const refusal =
    namedGeminiBlock(blockReason, GEMINI_IMAGE_BLOCK_REASONS) ??
    namedGeminiBlock(finishReason, GEMINI_IMAGE_BLOCK_FINISH_REASONS) ??
    // A refusal the model phrased instead of flagging. Only the prose makes
    // it one: an unexplained finish reason on its own is a render that did
    // not happen, and re-asking is exactly what fixes that.
    (isSpokenImageRefusal(detail) ? spokenImageRefusalReason(finishReason, blockReason) : undefined);
  if (refusal) {
    // The ratings refine a verdict the fields above established; they never
    // establish one, which is why they are read here rather than beside them.
    const ratings = nativeSafetyRatings(response, candidate);
    return new ImageContentRefusedError({
      provider: "gemini",
      model,
      reason: ratings.blocked.length > 0 ? `${refusal}: ${ratings.blocked.join(", ")}` : refusal,
      detail,
      ...(ratings.readings.length > 0 ? { diagnostics: ratings.readings.join(", ") } : {})
    });
  }
  // No terminal verdict at all — a truncated or malformed response, which the
  // retry ladder above is right to try again.
  return new Error(
    `Gemini image model ${model} did not return image bytes${finishReason ? ` (finishReason ${finishReason})` : ""}${
      detail ? `: ${detail}` : "."
    }`
  );
}

/**
 * A provider word that settles it, or nothing — never the word itself on the
 * strength of having been sent.
 *
 * Membership is the whole test, so a value the SDK grows next and nobody here
 * has weighed falls to the cheap side automatically: the model's own prose may
 * still settle it, and if it does not, the caller pays a few retries and a
 * fallback render rather than a character its reference sheet.
 */
function namedGeminiBlock(reason: string | undefined, named: ReadonlySet<string>): string | undefined {
  return reason && named.has(reason) ? reason : undefined;
}

/**
 * The safety table read twice: the categories the filter *blocked on*, and the
 * whole table as a line for a human.
 *
 * This is Imagen's `safetyAttributes` in every respect but the one that
 * matters, and the difference is a single field. Both are **standing tables** —
 * the SDK says "There is at most one rating per category" on
 * `Candidate.safetyRatings` and "There is one rating per category" on
 * `promptFeedback.safetyRatings`, so a row is the classifier having scored a
 * category, on an answer it drew as readily as on one it refused. Folding those
 * names into `reason` is the mistake this module's sibling made twice:
 * `NEVER_REWRITABLE_CODE` is a bare word test over exactly that field, so a
 * table naming `HARM_CATEGORY_SEXUALLY_EXPLICIT` on every answer vetoes every
 * refusal it touches and takes the copyright rewrite with it. No probability
 * threshold saves it either — Imagen's copyright-blocked probe scored 0.8 on a
 * category belonging to no part of the block — and `HarmProbability` is a
 * coarser scale than the score that failed, so it could only be worse.
 *
 * `SafetyRating.blocked` is the field Imagen has no counterpart for. The SDK
 * glosses it "Indicates whether the content was blocked because of this
 * rating"; the Gemini API's own reference puts it as the question "Was this
 * content blocked **because of this rating**?" That is the filter's own per-row
 * statement about *this* request, which is the thing the whole Imagen incident
 * was about not having — there the assertion had to be recovered from the RAI
 * sentence's grammar, because nothing in the table made one. Here it is a
 * boolean, so the rule needs no regex and no threshold: a row that says
 * `blocked` may name itself in `reason`, and every other row is a reading. It is
 * also one of only three fields of `SafetyRating` the SDK does not mark "not
 * supported in Gemini API" — `category` and `probability` are the others, and
 * `probabilityScore`, `severity`, `severityScore` and `overwrittenThreshold`
 * all are, so the score half of Imagen's table does not even arrive on this
 * path.
 *
 * The test is `=== true` rather than truthiness, and that is the asymmetry
 * rather than fussiness: a string `"false"` is truthy, and every unreadable
 * answer here has to fall toward the retryable side. Being wrong that way costs
 * one rewritten prompt that a child-safety filter refuses identically, since a
 * rewrite may only remove protected *names*; being wrong the other way costs a
 * picture nobody may ask for again. **An unblocked row omits the field rather
 * than sending `false`** — Google's own worked example prints three categories
 * with no `blocked` and one with `blocked: true` — so absent is the common case
 * and the strict test reads it correctly without a default. For the same reason
 * a blocked row whose category will not read asserts nothing — there is no word
 * to assert with — and is written down as a reading like any other.
 *
 * The category names travel raw, unfiltered by any list of ours. They are enum
 * constants rather than prose — the filter's own machine vocabulary, which is
 * what makes a bare word test over them safe in the way it is never safe over a
 * sentence — and the two that carry the veto (`HARM_CATEGORY_SEXUALLY_EXPLICIT`
 * and its `IMAGE_` twin) carry it because they *are* the never-rewritable
 * categories. Gemini publishes no `HARM_CATEGORY_CHILD_SAFETY`; if it ever does,
 * that spelling vetoes on arrival, which is the one direction this is allowed to
 * grow by itself. Every other member the SDK adds keeps the rewrite reachable,
 * and `geminiNativeImageRefusal.test.ts` walks the enum to keep both halves of
 * that true.
 *
 * **Raw is what makes the enum a tripwire rather than a ceiling**, and the API
 * already disagrees with the SDK in the direction that matters:
 * `HARM_CATEGORY_SEXUAL` is documented on `generativelanguage` as one of six
 * PaLM-era members and is **absent from the SDK's enum entirely**. Matched
 * against a list built from `HarmCategory` it would be a category nobody could
 * name; passed through, it vetoes on the same word its `_EXPLICIT` cousin does.
 * The test walking the enum is a bump alarm; this function is not limited to
 * what the enum knows.
 *
 * **Two things bound how often any of this fires, and neither is fixable here.**
 * Ratings are not requested — there is no reporting flag to set, the whole of
 * `GenerateContentParameters` being `model`, `contents` and a
 * `GenerateContentConfig` whose only safety member is `safetySettings`, which
 * sets *thresholds* — and Google documents the default threshold as `OFF` for
 * 2.5- and 3-era models, with `OFF` glossed "no automated response blocking and
 * no metadata is returned". Turning a threshold on to buy the metadata would
 * start blocking books that render today, which is a product decision and not a
 * refusal-classification one. And the filter that actually catches child
 * content is *non-configurable*, so it rates nothing: Google maps it to
 * `PROHIBITED_CONTENT` ("usually CSAM") on both the prompt and the response
 * side. That label already settles a refusal in both allowlists above, and it
 * deliberately does not veto — it is also what Gemini says about a character
 * likeness, and `imageRefusalVerdict.ts` weighs that trade where the veto lives.
 * So this door is the *structured* half of the child-safety decision, not the
 * whole of it; the prose half is still load bearing.
 */
function nativeSafetyRatings(response: any, candidate: any): { blocked: string[]; readings: string[] } {
  const blocked: string[] = [];
  const readings: string[] = [];
  // The candidate's ratings are about the drawing and the prompt's are about
  // the request — a different fact about the same refusal, so they stay
  // labelled apart in the readings the way Imagen's two tables do. Neither is
  // the weaker claim, so both may name a category they blocked on.
  for (const [rows, label] of [
    [candidate?.safetyRatings, ""],
    [response?.promptFeedback?.safetyRatings, "PROMPT "]
  ] as const) {
    if (!Array.isArray(rows)) {
      continue;
    }
    for (const row of rows as unknown[]) {
      const category = trimmedGeminiString((row as any)?.category);
      const probability = trimmedGeminiString((row as any)?.probability);
      const blockedHere = (row as any)?.blocked === true;
      if (blockedHere && category !== undefined && !blocked.includes(category)) {
        blocked.push(category);
      }
      readings.push(`${label}${category ?? "?"}=${probability ?? "?"}${blockedHere ? " blocked" : ""}`);
    }
  }
  return { blocked, readings };
}

/**
 * Prompt block reasons that name an objection — the subset of the SDK's
 * `BlockedReason` a filter can be said to have *answered* with.
 *
 * Missing on purpose are the two that assert nothing.
 * `BLOCKED_REASON_UNSPECIFIED` is the enum's zero value, which is the value an
 * unset field carries, and `OTHER` is the SDK's own catch-all — the same
 * "not otherwise specified" that keeps `IMAGE_OTHER` out of the finish-reason
 * set one screen down. `MODEL_ARMOR` and `JAILBREAK` are absent for a third
 * reason: the SDK marks both "not supported in Gemini API" and this adapter
 * builds `GoogleGenAI` from an API key, so neither can arrive here. If that
 * client ever becomes a Vertex one they are the first two to weigh — as
 * additions somebody makes deliberately, which is the direction an allowlist is
 * for.
 */
const GEMINI_IMAGE_BLOCK_REASONS: ReadonlySet<string> = new Set([
  "BLOCKLIST",
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "SAFETY"
]);

/**
 * Finish reasons that mean a filter answered — each one names the objection.
 *
 * `IMAGE_OTHER` is deliberately *not* here. It reads like a verdict and is not
 * one: the SDK documents it as "image generation stopped for a reason not
 * otherwise specified", which covers a render that fell over as readily as one
 * a filter stopped. It sits with `STOP` and `NO_IMAGE` instead, where the
 * model's own words decide.
 */
const GEMINI_IMAGE_BLOCK_FINISH_REASONS: ReadonlySet<string> = new Set([
  "BLOCKLIST",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "RECITATION",
  "SAFETY",
  "SPII"
]);
