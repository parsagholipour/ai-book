/**
 * Telling "the provider will never draw this" apart from "the provider broke".
 *
 * An image model's content and IP filters answer the same way every time, so
 * every retry ladder above them — BullMQ's attempts, `withRecoverableNetworkRetry`,
 * the primary→fallback swap — spends real money re-asking a question that has
 * already been answered. Callers that can carry on without one particular image
 * (a character reference sheet, an interior illustration) need that distinction
 * before they are allowed to shrug a failure off: shrugging off a *refusal* costs
 * one drawing, while shrugging off an outage the same way records "unrenderable"
 * against a book that would have been drawn a minute later.
 *
 * This half is the classifier: what a provider *raises*, and the four ordered
 * readings that decide whether prose in a picture's place is a filter
 * answering. What a raised refusal then *means* — whether it is settled across
 * both fallback attempts, what it is recorded under, and whether a rewritten
 * prompt may answer it — is `imageRefusalVerdict.ts` next door, which reads
 * this module's evidence and its clearance vocabulary and adds no vocabulary of
 * its own to them.
 */

/** What a provider said when it declined to draw. */
export type ImageRefusalDetails = {
  provider: string;
  model: string;
  /** The provider's own word for the block — `IMAGE_SAFETY`, `DataInspectionFailed`. */
  reason: string;
  /** Whatever prose came with it: a `finishMessage`, a block message, the model's own reply. */
  detail?: string | undefined;
  /**
   * What the provider reported *around* the block without asserting it.
   *
   * The third kind of statement, and the one with no verdict in it: a standing
   * classifier readout, a score table, anything an endpoint returns for a
   * picture it drew as readily as for one it filtered. It is worth keeping —
   * it is often the only machine vocabulary a refusal comes with, and a run log
   * is where anyone would go to see what the filter was looking at — but it
   * says what the classifier *scored*, never what the filter *blocked on*, so
   * nothing here may decide anything over it.
   *
   * That is the whole reason it is its own field rather than more `reason` or
   * more `detail`. Both of those are read: `reason` is bare-word-tested by the
   * child-safety veto and `detail` by the prose half of the same rule, so a
   * table naming `Porn` and `Sexually Explicit` on every answer — which is what
   * Imagen's is — vetoes every refusal it is folded into and takes the
   * copyright rewrite with it. `refusalEvidence` therefore does not read this,
   * and the constructor keeps it out of `message` for the same reason. It
   * travels because it is an own enumerable property, which is all
   * `serializeError` and `serializeFallbackError` copy.
   */
  diagnostics?: string | undefined;
};

export class ImageContentRefusedError extends Error {
  /**
   * A serialized copy of this error keeps this flag, which is what the
   * fallback-error path below recognises: by the time both providers have
   * refused, neither original Error object survives — `serializeFallbackError`
   * reduced each one to a plain record of its own enumerable properties.
   */
  readonly imageContentRefused = true;
  readonly provider: string;
  readonly model: string;
  readonly reason: string;
  readonly detail: string | undefined;
  /** @see ImageRefusalDetails.diagnostics — recorded, never read into a verdict. */
  readonly diagnostics: string | undefined;

  constructor(details: ImageRefusalDetails) {
    const detail = details.detail?.trim();
    // The message is prose, and prose is evidence: `refusalEvidence` pushes it
    // into the same half it pushes `detail` into. So the diagnostics stay off
    // it — appending a score table here would be folding it into the veto
    // through the back door.
    super(
      `${details.provider} image model ${details.model} refused the prompt (${details.reason}).` +
        (detail ? ` ${detail}` : "")
    );
    this.name = "ImageContentRefusedError";
    this.provider = details.provider;
    this.model = details.model;
    this.reason = details.reason;
    this.detail = detail || undefined;
    this.diagnostics = details.diagnostics?.trim() || undefined;
  }
}

