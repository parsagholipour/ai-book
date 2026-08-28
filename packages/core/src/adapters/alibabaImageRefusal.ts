import { ImageContentRefusedError, isSpokenImageRefusal, namesProviderOutage, spokenImageRefusalReason } from "./imageRefusal.js";

/**
 * What DashScope's words *mean*, apart from where in a response they were
 * found.
 *
 * `alibaba.ts` reads the shapes — `alibabaErrorCode` walks four places a code
 * can sit, `alibabaSpokenText` gathers every sentence a picture-less turn
 * carried — and this module reads the words themselves. The split is the one
 * `geminiNativeImageRefusal.ts` and `geminiImagenRefusal.ts` already make
 * beside their own adapter, and it is what gives the reading below a test file
 * of its own.
 */

/**
 * Whether DashScope's filter *answered* — the one question both refusal paths
 * in this file ask, and the only place the veto that outranks it lives.
 *
 * There are two kinds of evidence and each used to carry its own arm, ORed:
 * `isAlibabaRefusalCode(code) || isAlibabaRefusalProse(message)`. The veto
 * added when `"InternalError: the data inspection service is temporarily
 * unavailable, please retry."` was found being recorded as a settled refusal
 * went into the *prose* arm — the arm that could see it — and the code arm
 * short-circuits above it, so the code arm had no outage veto at all. That is
 * the same bug through the other door, and DashScope opens it: the inspector's
 * name is what its outages are *named after*, so a filter outage reported as a
 * FAILED task or a 400 carrying `DataInspectionFailed` beside "the data
 * inspection service is temporarily unavailable" matched
 * {@link isAlibabaRefusalCode} on the first test, and the sentence that said
 * the filter was broken was never read. A typed `ImageContentRefusedError`
 * then: all three `withRecoverableNetworkRetry` attempts skipped,
 * `shouldFallBackToAsyncQwen` declining the async endpoint, and for a character
 * reference sheet a transient outage written onto
 * `PlanVersion.characterReferenceRefusals` as a settled fact no pass revisits
 * and nothing in the product ever clears.
 *
 * So the veto is asked **first and once**, above both arms, and a second copy
 * is what this shape exists to make unnecessary: a third path here picks a
 * prose `reading` and inherits reading 1 whether or not it thought about it.
 * `namesProviderOutage` is imported rather than restated for the same reason
 * one level down — a caller owns its filter's vocabulary and no part of what
 * outranks it.
 *
 * The `reading` is the one thing that genuinely differs, and it is the
 * difference between a provider describing its own failure and a model
 * talking. An **error body** gets the vocabulary reading alone: `error` and
 * `failed` are what an error body is made of, and a first-person decline read
 * out of one would make "unable to generate" for a bad model name permanent. A
 * **model turn** gets all four ordered readings, with DashScope's vocabulary
 * handed in as the provider half of reading 2 rather than ORed beside it —
 * which is what stops the bare `/content policy/i` below reading `"The image
 * was generated in accordance with the content policy"` as a refusal.
 *
 * **And this answers with the label, not with the arm that earned it**, because
 * the two are not interchangeable and a caller that treated the answer as a
 * boolean proved it. The arm decides how the verdict is *written down*: a code
 * that passed {@link isAlibabaRefusalCode} is the reason, while a prose-settled
 * refusal is recorded under {@link spokenImageRefusalReason} with any rejected
 * code carried on as the qualifier it is. Returning a discriminated
 * `{ source }` left both spellings available, and one caller —
 * {@link alibabaContentRefusal} — read it as "did the filter answer" and then
 * labelled every verdict `code ?? "DataInspectionFailed"`. A 400 reading
 * `{ code: "InvalidParameter", message: "Input contains ip infringement" }`
 * lost the code arm, won on prose, and was recorded under `InvalidParameter` —
 * the very code this function's own test had just refused; a 400 carrying only
 * a refusing message was recorded under `DataInspectionFailed`, a code
 * DashScope never sent. That label is what `imageRefusalReason` writes into the
 * run log and onto `PlanVersion.characterReferenceRefusals`, where the durable
 * record of why a character has no sheet then names the wrong cause, forever,
 * because the set is never re-rendered.
 *
 * So the arm never leaves this function. There is no `source` for a caller to
 * ignore, no second place the labelling rule is spelled, and the misuse is not
 * expressible: what comes back is the reason string, or `undefined` because the
 * filter did not answer.
 */
