import { describe, expect, it } from "vitest";
import { FallbackImageAdapter, ImageGenerationFallbackError } from "./imageFallback.js";
import {
  CLEARED_CONTENT_EVIDENCE,
  ImageContentRefusedError,
  imageRefusalReason,
  isImageContentRefusalError,
  isSpokenImageRefusal,
  namesProviderOutage,
  spokenImageRefusalReason
} from "./imageRefusal.js";
import { isRecoverableNetworkError, ProviderHttpError } from "./retry.js";
import type { ImageAdapter } from "./types.js";

const refusingAdapter = (details: { provider: string; model: string; reason: string }): ImageAdapter => ({
  generateImage: async () => {
    throw new ImageContentRefusedError(details);
  }
});

const brokenAdapter = (error: Error): ImageAdapter => ({
  generateImage: async () => {
    throw error;
  }
});

const fallbackError = async (primary: ImageAdapter, fallback: ImageAdapter): Promise<unknown> => {
  const adapter = new FallbackImageAdapter({
    primary: { provider: "gemini", model: "gemini-2.5-flash-image", adapter: primary },
    fallback: { provider: "alibaba", model: "qwen-image-2.0", adapter: fallback }
  });
  return adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((error: unknown) => error);
};

describe("isImageContentRefusalError", () => {
  it("recognises a single adapter's refusal", () => {
    expect(
      isImageContentRefusalError(
        new ImageContentRefusedError({ provider: "gemini", model: "gemini-2.5-flash-image", reason: "IMAGE_SAFETY" })
      )
    ).toBe(true);
  });

  it("does not recognise an ordinary provider failure", () => {
    expect(isImageContentRefusalError(new ProviderHttpError("upstream is down", { status: 503 }))).toBe(false);
    expect(isImageContentRefusalError(new Error("fetch failed"))).toBe(false);
    expect(isImageContentRefusalError(undefined)).toBe(false);
  });

  it("reads through the serialized attempts of a fallback failure", async () => {
    // The failure that ended a book: both image providers answered the same
    // prompt with a filter. Neither original Error survives to this point —
    // `serializeFallbackError` reduced each to a plain record.
    const error = await fallbackError(
      refusingAdapter({ provider: "gemini", model: "gemini-2.5-flash-image", reason: "IMAGE_SAFETY" }),
      refusingAdapter({ provider: "alibaba", model: "qwen-image-2.0", reason: "DataInspectionFailed" })
    );

    expect(error).toBeInstanceOf(ImageGenerationFallbackError);
    expect(isImageContentRefusalError(error)).toBe(true);
    expect(imageRefusalReason(error)).toBe("IMAGE_SAFETY+DataInspectionFailed");
  });

  it("keeps a refusal out of the network retry ladder, whatever prose it carries", () => {
    // The detail is the model's own words, so it can contain a pattern the
    // network matcher looks for and buy three retries of a settled verdict.
    const refusal = new ImageContentRefusedError({
      provider: "gemini",
      model: "gemini-2.5-flash-image",
      reason: "IMAGE_SAFETY",
      detail: "I can't draw a network timeout diagram of that character."
    });

    expect(isRecoverableNetworkError(refusal)).toBe(false);
  });

  it("refuses to call it settled when only one provider was asked properly", async () => {
    // A filtered primary beside an outage on the fallback is not an image this
    // book will never get: the fallback is still worth another delivery, and
    // recording "unrenderable" here would give up on a drawing a minute early.
    const error = await fallbackError(
      refusingAdapter({ provider: "gemini", model: "gemini-2.5-flash-image", reason: "IMAGE_SAFETY" }),
      brokenAdapter(new ProviderHttpError("upstream is down", { status: 503 }))
    );

    expect(isImageContentRefusalError(error)).toBe(false);
  });
});