/**
 * Whether prose that arrived in a picture's place is the model *declining*.
 *
 * An image turn that ends normally and carries no picture has two completely
 * different causes, and the response body does not distinguish them: the model
 * may have read the prompt and said in words that it will not draw it, or the
 * render may simply not have happened — a known intermittent failure of the
 * native image models, which answers `STOP` (or `NO_IMAGE`, or `IMAGE_OTHER`)
 * with an apology, an empty turn, or a cheerful "here you go" and no bytes.
 * Treating the second as the first is the expensive mistake: a refusal is
 * durable, so it skips every retry ladder and, for a character reference sheet,
 * is written onto the plan version as a settled fact no retry can revisit.
 *
 * So a spoken refusal has to be *spoken*. The evidence is a first-person
 * decline or the vocabulary a filter uses, and prose that is neither — most of
 * all no prose at all — is not evidence of anything and stays retryable. A
 * refusal phrased in a language these patterns do not cover falls out the same
 * way: it costs a few wasted attempts, which is the direction to be wrong in.
 *
 * Which is the direction each half of the test is written in, because "spoken"
 * is not the same as "contains the word can't". Four readings decide it, and
 * the order is the argument:
 *
 * 1. **A named outage** ends it before anything else is asked. Not prose that
 *    is merely fault-shaped — *this* fault: a service reported temporary,
 *    timed out, rate limited, or a breakage bound to the thing it broke ("the
 *    model is overloaded", "the endpoint is offline", "connection reset"). A
 *    filter verdict never carries one, so nothing outranks it — which is why
 *    the binding is the whole of the rule and not a refinement of it: read
 *    bare, `unavailable` is also the word a filter uses for the block it just
 *    made, and `"The requested content is unavailable due to IP
 *    infringement."` outranked its own verdict. Reading 2 used to run first
 *    and required no objection at all, which made `"InternalError: the data
 *    inspection service is temporarily unavailable, please retry."` a settled
 *    refusal on DashScope and `"Timed out waiting for the content policy check
 *    to finish."` one on everybody.
 * 2. **A filter naming itself** — a policy said to be broken, or intellectual
 *    property — is the strongest evidence there is, and the only kind that
 *    survives a *failure wrapper*: `"Error: content policy violation"` and
 *    `"data inspection failed"` are both a filter answering, because `error`
 *    and `failed` are how a provider wraps a verdict as readily as an outage.
 *    It is discounted when the same prose *clears* the subject instead of
 *    objecting to it, which is a thing a drawn picture's own narration says
 *    ("the design is original and does not infringe", "the picture avoids any
 *    inappropriate content").
 * 3. **A failure wrapper** then ends it — `error`, `failed`, `failure`. It is
 *    strictly weaker than reading 2 and no longer pretends otherwise, but it
 *    still outranks a decline: a decline is about the *request*, so a turn
 *    that wraps itself in a failure and declines nothing by name is describing
 *    the very thing this predicate exists to keep retryable.
 * 4. **A decline the speaker owns**, and only one anchored to the act being
 *    declined. `/\bi\s+can['’]?t\b/` on its own read `"I can't wait to show
 *    you!"` — an *enthusiastic* turn that happened to lose its bytes, the
 *    documented intermittent failure — as a settled refusal, and
 *    `/unable\s+to\s+render/` read `"Error: unable to render image, connection
 *    reset by peer"` the same way. Both cost a character its reference sheet
 *    for the life of the plan.
 *
 * The two vetoes are written over the *fault*, never over the scene, which is
 * the same rule `isNeverRewritableRefusal` (`imageRefusalVerdict.ts`) is
 * written under.
 * Gemini's native models answer a picture-less turn by restating the request
 * back as prose, so a veto keyed on bare `busy`, `network`, `capacity`,
 * `internal` or `servers` reads the illustration a book asked for: `"I can't
 * create an image of a busy market street featuring Elsa."` and `"I cannot
 * create an image of the Cartoon Network character."` were not typed as
 * refusals at all, so `withRecoverableNetworkRetry` spent three attempts on
 * each, the fallback provider was asked, and `CopyrightSafeRetryImageAdapter`
 * — keyed on the typed verdict — never fired for the exact refusal it exists
 * for. Those words now count only bound to a breakage.
 *
 * A provider whose filter has words of its own — DashScope says
 * `DataInspectionFailed` and "IP infringement" in sentences — passes them as
 * `providerVocabulary`, and they join **reading 2**. That is the whole of what
 * a caller may contribute: the vocabulary is per-provider, the four readings
 * are not. Alibaba used to spell its half as a separate flat predicate ORed
 * beside this one, which is reading 2 with both of its guards missing — the
 * bare `/content policy/i` in that list read `"generated in accordance with the
 * content policy"` as a refusal, the exact compliance narration the rewrite of
 * this predicate exists to keep retryable, and permanently so.
 */
export function isSpokenImageRefusal(
  text: string | undefined,
  providerVocabulary: readonly RegExp[] = []
): boolean {
  const spoken = text?.trim();
  if (!spoken) {
    return false;
  }
  if (namesProviderOutage(spoken)) {
    return false;
  }
  if (namesTheFilter(spoken, providerVocabulary)) {
    return true;
  }
  if (FAILURE_WRAPPER_EVIDENCE.some((pattern) => pattern.test(spoken))) {
    return false;
  }
  return SPOKEN_DECLINE_EVIDENCE.some((pattern) => pattern.test(spoken));
}