export type AlibabaProseReading = "error-body" | "model-turn";

export function alibabaRefusalReason(
  code: string | undefined,
  prose: string | undefined,
  reading: AlibabaProseReading,
  finishReason?: string | undefined
): string | undefined {
  if (namesProviderOutage(prose)) {
    return undefined;
  }
  if (isAlibabaRefusalCode(code)) {
    return code;
  }
  const spoken =
    reading === "model-turn"
      ? isSpokenImageRefusal(prose, ALIBABA_CONTENT_REFUSAL_PATTERNS)
      : Boolean(prose) && ALIBABA_CONTENT_REFUSAL_PATTERNS.some((pattern) => pattern.test(prose ?? ""));
  return spoken ? spokenImageRefusalReason(finishReason, code) : undefined;
}

/** DashScope's own word for a filtered render, wherever it turned up. */
function isAlibabaRefusalCode(code: string | undefined): code is string {
  return Boolean(code && /data[_ ]?inspection/i.test(code));
}

/**
 * That same verdict, built once for the two paths that carry it in an *error
 * body* rather than in a turn.
 *
 * The async poll's `FAILED` task and a non-2xx HTTP response are the same
 * statement twice — DashScope's own code beside DashScope's own message, with
 * no model prose anywhere near either — so they take the same test and record
 * the same fallback word. Only the status differs, and the async path has none
 * to offer at all: a filtered task reports itself FAILED over an HTTP 200, so it
 * passes `undefined` and the status test stands down. It used to assert a
 * literal `400` instead — the same behaviour, spelled as a claim about a
 * response that never made one, which reads like a guard and is none.
 *
 * `missingImageError` shares the verdict but not the *reading*, and
 * {@link alibabaRefusalReason} is where both are spelled: its prose is the model
 * talking, so it asks for `model-turn` and gets all four ordered readings,
 * while these two ask for `error-body` and get the vocabulary reading alone —
 * because a 400 for a bad model name or a malformed size is a bug to fix rather
 * than an image the book must live without, and a decline read out of an error
 * string would make it permanent. The outage veto is above both and belongs to
 * neither, which is the asymmetry that used to let a filter *outage* named
 * `DataInspectionFailed` settle a plan version's cast.
 *
 * An error body has no finish reason to offer either — there was no turn — so
 * a prose-settled verdict here is `NO_IMAGE`, with a rejected code hung off it
 * as the qualifier. That is the whole of what this path may honestly say: the
 * label it used to write, `code ?? "DataInspectionFailed"`, named either a code
 * the filter test had already refused or one DashScope never sent.
 */
export function alibabaContentRefusal(
  model: string,
  status: number | undefined,
  code: string | undefined,
  message: string | undefined
): ImageContentRefusedError | undefined {
  if (status !== undefined && status !== 400) {
    return undefined;
  }
  const reason = alibabaRefusalReason(code, message, "error-body");
  if (!reason) {
    return undefined;
  }
  return new ImageContentRefusedError({
    provider: "alibaba",
    model,
    reason,
    detail: message
  });
}

/**
 * DashScope's filter, in its own words. The provider half of reading 2 for a
 * model turn, and the whole of the prose evidence for an error body —
 * {@link alibabaRefusalReason} is what decides which, and what refuses to read
 * either over a sentence reporting that same filter broken.
 */
export const ALIBABA_CONTENT_REFUSAL_PATTERNS = [
  /data[_ ]?inspection/i,
  /ip infringement/i,
  /inappropriate content/i,
  /sensitive content/i,
  /content policy/i,
  /policy violation/i
];