describe("isSpokenImageRefusal", () => {
  it("recognises the model declining in its own words", () => {
    expect(isSpokenImageRefusal("I can't draw a copyrighted character.")).toBe(true);
    expect(isSpokenImageRefusal("I cannot create this image.")).toBe(true);
    expect(isSpokenImageRefusal("I'm unable to generate that picture.")).toBe(true);
    expect(isSpokenImageRefusal("I’m not able to help with this request.")).toBe(true);
    expect(isSpokenImageRefusal("I am unable to produce this illustration.")).toBe(true);
    expect(isSpokenImageRefusal("Sorry, I won't be drawing that.")).toBe(true);
    expect(isSpokenImageRefusal("Unable to generate an image for this prompt.")).toBe(true);
  });

  it("recognises the vocabulary a filter uses, whoever spoke it", () => {
    expect(isSpokenImageRefusal("This request violates our content policy.")).toBe(true);
    expect(isSpokenImageRefusal("The prompt goes against the safety guidelines.")).toBe(true);
    expect(isSpokenImageRefusal("That character is trademarked.")).toBe(true);
    expect(isSpokenImageRefusal("Generating this would infringe copyright.")).toBe(true);
  });

  it("is not evidence of anything when the turn simply produced nothing", () => {
    // The intermittent failure this predicate exists to keep retryable: a
    // finished turn with no picture and nothing said about why. Calling that a
    // refusal makes a blip permanent.
    expect(isSpokenImageRefusal(undefined)).toBe(false);
    expect(isSpokenImageRefusal("")).toBe(false);
    expect(isSpokenImageRefusal("   ")).toBe(false);
    expect(isSpokenImageRefusal("Here is the illustration of Nora in the garden.")).toBe(false);
    expect(isSpokenImageRefusal("Generating the reference sheet now.")).toBe(false);
    // A model saying it *can* is the mirror image, and the pattern must not
    // read the negation off the wrong side of it.
    expect(isSpokenImageRefusal("I am able to create that illustration.")).toBe(false);
  });

  /**
   * The expensive direction, one row at a time.
   *
   * Every string here is a *transient* answer — the intermittent no-bytes turn
   * the whole module exists for — and every one of them matched the predicate
   * before it required the decline to name the act it was declining. A hit on
   * any of them is a permanent `ImageContentRefusedError`: no retry ladder
   * runs, and a character reference sheet is written onto the plan version as
   * refused for the life of that plan.
   */
  it.each([
    // A fault named in the same breath as the decline.
    "I couldn't generate the image due to a temporary error. Please try again.",
    "I'm unable to complete the request right now due to a temporary service error. Please try again.",
    "Unable to generate the image at this time, please try again later.",
    "Sorry, I can't seem to reach the image service right now. Please try again in a moment.",
    "I cannot access the image generation service at the moment (rate limit exceeded).",
    "An error occurred and I was not able to render the illustration.",
    "Image generation is temporarily unavailable; unable to produce an image. Try again shortly.",
    "I can't right now, the model is overloaded.",
    "I will not be able to finish before the timeout.",
    // A transport error echoed back as the text part.
    "Request failed: unable to generate image (500 internal error)",
    "Error: unable to render image, connection reset by peer",
    // A modal that governs some other verb entirely. The turn is cheerful and
    // the bytes simply did not arrive — the documented blip, verbatim.
    "I can't wait to show you — here it is!",
    "I won't add text to the image, as requested.",
    // Truncation: MAX_TOKENS is not a block finish reason, so the half-sentence
    // it leaves behind is read as prose.
    "Absolutely! Here's Nora in three views. I can't wait for you to",
    // A drawn picture narrating its own care. The filter's vocabulary appears,
    // clearing the image rather than objecting to it.
    "Here's the illustration. The character design is original and does not infringe any existing work.",
    "I created an original character so there is no copyright concern.",
    "I avoided any trademarked logos in the background.",
    "This image was generated in line with the content policy."
  ])("keeps a transient or ordinary turn retryable: %s", (spoken) => {
    expect(isSpokenImageRefusal(spoken)).toBe(false);
  });

  /**
   * An outage standing in the filter's own vocabulary.
   *
   * Reading 2 used to run first and asked for no objection at all, so any
   * sentence carrying a filter word settled it — including the sentences that
   * are *about the filter being broken*. Every string here is a service
   * failing, and every one of them became an `ImageContentRefusedError`: for a
   * character reference sheet that is a row on
   * `PlanVersion.characterReferenceRefusals` no retry revisits, so the
   * character goes without a sheet for the life of the plan.
   */
  it.each([
    // The check itself, reported down. A named outage now outranks reading 2.
    "Timed out waiting for the content policy check to finish.",
    "The copyright screening service is temporarily unavailable.",
    "Error: failed to render image, copyright service unavailable.",
    "The safety classifier is overloaded, please retry.",
    // A clearance the backward-only pattern could not see, because the subject
    // comes first.
    "The artwork is entirely original, so copyright is not a concern.",
    "The illustration contains no trademarked material, so infringement is not an issue."
  ])("keeps an outage or a clearance in the filter's own words retryable: %s", (spoken) => {
    expect(isSpokenImageRefusal(spoken)).toBe(false);
  });

  /**
   * The clearance vocabulary, one surviving {@link CLEARED_CONTENT_EVIDENCE}
   * entry at a time, on the side of the pair where losing one is permanent.
   *
   * This is why the entries a refusal shares were *narrowed* rather than
   * deleted. Every string here is a drawn picture that lost its bytes and
   * narrated its own care, and every one of them carries a word from
   * `FILTER_VOCABULARY_EVIDENCE`: drop the clearance that discounts it and
   * reading 2 settles it as an `ImageContentRefusedError` — unretryable
   * everywhere, and for a character reference sheet a row on
   * `PlanVersion.characterReferenceRefusals` no pass revisits. The
   * `imageRefusalCategory` half of the same list is written under the opposite
   * asymmetry, which is exactly why an ambiguous entry cannot simply be
   * removed to satisfy it.
   */
  it.each([
    "The illustration contains no copyrighted characters.",
    "None of the elements in this picture are copyrighted.",
    "There is nothing copyrighted in this illustration.",
    "The scene was drawn without any trademarked logos.",
    "The final artwork is free of any copyrighted material.",
    "The composition is free from trademarked elements.",
    "The composition is devoid of trademarked elements.",
    "The image was cleared of trademark concerns before rendering.",
    "The artwork avoids any copyrighted character.",
    "I avoided any trademarked logos in the background.",
    "The design is original and does not infringe any existing work.",
    "The picture doesn't contain any copyrighted characters.",
    "The final sheet is not depicting a trademarked mascot.",
    "The render has not reproduced any copyrighted artwork."
  ])("keeps a drawn picture's own compliance narration retryable: %s", (spoken) => {
    expect(isSpokenImageRefusal(spoken)).toBe(false);
  });

  /**
   * A decline with no speaker in front of it.
   *
   * `cannot be rendered` used to be enough on its own, which reads the passive
   * report of a render that did not happen — the documented intermittent
   * failure, verbatim — as the model declining. None of these carries a fault
   * word, so neither veto catches them: the anchor is the only thing that can.
   */
  it.each([
    "The image cannot be rendered.",
    "The picture can't be generated right now.",
    "This illustration cannot be created at the requested size.",
    "Your reference sheet could not be produced, so the image cannot be drawn."
  ])("does not read an impersonal report of a missing render as a decline: %s", (spoken) => {
    expect(isSpokenImageRefusal(spoken)).toBe(false);
  });

  /**
   * The scene is not the fault.
   *
   * Gemini's native models answer a picture-less turn by restating the request
   * back as prose, so a veto keyed on bare `busy`, `network`, `capacity`,
   * `internal` or `servers` reads the illustration the book asked for. Each of
   * these is a real refusal about a protected name that was not typed as one at
   * all — three attempts of `withRecoverableNetworkRetry`, a fallback render,
   * a job retry, and `CopyrightSafeRetryImageAdapter` never reached, because it
   * is keyed on the typed verdict.
   */
  it.each([
    "I can't create an image of a busy market street featuring Elsa.",
    "I cannot create an image of the Cartoon Network character.",
    "I can't create an image of a stadium filled to capacity with Marvel characters.",
    "I cannot create an image showing the internal anatomy of Pikachu.",
    "I can't create an image of restaurant servers dressed as Disney princesses.",
    "I won't draw Mickey Mouse connecting the network cables in a busy office.",
    "I can't create an image of a model at the busy market beside Hello Kitty."
  ])("still reads a refusal whose restated scene happens to use a fault word: %s", (spoken) => {
    expect(isSpokenImageRefusal(spoken)).toBe(true);
  });

  it("still keeps the same words retryable when they describe the service instead", () => {
    // The other side of the pair above: the veto did not go away, it stopped
    // reading nouns and started reading breakage bound to what broke.
    expect(isSpokenImageRefusal("I can't create the image: the model is overloaded.")).toBe(false);
    expect(isSpokenImageRefusal("I cannot create the image, the network connection was reset.")).toBe(false);
    expect(isSpokenImageRefusal("I can't render it — the image servers are at capacity.")).toBe(false);
    expect(isSpokenImageRefusal("Unable to generate: internal error in the upstream service.")).toBe(false);
    expect(isSpokenImageRefusal("I can't draw that, the service is busy right now.")).toBe(false);
  });

  /**
   * The four fault words that never got that rule, one row at a time.
   *
   * `unavailable`, `unreachable`, `offline` and `unresponsive` sat in reading 1
   * unbound while their neighbours were bound, and reading 1 outranks the
   * filter's own vocabulary — so a genuine block phrased with one of them was
   * *retryable*. That is `missingImageError` throwing a bare `Error`: three
   * `withRecoverableNetworkRetry` attempts on the primary, a whole async Qwen
   * render, the fallback provider and the job's own ladder, and
   * `CopyrightSafeRetryImageAdapter` — keyed on the typed verdict — never
   * reached. The last two are the other half of the same rule: read bare, those
   * words are the veto reading the restated scene.
   */
  it.each([
    "The image is unavailable because it violates our content policy.",
    "Generation is unavailable: this infringes copyright.",
    "The requested content is offline for policy reasons; it violates our guidelines.",
    "I can't create an image of a family offline in the woods, featuring Elsa.",
    "I cannot create an image of an unresponsive patient beside Elsa."
  ])("still reads a refusal whose fault word is about the content, not a service: %s", (spoken) => {
    expect(isSpokenImageRefusal(spoken)).toBe(true);
  });

  /**
   * And the expensive direction of that same change, which is the one that had
   * to be paid for: binding the four turns some currently-retryable prose into
   * a settled refusal, so a genuine outage has to keep denying — through the
   * thing that broke where one is named, and through no reading at all where
   * none is. `outages?` stays unbound because it is the breakage rather than a
   * state something is reported in: bound, "we're experiencing an outage" would
   * have fallen through to the decline beside it.
   */
  it.each([
    "The upstream service is unavailable.",
    "Our servers are unresponsive right now.",
    "The model is unreachable.",
    "The endpoint is offline.",
    "503 Service Unavailable",
    "The image generation service is currently unavailable.",
    "I'm unable to generate this image because the feature is unavailable.",
    "I can't create the image; the provider is unavailable.",
    "Unable to generate: the rendering platform is offline.",
    "I can't generate that image, we're experiencing an outage.",
    "Image generation is unavailable at this time."
  ])("still denies a genuine outage once those words are bound to what broke: %s", (spoken) => {
    expect(isSpokenImageRefusal(spoken)).toBe(false);
  });

  /**
   * Reading 1 reading the *advice* a refusal ends on, which is the same class
   * of mistake as reading the scene and was shipped into the same list.
   *
   * `/\bplease\s+retry\b/i` sat in {@link NAMED_OUTAGE_EVIDENCE} unbound, and
   * reading 1 outranks everything — so the commonest wording an IP filter ends
   * on settled as a transient. On the default native image model that is a
   * plain `Error` out of `missingNativeImageError`, matching none of
   * `isRecoverableNetworkError`, so no retry runs, the fallback provider is
   * paid for the same verdict, `CopyrightSafeRetryImageAdapter` never fires,
   * and `renderCharacterReferenceSheets` reads the untyped failure as an outage
   * and fails GENERATE_BOOK — a project FAILED before a page existed, through a
   * sentence a filter writes every day.
   */
  it.each([
    "The request was blocked for copyright reasons. Please retry with an original design.",
    "I can't create an image of Elsa. Please retry with an original character.",
    "I can't create an image of Spider-Man. Please retry with a different prompt.",
    "This violates our content policy. Please retry with a different description."
  ])("does not read the advice a refusal ends on as an outage: %s", (spoken) => {
    expect(namesProviderOutage(spoken)).toBe(false);
    expect(isSpokenImageRefusal(spoken)).toBe(true);
  });

  /**
   * And the direction that had to survive it: an outage that spells "please
   * retry" still denies, through the wait it names, the fault it names, or the
   * failure wrapper it is written in. Nothing here may become a refusal.
   */
  it.each([
    "The service is temporarily unavailable, please retry.",
    "The model is overloaded. Please retry later.",
    "Please retry in a moment.",
    "InternalError: the data inspection service is temporarily unavailable, please retry.",
    "The safety classifier is overloaded, please retry.",
    "Request failed, please retry."
  ])("still keeps an outage that says 'please retry' retryable: %s", (spoken) => {
    expect(isSpokenImageRefusal(spoken)).toBe(false);
  });

  it("keeps a subjectless decline that begins its own clause", () => {
    // The anchor is "the speaker owns the decline", not "a first person says
    // it": an elided subject still reads as the model talking about itself.
    expect(isSpokenImageRefusal("Cannot create an image of that character.")).toBe(true);
    expect(isSpokenImageRefusal("Sorry — can't draw a copyrighted character.")).toBe(true);
    expect(isSpokenImageRefusal("Unable to generate an image for this prompt.")).toBe(true);
  });

  /**
   * The other direction, so tightening cannot quietly become "nothing is a
   * refusal". Each of these is a filter answering, and each sits next to one of
   * the strings above that it would be confused with.
   */
  it.each([
    // "Try again" as *advice* is not a fault, so it must not veto the decline
    // beside it — that phrasing is how a real refusal offers a way forward.
    "I can't create an image of Spider-Man. Please try again with an original character.",
    // A filter that named itself outranks prose about a fault, because an
    // error-shaped wrapper is how some providers spell a settled verdict.
    "Error: content policy violation.",
    "This request was blocked by our content policy.",
    "Our usage policies prohibit this image.",
    // The clearance patterns must discount only the vocabulary reading: this
    // one carries "not … infringe" and is still a first-person decline.
    "I will not create images that infringe copyright."
  ])("still reads a filter answering as a refusal: %s", (spoken) => {
    expect(isSpokenImageRefusal(spoken)).toBe(true);
  });
});