/**
 * Reading 1 on its own, for the callers whose prose is *not* a model talking.
 *
 * The four readings are one ordered argument about a chat turn, and only two of
 * them travel: a provider's error body is the provider describing its own
 * failure, so readings 3 and 4 have nothing to weigh there — a first-person
 * decline read out of an error string would make "unable to generate" for a bad
 * model name permanent, which is why `alibaba.ts` keeps its error-body paths off
 * {@link isSpokenImageRefusal} deliberately.
 *
 * What those paths *do* share with a turn is this reading, and they were missing
 * it. A provider spells its filter's vocabulary and its own outages into the
 * same sentence — `"InternalError: the data inspection service is temporarily
 * unavailable, please retry."` names DashScope's inspector while saying the
 * inspector is *broken* — so a vocabulary test with nothing above it typed a
 * transient failure as a settled, unretryable refusal, and for a character
 * reference sheet wrote it onto the plan version as a fact no pass revisits.
 * Exported rather than copied so the two spellings cannot drift: there is one
 * {@link NAMED_OUTAGE_EVIDENCE}, and a caller that owns a filter vocabulary owns
 * no part of the veto that outranks it.
 */
export function namesProviderOutage(text: string | undefined): boolean {
  const spoken = text?.trim();
  if (!spoken) {
    return false;
  }
  return NAMED_OUTAGE_EVIDENCE.some((pattern) => pattern.test(spoken));
}

/**
 * Reading 2: the filter's own vocabulary, whoever spoke it — unless the same
 * prose was clearing the picture rather than objecting to it.
 */
function namesTheFilter(spoken: string, providerVocabulary: readonly RegExp[]): boolean {
  if (CLEARED_CONTENT_EVIDENCE.some((pattern) => pattern.test(spoken))) {
    return false;
  }
  return (
    FILTER_VOCABULARY_EVIDENCE.some((pattern) => pattern.test(spoken)) ||
    providerVocabulary.some((pattern) => pattern.test(spoken))
  );
}

/**
 * The word a refusal *nobody named* is recorded under.
 *
 * Reaching here means the prose settled it: the provider's own code was either
 * absent or already asked about and rejected. So the label has to say what
 * actually established the verdict, and the only provider word left is the
 * finish reason — kept when it says something more than "the turn ended", which
 * neither Gemini's `STOP` nor DashScope's lowercase `stop` does. Both spellings
 * mean the same thing, so the comparison is case-insensitive for both rather
 * than exact for one.
 *
 * `qualifier` is a code the caller has *already rejected* as the verdict,
 * travelling as the qualifier it is — the way `missingImagenImageError` hangs
 * Gemini's safety categories off `RAI_FILTERED`. Alibaba's `missingImageError`
 * used to answer that code first, handing straight back the value its own
 * filter test had just refused: a picture-less 200 carrying `InvalidParameter`
 * beside a spoken decline was written down as refused *for* `InvalidParameter`
 * — in the run log, and onto `PlanVersion.characterReferenceRefusals` as a
 * settled fact no retry revisits. Dropping it instead would be the same mistake
 * pointing the other way, because `imageRefusalCategory` reads a recorded reason
 * as evidence and DashScope's filter vocabulary is wider than `data inspection`,
 * so an IP code thrown away here is a copyright rewrite silently not offered.
 * Gemini's native turns carry no such code and pass nothing.
 */
export function spokenImageRefusalReason(finishReason: string | undefined, qualifier?: string | undefined): string {
  const named = finishReason?.trim();
  const spoken = named && named.toLowerCase() !== "stop" ? named : "NO_IMAGE";
  return qualifier ? `${spoken}: ${qualifier}` : spoken;
}

/**
 * The act a decline has to be *about*.
 *
 * A modal on its own says nothing: the sentence has to go on to name drawing,
 * creating or helping. Conspicuously absent are the verbs a service uses about
 * itself — `complete`, `finish`, `access`, `reach`, `connect`, `respond` —
 * because "I'm unable to complete the request" is what an outage says, and the
 * whole point of this module is that an outage is not a verdict.
 */
const DECLINED_ACT = String.raw`(?:creat|generat|produc|draw|render|mak|illustrat|depict|design|provid|fulfil|help|assist|compl(?:y|ie))`;

/**
 * What may stand between the modal and the act it governs: an adverb, and the
 * auxiliary skeleton of the modal's own verb phrase ("be able to", "going to").
 * Nothing else, because anything else is a *different* verb taking an
 * infinitive — which is exactly how `"I can't wait to make more!"` used to read
 * as a refusal to make anything.
 */