/**
 * DashScope's own filter words, as `alibaba.ts` hands them in. Copied rather
 * than imported so a change there has to be made here too: the point of the
 * parameter is that the vocabulary is the provider's and the readings are not.
 */
const DASHSCOPE_VOCABULARY = [
  /data[_ ]?inspection/i,
  /ip infringement/i,
  /inappropriate content/i,
  /sensitive content/i,
  /content policy/i,
  /policy violation/i
];

describe("isSpokenImageRefusal with a provider's own vocabulary", () => {
  it("reads the provider's filter words as the filter answering", () => {
    // None of these is a first-person decline and none uses the general
    // filter vocabulary, so the provider's half is doing all the work.
    expect(isSpokenImageRefusal("data_inspection_failed", DASHSCOPE_VOCABULARY)).toBe(true);
    expect(isSpokenImageRefusal("Input data may contain inappropriate content.", DASHSCOPE_VOCABULARY)).toBe(true);
    expect(isSpokenImageRefusal("The prompt contains sensitive content.", DASHSCOPE_VOCABULARY)).toBe(true);
  });

  it("joins reading 1, so it still outranks prose about a fault", () => {
    // A verdict wrapped in error-shaped prose is still a verdict. Were the
    // provider's words read after the fault veto rather than with the rest of
    // reading 1, "failed" would throw this one away.
    expect(isSpokenImageRefusal("Error: data inspection failed for the request.", DASHSCOPE_VOCABULARY)).toBe(true);
  });

  it("is discounted by the same clearance veto as the general vocabulary", () => {
    // The bug this parameter replaced. `missingImageError` reads the *model's*
    // prose, and a Qwen turn that drew a picture and lost its bytes narrates
    // its own compliance — which DashScope's bare `/content policy/i` read as
    // a permanent refusal while the very same sentence stayed retryable for
    // Gemini. Pinned above as a transient turn; pinned here as one under the
    // provider's vocabulary too.
    expect(isSpokenImageRefusal("This image was generated in line with the content policy.")).toBe(false);
    expect(isSpokenImageRefusal("This image was generated in line with the content policy.", DASHSCOPE_VOCABULARY)).toBe(
      false
    );
    expect(
      isSpokenImageRefusal("The image was generated in accordance with the content policy.", DASHSCOPE_VOCABULARY)
    ).toBe(false);
  });

  it("still lets a first-person decline stand on its own under the veto", () => {
    // The clearance veto discounts only the vocabulary reading, whichever half
    // of it the words came from.
    expect(
      isSpokenImageRefusal("I won't create an image that is not copyright-free.", DASHSCOPE_VOCABULARY)
    ).toBe(true);
  });

  it("is outranked by an outage named in the provider's own words", () => {
    // The expensive half of finding A, on the endpoint that has a provider
    // vocabulary: DashScope's `data inspection` and `content policy` are the
    // filter's words, and they are also the words the *filter's own service*
    // is described by when it breaks. Reading 1 asking for no objection made
    // every one of these a settled refusal.
    expect(
      isSpokenImageRefusal(
        "InternalError: the data inspection service is temporarily unavailable, please retry.",
        DASHSCOPE_VOCABULARY
      )
    ).toBe(false);
    expect(isSpokenImageRefusal("Timed out waiting for the content policy check to finish.", DASHSCOPE_VOCABULARY)).toBe(
      false
    );
    // A drawn picture clearing itself of something that is not intellectual
    // property. The clearance patterns only covered the IP half.
    expect(isSpokenImageRefusal("The picture avoids any inappropriate content.", DASHSCOPE_VOCABULARY)).toBe(false);
    expect(isSpokenImageRefusal("The prompt contains no sensitive content.", DASHSCOPE_VOCABULARY)).toBe(false);
    // The same, in one of the four words that used to end it unbound.
    expect(isSpokenImageRefusal("The data inspection service is unreachable.", DASHSCOPE_VOCABULARY)).toBe(false);
  });

  /**
   * The other side of that ordering, and the endpoint the finding was found on.
   *
   * DashScope is the provider whose filter has words of its own, so it is where
   * an unbound fault word cost the most: reading 1 ended the predicate before
   * the vocabulary was ever consulted, `missingImageError` raised a bare
   * `Error`, and a book whose only image provider is Alibaba bought a settled
   * verdict over and over without ever reaching the copyright rewrite.
   */
  it.each([
    "The requested content is unavailable due to IP infringement.",
    "Image generation is offline: content policy violation.",
    "Output data is unavailable: the prompt contains sensitive content."
  ])("no longer loses the provider's verdict to an unbound fault word: %s", (spoken) => {
    expect(isSpokenImageRefusal(spoken, DASHSCOPE_VOCABULARY)).toBe(true);
  });

  it("still lets a failure wrapper carry the provider's verdict", () => {
    // And the line the outage veto may not cross: `error` and `failed` are how
    // a provider wraps a settled verdict as readily as an outage, so they stay
    // reading 3 rather than joining reading 1.
    expect(isSpokenImageRefusal("Error: data inspection failed for the request.", DASHSCOPE_VOCABULARY)).toBe(true);
    expect(isSpokenImageRefusal("Error: content policy violation.")).toBe(true);
  });

  it("changes nothing for a provider that hands in no vocabulary", () => {
    // Gemini's call site, unchanged: the default is empty, so the three
    // readings are exactly what they were.
    expect(isSpokenImageRefusal("The prompt contains sensitive content.")).toBe(false);
    expect(isSpokenImageRefusal("I can't create an image of Spider-Man.")).toBe(true);
  });
});