const DECLINE_TAIL = String.raw`(?:\s+(?:really|simply|actually|honestly|unfortunately|be|been|able|going|willing|allowed|permitted|to))*\s+`;

/**
 * Where a decline is allowed to stand with no speaker in front of it.
 *
 * The two first-person patterns below carry `I`, and the two after them carry
 * nothing — which is the difference between a subject *elided* and a subject
 * that belongs to something else. `"Unable to generate an image for this
 * prompt."` is a model writing a headless sentence about itself; `"The image
 * cannot be rendered."` is a full passive clause whose subject is the
 * *artifact*, a report that the render did not happen. That report is the
 * documented intermittent failure, and it was a settled refusal for as long as
 * the last pattern asked for no anchor at all — as were `"The picture can't be
 * generated right now."` and `"This illustration cannot be created at the
 * requested size."`, none of which carries a fault word for either veto to
 * catch. So the subjectless family may only begin a sentence or a clause:
 * anywhere else something *is* the subject, and it is not the speaker.
 */
const DECLINE_CLAUSE_START = String.raw`(?:^|[.!?;:,\n\r()"“”—–]\s*)`;

const SPOKEN_DECLINE_EVIDENCE = [
  // A first-person decline, with the apostrophe the model actually typed.
  new RegExp(
    String.raw`\bi(?:['’]|\s+a)?m\s+(?:not\s+able|unable)${DECLINE_TAIL}${DECLINED_ACT}`,
    "i"
  ),
  new RegExp(
    String.raw`\bi\s+(?:can(?:['’]?t|not)|can\s+not|won['’]?t|will\s+not|must\s+not|shall\s+not|am\s+not\s+going)${DECLINE_TAIL}${DECLINED_ACT}`,
    "i"
  ),
  // The same decline with the subject dropped rather than replaced — "Unable
  // to generate this image", "Cannot create that". The weakest of the four: an
  // error string echoed as text reads like this, which is why reading 3 runs
  // over both of them.
  new RegExp(String.raw`${DECLINE_CLAUSE_START}(?:unable|not\s+able)\s+to\s+${DECLINED_ACT}`, "i"),
  new RegExp(
    String.raw`${DECLINE_CLAUSE_START}(?:can(?:['’]?t|not)|won['’]?t)\s+(?:be\s+)?${DECLINED_ACT}`,
    "i"
  )
];

/**
 * A policy named *and broken*, or intellectual property, which is the one
 * subject a filter raises and a book's own caption does not.
 *
 * The bare `/(?:content|safety|usage|image)\s+polic/` this replaces matched
 * `"This image was generated in line with the content policy"` — a *compliance*
 * note, the opposite verdict. Naming a policy is not objecting to one, so the
 * objection has to be in the sentence, in either order.
 */
const FILTER_VOCABULARY_EVIDENCE = [
  /\b(?:violat\w*|against|contrary\s+to|breach\w*|block\w*|refus\w*|declin\w*|reject\w*|prohibit\w*|disallow\w*|not\s+(?:permitted|allowed))\b[^.!?]{0,60}\b(?:polic(?:y|ies)|guideline)/i,
  /\b(?:polic(?:y|ies)|guideline)\w*\b[^.!?]{0,60}\b(?:violat\w*|prohibit\w*|forbid\w*|disallow\w*|block\w*|restrict\w*|do(?:es)?\s+not\s+(?:permit|allow))/i,
  /\b(?:copyright|trademark|intellectual\s+property|infring)/i
];

/**
 * What a filter objects to — which is the same list a drawn picture clears
 * itself of, because a clearance is an objection with the verdict flipped.
 */
const FILTER_SUBJECT = String.raw`(?:copyright\w*|trademark\w*|intellectual\s+property|infring\w*|polic(?:y|ies)|guidelines?|inappropriate|sensitive|objectionable|offensive|unsafe|harmful|nudity|violence)`;

/**
 * The presence a clearance denies: the verbs a picture *has* the subject
 * through. Read by lookahead so the verb stays available to the subject test
 * that follows — in "does not infringe any existing work" the verb *is* the
 * subject, and consuming it left the pattern hunting for a second one that was
 * never there.
 */
const PRESENCE_VERB = String.raw`(?:contain|include|depict|show|feature|use|involve|infring|violat|breach|reference|reproduc|cop(?:y|ies))`;

/**
 * What negates a *report*: `do`-support, the copula, the perfect. A modal is
 * conspicuously absent, because a modal negates an undertaking instead — which
 * is the whole difference between "the design does not infringe" and "I will
 * not depict any copyrighted character".
 */
const REPORT_NEGATION = String.raw`\b(?:do(?:es)?|did|is|are|was|were|has|have|had)(?:\s+not|n['’]?t)\s+`;

/** The offence itself, in the verbs a refusal names the act by. */
const OFFENCE_ACT = String.raw`(?:infring|violat|breach)`;

/**
 * Saying the picture *lacks* the thing, which is not the same as saying the
 * picture is not allowed — and not the same as saying it will not be drawn.
 *
 * A bare `not` covered the first two, so this spells out what is being
 * negated. "Does not infringe" and "avoided any inappropriate content" negate
 * the *presence* of the subject; "is not permitted by our content policy"
 * negates the *permission*, and is a filter objecting in as many words —
 * reading the second as a clearance would discount the vocabulary that settles
 * it and leave nothing standing. `never` is gone for the same reason: it is a
 * refusal as often as an absence ("we never allow content that violates
 * policy"), and nothing here needs it.
 *
 * The third negation is the one this list shipped anyway: **a refusal states
 * what it will not do in the same words a clearance uses.** `avoid\w*` read
 * "I must avoid generating content that infringes on intellectual property"
 * as a drawn picture clearing itself, so the one sentence carrying the
 * objection was discounted by its own verb, `imageRefusalCategory` answered
 * `other`, `CopyrightSafeRetryImageAdapter` rethrew, and
 * `renderCharacterReferenceSheets` wrote the refusal onto
 * `PlanVersion.characterReferenceRefusals` — permanent for the life of the
 * plan version, for the exact refusal the rewrite exists to answer. What tells
 * the two apart is tense and stance rather than vocabulary, and each entry
 * carries the half of that its own grammar can hold:
 *
 * - **`avoid` only as `avoids` or `avoided`.** A finite verb reports on a
 *   picture that exists — "the artwork avoids any copyrighted character", "I
 *   avoided any trademarked logos" — while the bare stem is what a modal
 *   takes, and every modal that takes it here is prospective ("must avoid",
 *   "will avoid", "'ll avoid", "to avoid"). Dropping the entry outright was
 *   the other answer and it is the wrong one: both of those clearances are
 *   pinned in `imageRefusal.test.ts` as turns that stay *retryable*, and a
 *   clearance lost on that side is a picture-less blip typed as a settled
 *   refusal — the expensive direction this whole module is written against.
 *   The two consumers of {@link CLEARED_CONTENT_EVIDENCE} are not one
 *   asymmetry: over there a missed clearance costs the picture, and here a
 *   missed objection does, so an entry that cannot be told apart is narrowed
 *   rather than deleted.
 * - **`without` over a thing, never over the offence.** "The scene was drawn
 *   without any trademarked logos" names what the picture lacks; "I can't
 *   create this image without infringing copyright" names the act the speaker
 *   will not commit — and that one types correctly as a refusal on its decline
 *   and then loses its rewrite here.
 * - **the presence verbs only under {@link REPORT_NEGATION}.** "I will not
 *   depict any copyrighted character" and "I will not reproduce a copyrighted
 *   design" are undertakings in the same verbs "does not depict" reports in.
 *
 * The quantifiers keep their bare spelling, and that is a measured residual
 * rather than an oversight. `no`, `none`, `nothing`, `free of`, `devoid of`
 * and `clear of` attach to a noun phrase and say what the picture has none of,
 * so a refusal reaches them only by wrapping one in something this list does
 * not read: a permission predicate ("no copyrighted characters may be
 * generated"), a deontic copula ("the prompt must be devoid of copyrighted
 * characters"), or a negation of the clearance itself ("this prompt is not
 * free of copyrighted material"). Each of those needs a modal or a second
 * negation to identify, and none of them is a spoken decline, so the refusal
 * behind it arrives only on a provider *code*. What narrowing them would cost
 * is the trade `avoid` already lost: they carry the archetypal clearances
 * ("contains no copyrighted characters", "there is no copyright concern",
 * "the illustration contains no trademarked material"), every one of which is
 * pinned as a turn that stays retryable, and one dropped here is a picture
 * refused permanently on the other side of the pair.
 */
const ABSENCE_OF = String.raw`(?:\b(?:no|none|nothing|free\s+(?:of|from)|devoid\s+of|clear(?:ed)?\s+of|avoid(?:s|ed))\b|\bwithout\s+(?!${OFFENCE_ACT})|${REPORT_NEGATION}(?=${PRESENCE_VERB}))`;