/**
 * The clearance patterns' own worst case, measured rather than reasoned about.
 *
 * Narrowing {@link CLEARED_CONTENT_EVIDENCE} put two whitespace runs next to
 * the bounded `[^.!?]{0,40}` gap that follows them — `without\s+` before its
 * lookahead, and the `\s+` inside `does not` — and a run of spaces claimable by
 * either side is exactly the shape that measured 7.2 s at 18 separators in
 * `imagenNamedCategories` one module over. Both are bounded here: the
 * lookahead pins where the `does not` run ends, and `{0,40}` caps what the
 * `without` run can hand over, so nothing has a second parse to try.
 *
 * The ladder is the diagnostic — an exponential parse doubles with every step
 * of `n` and reaches seconds by the top — and the bound is deliberately three
 * orders of magnitude above the measurement (the whole loop is ~2 ms, and the
 * longest input here is 35,000 characters) rather than a stopwatch, because
 * the sibling assertion of this kind has flaked once under full-suite load.
 */
describe("the clearance patterns in bounded time", () => {
  it("does not grow superlinearly on a run of separators either side of a gap", () => {
    const shapes: ((size: number) => string)[] = [
      (size) => `without${" ".repeat(size)}ZZZ`,
      (size) => `without${" ".repeat(size)}copyright`,
      (size) => `without${" ".repeat(size)}infringing${" ".repeat(size)}copyright`,
      (size) => `does${" ".repeat(size)}not${" ".repeat(size)}contain${" ".repeat(size)}ZZZ`,
      (size) => `doesn't${" ".repeat(size)}contain${" ".repeat(size)}ZZZ`,
      (size) => `free${" ".repeat(size)}of${" ".repeat(size)}ZZZ`,
      (size) => `${"is not ".repeat(size)}ZZZ`,
      (size) => `${"does ".repeat(size)}not contain ZZZ`
    ];

    const started = performance.now();
    for (const shape of shapes) {
      for (const size of [10, 14, 16, 18, 24, 5_000]) {
        for (const pattern of CLEARED_CONTENT_EVIDENCE) {
          pattern.test(shape(size));
        }
      }
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("spokenImageRefusalReason", () => {
  it("keeps a finish reason that says more than the turn ended", () => {
    expect(spokenImageRefusalReason("IMAGE_OTHER")).toBe("IMAGE_OTHER");
    expect(spokenImageRefusalReason("MAX_TOKENS")).toBe("MAX_TOKENS");
  });

  it("records a turn that merely ended under NO_IMAGE, in either provider's spelling", () => {
    // Gemini screams it, DashScope whispers it, and they mean the same thing:
    // the turn ended and nothing was said about why.
    expect(spokenImageRefusalReason("STOP")).toBe("NO_IMAGE");
    expect(spokenImageRefusalReason("stop")).toBe("NO_IMAGE");
    expect(spokenImageRefusalReason(undefined)).toBe("NO_IMAGE");
    expect(spokenImageRefusalReason("   ")).toBe("NO_IMAGE");
  });

  it("carries a rejected code as a qualifier rather than as the verdict", () => {
    // The code test has already said no to this code, so it may not be the
    // reason — but it is evidence `imageRefusalCategory` reads, so it travels.
    expect(spokenImageRefusalReason("stop", "InvalidParameter")).toBe("NO_IMAGE: InvalidParameter");
    expect(spokenImageRefusalReason("length", "IPInfringementSuspect")).toBe("length: IPInfringementSuspect");
    // Gemini's native turn has no such field, and passes nothing.
    expect(spokenImageRefusalReason("STOP", undefined)).toBe("NO_IMAGE");
  });
});