/**
 * The same vocabulary used to say the picture is *fine*.
 *
 * A model that drew something narrates its own care — "an original character,
 * so there is no copyright concern", "I avoided any trademarked logos", "the
 * picture avoids any inappropriate content" — and that narration arrives here
 * whenever such a turn loses its bytes.
 *
 * It used to read backward only, from a negation to an intellectual-property
 * word, so it caught the one phrasing pinned below and not its neighbours.
 * `"The artwork is entirely original, so copyright is not a concern."` says
 * the same thing with the subject first and was a permanent refusal; every
 * clearance about something that is *not* intellectual property — the
 * "contains no inappropriate content" family a provider's own vocabulary makes
 * reachable — had no pattern at all. Both directions are here now, over the
 * whole filter subject rather than over the IP half of it.
 *
 * It discounts only the vocabulary reading: a decline still stands on its own,
 * so `"I will not create images that infringe copyright"` is unharmed.
 *
 * Exported for the one other test that had to have it and did not:
 * `namesIntellectualProperty` (`imageRefusalVerdict.ts`) reads the same prose
 * for the same words, and a scene that clears the subject is not a filter
 * naming it there either. Exported rather than copied, so a clearance cannot be
 * recognised on one side of the module pair and not the other.
 */
export const CLEARED_CONTENT_EVIDENCE = [
  new RegExp(String.raw`${ABSENCE_OF}[^.!?]{0,40}\b${FILTER_SUBJECT}`, "i"),
  new RegExp(
    String.raw`\b${FILTER_SUBJECT}[^.!?]{0,40}\b(?:is|are|was|were)\s+not\s+(?:an?\s+|any\s+)?(?:concern|issue|problem|risk|worry|factor)\b`,
    "i"
  ),
  /\b(?:copyright|trademark)\w*[^.!?]{0,40}\b(?:free|cleared|permitted|allowed)\b/i,
  /\b(?:copyright|trademark|royalty)[-\s]free\b/i,
  /\bpublic\s+domain\b/i,
  /\b(?:in\s+line\s+with|complies\s+with|compliant\s+with|in\s+accordance\s+with|consistent\s+with|adheres?\s+to)\b[^.!?]{0,40}\b(?:polic|guideline)/i
];

/**
 * A thing that can break — and, on its own, a thing a picture can just as
 * easily be *of*. None of these words counts until {@link FAULT_STATE} is
 * bound to it.
 *
 * Read bare, they were the veto reading the scene: `network` is Cartoon
 * Network, `servers` are the two carrying plates, `internal` is an anatomy
 * diagram, `capacity` is a stadium filled to it, `busy` is a market street.
 * Each of those is a sentence a native image model writes while restating the
 * request it is refusing, so each turned a genuine refusal back into an
 * ordinary failure and took the copyright rewrite with it, silently.
 */
const FAULTY_RESOURCE = String.raw`(?:network|connection|socket|servers?|upstream|internal|backend|endpoint|gateway|proxy|api|service|system|model|engine|host)`;

/**
 * The four states that a *thing* is in when it has broken.
 *
 * They are adjectives, so they say nothing until something is in them, and
 * what that something is decides the whole verdict: a service reported
 * unavailable is an outage, while "the requested content is unavailable" is a
 * filter's word for a block it has already made. Read bare they were reading 1
 * outranking the filter's own vocabulary — `"The requested content is
 * unavailable due to IP infringement."` and `"Image generation is offline:
 * content policy violation."` were both retryable, so `missingImageError`
 * raised a bare `Error`, three `withRecoverableNetworkRetry` attempts and a
 * whole async Qwen render were bought for a settled verdict, and
 * `CopyrightSafeRetryImageAdapter` — keyed on the typed error — never fired for
 * the exact refusal it exists for. Two of them read the scene as well, which is
 * the other half of the same rule: `offline` is a family reading together in
 * the woods, and `unresponsive` is a patient in a hospital picture.
 *
 * `outages?` is deliberately *not* here. It is a noun that names the breakage
 * itself rather than a state something is reported in, so nothing else can be
 * one — no filter says it and no illustration is of one — and it stays an
 * unbound entry below, where binding it would have made "I can't generate that
 * image, we're experiencing an outage" a permanent refusal.
 */
const OUTAGE_STATE = String.raw`(?:unavailable|unreachable|offline|unresponsive)`;

/** What breaking looks like, in the words a provider uses for it. */
const FAULT_STATE = String.raw`(?:errors?|fail\w*|timed\s+out|time-?outs?|${OUTAGE_STATE}|overload\w*|congest\w*|busy|capacity|outages?|glitch\w*|reset|dropped|aborted|down)`;

/**
 * What may bind a fault to the thing that broke: the copula and a hedge, and
 * nothing that could begin a fresh noun phrase. A determiner in here is an open
 * window — "a model **at the** busy market" is a service at capacity by exactly
 * the grammar "the model **is** overloaded" is — which is the same closed gap
 * `HARM_OBJECT_GAP` uses further down, for the same reason.
 */
const FAULT_LINK = String.raw`(?:\s+(?:is|are|was|were|seems?|appears?|remains?|currently|temporarily|momentarily|still|now|at|over|too|very|been|being|be)){0,3}\s+`;

/**
 * What may be *reported* in one of those four states and mean an outage by it.
 *
 * Wider than {@link FAULTY_RESOURCE} on purpose, and safe to be: it is only
 * ever read beside {@link OUTAGE_STATE}, and no picture is of a platform being
 * offline the way one is of a busy market street, so the scene cannot reach it.
 * What it leaves out is the point of it — `content`, `image`, `prompt`,
 * `request`, `generation`, `result`. Those are what a *filter* reports
 * unavailable, and a sentence whose subject is one of them has said nothing
 * about a service at all.
 *
 * Binding the four is the expensive direction, so this list is what keeps a
 * genuine outage denying: without it `"I'm unable to generate this image
 * because the feature is unavailable."` would fall through reading 1 into a
 * decline and be recorded as a settled refusal. A sentence that names no
 * subject at all — `"Image generation is unavailable at this time."` — reaches
 * no reading and stays the retryable failure it already was.
 */
const OUTAGE_SUBJECT = String.raw`(?:${FAULTY_RESOURCE}|provider|platform|feature|capability|resource|renderer|region|cluster|instance|datacent(?:er|re))`;

/**
 * An outage named as an outage. Reading 1, and it outranks everything.
 *
 * Every entry either *is* a transient condition — a word nothing but a broken
 * service is ever described by — or binds a breakage to the thing it broke, so
 * none of them is something a filter says while refusing, and none is advice to
 * the reader, which is why a bare "try again" is absent. A real refusal often
 * ends "please try again with an original character", and vetoing on that would
 * throw away the refusals this predicate is for. "Try again *later*" is
 * different: only an outage asks you to wait.
 *
 * **`please retry` was that rule broken by its own list.** It sat here
 * unbound, so `"The request was blocked for copyright reasons. Please retry
 * with an original design."` — the commonest wording an IP filter ends on —
 * ended at reading 1 as a transient, above the vocabulary that settles it.
 * That is the whole of the damage: on the default native image model
 * `missingNativeImageError` hands back a plain `Error`,
 * `isRecoverableNetworkError` matches none of it so no retry runs, the
 * fallback provider is paid for the same verdict, `CopyrightSafeRetryImageAdapter`
 * is keyed on the typed error and never fires, and `renderCharacterReferenceSheets`
 * reads the untyped failure as an outage — `failed = true`, thrown, GENERATE_BOOK
 * failed and the project FAILED before a page existed. Nothing is lost by its
 * going: every spelling that names a *wait* — "please retry later", "please
 * retry in a moment" — is the sibling entry above, and an outage that says
 * nothing but "please retry" still denies through the fault it also names
 * ("temporarily", "the service is unavailable") or through reading 3
 * ("Request failed, please retry.").
 *
 * Binding it sentence-finally instead — a bare "Please retry." being the ask an
 * outage makes, and "please retry *with an original design*" being advice about
 * the prompt — was the narrower fix and is the wrong one, because the two
 * residual errors do not cost the same here. A transient typed as a refusal
 * costs one reference sheet, which `renderCharacterReferenceSheets` tolerates
 * and writes down; a refusal typed as a transient is the untyped `Error` above,
 * which that same caller reads as an outage and fails the whole GENERATE_BOOK
 * job on. So reading 1 keeps only the words that cannot be the tail of a
 * verdict at all.
 */
const NAMED_OUTAGE_EVIDENCE = [
  /\b(?:temporar(?:y|ily)|transient|intermittent)\b/i,
  /\b(?:timed\s+out|time[-\s]?outs?)\b/i,
  /\b(?:rate[-\s]?limit\w*|quotas?|too\s+many\s+requests)\b/i,
  /\boutages?\b/i,
  /\b(?:try|tries|trying|retry|retrying)\s+(?:again\s+)?(?:later|shortly|soon|in\s+a\s+(?:moment|bit|few|while))\b/i,
  /\bsomething\s+went\s+wrong\b/i,
  new RegExp(String.raw`\b${FAULTY_RESOURCE}${FAULT_LINK}${FAULT_STATE}\b`, "i"),
  new RegExp(String.raw`\b${OUTAGE_SUBJECT}${FAULT_LINK}${OUTAGE_STATE}\b`, "i"),
  new RegExp(
    String.raw`\b${FAULT_STATE}\s+(?:of|in|on|from|reaching|contacting)\s+(?:the\s+|a\s+|an\s+|our\s+|its\s+|their\s+)?${FAULTY_RESOURCE}\b`,
    "i"
  )
];

/**
 * A failure *wrapper*. Reading 3, and it is weaker than the filter naming
 * itself.
 *
 * These are the words a provider puts around a settled verdict as readily as
 * around an outage — `"Error: content policy violation"` and `"Error: data
 * inspection failed for the request."` are both a filter answering — so they
 * may not outrank reading 2 the way a named outage does. What they still
 * outrank is a decline: a turn that wraps itself in a failure and names no
 * filter is describing the very thing this predicate exists to keep retryable,
 * which is what keeps the subjectless `unable to …` family safe to have.
 */
const FAILURE_WRAPPER_EVIDENCE = [
  /\berrors?\b/i,
  /\b(?:request|call|render|generation|operation|attempt|task)\s+fail\w*/i,
  /\bfail\w*\s+(?:to|with|due|because)\b/i,
  /\bfailure\b/i
];

/**
 * True only when nothing was left to ask.
 *
 * A refusal from one provider standing beside a 503 from the other is not a
 * refused image: it is an outage with a filtered primary, and the fallback is
 * still worth a retry. Both attempts have to have been answered by a filter
 * before an image counts as one this book will never get.
 */
export function isImageContentRefusalError(error: unknown): boolean {
  const attempts = fallbackAttemptErrors(error);
  if (attempts) {
    return attempts.length > 0 && attempts.every(isSerializedRefusal);
  }
  return isSerializedRefusal(error);
}

/**
 * Everything a refusal said, across both attempts of a fallback, kept apart by
 * how much each half may be trusted to describe the filter: `codes` are the
 * provider's own word for the block, `prose` is whatever came in sentences — a
 * block message, a finish message, the reply the model gave in the picture's
 * place.
 *
 * The split is the whole of what {@link imageRefusalVerdict} is written on, so
 * both halves are exported to it rather than rebuilt there.
 */
export type RefusalEvidence = { codes: string[]; prose: string[] };

export function refusalEvidence(error: unknown): RefusalEvidence {
  const attempts = fallbackAttemptErrors(error) ?? [error];
  const codes: string[] = [];
  const prose: string[] = [];
  for (const attempt of attempts) {
    const record = refusalRecord(attempt);
    if (!record) {
      continue;
    }
    codes.push(record.reason);
    if (record.detail) {
      prose.push(record.detail);
    }
    if (record.message) {
      prose.push(record.message);
    }
  }
  return { codes, prose };
}

/** The provider's own word for the block, for a durable record or a run log. */
export function imageRefusalReason(error: unknown): string {
  const attempts = fallbackAttemptErrors(error);
  const reasons = (attempts ?? [error])
    .map((attempt) => refusalRecord(attempt)?.reason)
    .filter((reason): reason is string => Boolean(reason));
  return reasons.length > 0 ? [...new Set(reasons)].join("+") : "refused";
}

function isSerializedRefusal(error: unknown): boolean {
  return refusalRecord(error) !== undefined;
}

/**
 * The refusal's own fields, whether it arrived as the thrown Error or as the
 * plain record `serializeFallbackError` left behind on an
 * `ImageGenerationFallbackError`.
 *
 * `diagnostics` is deliberately absent: it is the half of a refusal that
 * carries no verdict, so it is not evidence and reading it here is how it
 * would become some. It rides the serialized copy for a human all the same.
 */
function refusalRecord(error: unknown): { reason: string; detail?: string; message?: string } | undefined {
  if (!isRecordLike(error) || error.imageContentRefused !== true) {
    return undefined;
  }
  return {
    reason: typeof error.reason === "string" && error.reason.trim() ? error.reason.trim() : "refused",
    ...(typeof error.detail === "string" ? { detail: error.detail } : {}),
    ...(typeof error.message === "string" ? { message: error.message } : {})
  };
}

/**
 * The two serialized attempts inside an `ImageGenerationFallbackError`, or
 * `undefined` when this is an ordinary single-adapter failure. Read structurally
 * rather than with `instanceof` so a duplicated module copy cannot turn a
 * refused book into a failed one.
 */
function fallbackAttemptErrors(error: unknown): unknown[] | undefined {
  if (!isRecordLike(error) || error.name !== "ImageGenerationFallbackError") {
    return undefined;
  }
  const primary = isRecordLike(error.primary) ? error.primary.error : undefined;
  const fallback = isRecordLike(error.fallback) ? error.fallback.error : undefined;
  return [primary, fallback].filter((attempt) => attempt !== undefined);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
