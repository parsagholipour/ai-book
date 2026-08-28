import { isCancellationError } from "./retry.js";
import {
  imageAdapterCapabilities,
  type ImageAdapter,
  type ImageFallbackAttempt,
  type ImageFallbackMetadata,
  type ImageFallbackReferenceTrim,
  type ImageRequest,
  type ImageResult
} from "./types.js";

export type ImageFallbackProvider = {
  provider: string;
  model: string;
};

/**
 * What a layer that cannot read the caller's sentences can still say truthfully
 * about them.
 *
 * Emptying the attachment is only half of an unre-statable trim. The prompt's
 * claims are *about* that attachment — a count of it, and an attribution naming
 * the last few — and shortening the array to nothing leaves every one of them
 * standing over nothing: the render goes out told to match, exactly, a saved
 * face it was not given. That is the same defect a partial attachment has, one
 * step further along, and this file already refuses the partial one.
 *
 * Re-stating a claim needs the caller's own words, which is what
 * `ImageRequest.promptForReferenceImages` is for and why nothing here tries to
 * rewrite a sentence it did not write. **Retracting one does not.** With the
 * attachment empty there is exactly one true statement about it, it is the same
 * statement whatever the caller wrote, and it discharges every indexed claim at
 * once — which is precisely what stops being available the moment a single
 * picture is attached. So the retraction covers the zero case and only the zero
 * case, and a trim that would attach *some* still has to be re-stated or
 * emptied.
 */
export const NO_REFERENCE_IMAGES_CORRECTION =
  "Correction, and it overrides anything stated above: no reference images are attached to this request. " +
  "Disregard every instruction about attached reference images — how many there are, and what any particular " +
  "one of them shows. Draw from this description alone.";

export type ImageFallbackEvent =
  | {
      event: "fallback.start";
      primary: ImageFallbackAttempt & { error: Record<string, unknown> };
      fallback: ImageFallbackProvider;
    }
  | {
      event: "fallback.references_trimmed";
      primary: ImageFallbackAttempt & { error: Record<string, unknown> };
      fallback: ImageFallbackProvider;
      references: ImageFallbackReferenceTrim;
    }
  | {
      event: "fallback.success";
      primary: ImageFallbackAttempt & { error: Record<string, unknown> };
      fallback: ImageFallbackProvider;
      result: ImageFallbackProvider;
    }
  | {
      event: "fallback.error";
      primary: ImageFallbackAttempt & { error: Record<string, unknown> };
      fallback: ImageFallbackAttempt & { error: Record<string, unknown> };
    };

export type FallbackImageAdapterOptions = {
  primary: ImageFallbackProvider & { adapter: ImageAdapter };
  fallback: ImageFallbackProvider & { adapter: ImageAdapter | (() => ImageAdapter) };
  onEvent?: (event: ImageFallbackEvent) => void | Promise<void>;
  shouldFallback?: (error: unknown) => boolean;
};

export class ImageGenerationFallbackError extends Error {
  readonly primary: ImageFallbackAttempt & { error: Record<string, unknown> };
  readonly fallback: ImageFallbackAttempt & { error: Record<string, unknown> };

  constructor(options: {
    primary: ImageFallbackAttempt & { error: Record<string, unknown> };
    fallback: ImageFallbackAttempt & { error: Record<string, unknown> };
  }) {
    super(
      `Image generation failed for primary ${options.primary.provider}/${options.primary.model} and fallback ${options.fallback.provider}/${options.fallback.model}. ` +
        `Primary error: ${errorMessage(options.primary.error)} Fallback error: ${errorMessage(options.fallback.error)}`
    );
    this.name = "ImageGenerationFallbackError";
    this.primary = options.primary;
    this.fallback = options.fallback;
  }
}

export class FallbackImageAdapter implements ImageAdapter {
  private fallbackAdapter: ImageAdapter | undefined;

  constructor(private readonly options: FallbackImageAdapterOptions) {}

  /**
   * The **primary's** budget, deliberately — and `refitForFallback` is what
   * makes that safe.
   *
   * The two adapters rarely agree: on the default config a premium cover runs
   * `gemini-3-pro-image` (five references) over a `qwen-image-2.0-pro` fallback
   * (three), and an operator who points the fallback at a text-to-image Qwen
   * model has one that takes none at all. Reporting the intersection never
   * over-promises, but it would size every render against an adapter that
   * almost never runs: a premium cover would permanently attach two fewer
   * sheets to pay for an outage that may not happen this month, and a
   * zero-reference fallback would turn character consistency off for the whole
   * book. So the caller keeps sizing against the adapter that draws the
   * picture, and the *fallback attempt* re-fits what it was handed.
   */
  capabilities() {
    return imageAdapterCapabilities(this.options.primary.adapter);
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    try {
      return await this.options.primary.adapter.generateImage(request);
    } catch (error) {
      if (this.options.shouldFallback && !this.options.shouldFallback(error)) {
        throw error;
      }
      const primary = {
        provider: this.options.primary.provider,
        model: this.options.primary.model,
        error: serializeFallbackError(error)
      };
      await this.note({
        event: "fallback.start",
        primary,
        fallback: {
          provider: this.options.fallback.provider,
          model: this.options.fallback.model
        }
      });

      let fallbackAdapter: ImageAdapter;
      try {
        fallbackAdapter = this.resolveFallbackAdapter();
      } catch (fallbackError) {
        return this.failWithFallbackError(primary, fallbackError);
      }

      const refitted = await this.refitForFallback(request, fallbackAdapter, primary);

      try {
        const result = await fallbackAdapter.generateImage(refitted.request);
        const fallback = {
          provider: result.provider,
          model: result.model
        };
        await this.note({
          event: "fallback.success",
          primary,
          fallback: {
            provider: this.options.fallback.provider,
            model: this.options.fallback.model
          },
          result: fallback
        });
        return {
          ...result,
          fallback: fallbackMetadata(primary, fallback, refitted.references)
        };
      } catch (fallbackError) {
        return this.failWithFallbackError(primary, fallbackError);
      }
    }
  }

  /**
   * Cuts the reference attachment down to what the second adapter said it can
   * take, and says the prompt again for what is left.
   *
   * An adapter may not be handed a request it has already declared it cannot
   * serve. `AlibabaImageAdapter` refuses one outright — a plain `Error` reading
   * "cannot consume character reference images" — and a plain error is
   * definitively *not* a refusal: `isImageContentRefusalError` says no, the
   * copyright wrapper rethrows, and `renderCharacterReferenceSheets` treats it
   * as the outage it looks like and fails the whole GENERATE_BOOK job. A
   * healthy fallback that could have drawn the picture without references
   * would have failed the book instead — which inverts the rule the callers
   * are built on, that a picture that cannot be drawn *now* lets the book
   * finish.
   *
   * The trim is from the **tail**, which is the priority order
   * `selectReferenceImagePaths` already builds: the per-book character sheets
   * first, then the reader's own library artwork appended into whatever budget
   * the sheets left. So a squeezed render gives up the face before it gives up
   * a character's design, and a cast that fits the smaller budget keeps every
   * sheet.
   *
   * **The prompt is not a bystander to that cut.** It carries two indexed
   * claims about the very array being shortened — an explicit count ("use the
   * 5 attached character reference images") and a tail attribution ("the last
   * 2 reference images are the reader's own saved artwork for Ada and Bea …
   * match it exactly"). Sending three under a prompt written for five does not
   * drop two pictures, it hands the remaining three different identities: the
   * second and third character's *sheets* are named as the first two
   * characters' saved faces, to be matched exactly. A wrong face, drawn
   * silently, on the one path with no reference-image quality signal — worse
   * than the failed book this refit exists to prevent. So the caller's
   * `promptForReferenceImages` is asked for the sentence that fits what is
   * actually going out, and where a caller left none, **nothing** is attached
   * *and nothing is claimed*: a picture drawn from the text alone loses the
   * sheets, which is the loss this file already tolerates for a zero-reference
   * fallback, while a partial attachment under an unre-statable prompt is an
   * instruction to draw the wrong person.
   *
   * **The array and the text are cut by the same rule, because emptying only
   * the array applies it to half the request.** Zero sheets under "use the 5
   * attached … the last 2 are the reader's own saved artwork for Ada and Bea;
   * match it exactly" is not a picture drawn from the text alone; it is a
   * picture drawn from text describing pictures the model never received, and
   * the one path that reaches it in production is the one where the loss is
   * least visible — `CopyrightSafeRetryImageAdapter` deletes
   * `promptForReferenceImages` on its retry (rightly: the rewritten prompt is
   * the text model's words, and the caller's re-statement would replace the
   * rewrite and hand the protected name back to the filter), so any primary
   * failure on that second render arrives here with no restater. It cannot
   * carry one either — a restater for the *rewritten* prompt would take another
   * model call to produce — so what makes the deletion safe is this end:
   * {@link NO_REFERENCE_IMAGES_CORRECTION} is appended, which needs none of the
   * caller's words and is true of every prompt at once.
   *
   * **And the cut travels with the picture, not only with the run log.** It is
   * a fact about what the render was drawn from, and one caller has to speak
   * for that in a durable record: `CopyrightSafeRetryImageAdapter` writes
   * `copyrightRewrite.unverifiedReferenceImages` — the count of likeness inputs
   * nothing re-read — onto the asset row. That is also the caller whose deleted
   * `promptForReferenceImages` makes an unre-statable trim *reachable* in the
   * first place, so counting its own request there asserted five unread sheets
   * over a picture drawn from the rewritten text alone, and dropped the
   * `replaced` list in the one case that had earned it. Nothing above this
   * layer can see the cut, so it is returned beside the refitted request and
   * rides {@link ImageFallbackMetadata.references} out with the result.
   */
  private async refitForFallback(
    request: ImageRequest,
    fallbackAdapter: ImageAdapter,
    primary: ImageFallbackAttempt & { error: Record<string, unknown> }
  ): Promise<{ request: ImageRequest; references?: ImageFallbackReferenceTrim }> {
    const requestedPaths = request.referenceImagePaths ?? [];
    if (requestedPaths.length === 0) {
      return { request };
    }
    const capabilities = imageAdapterCapabilities(fallbackAdapter);
    const limit = capabilities.supportsReferenceImages ? Math.max(0, capabilities.maxReferenceImages) : 0;
    if (limit >= requestedPaths.length) {
      return { request };
    }
    const restate = request.promptForReferenceImages;
    const kept = restate ? requestedPaths.slice(0, limit) : [];
    const references: ImageFallbackReferenceTrim = {
      requested: requestedPaths.length,
      sent: kept.length,
      dropped: requestedPaths.length - kept.length,
      limit,
      restated: restate !== undefined
    };
    await this.note({
      event: "fallback.references_trimmed",
      primary,
      fallback: {
        provider: this.options.fallback.provider,
        model: this.options.fallback.model
      },
      references
    });
    const refitted: ImageRequest = {
      ...request,
      prompt: restate ? restate(kept) : withoutReferenceImageClaims(request.prompt)
    };
    if (kept.length > 0) {
      refitted.referenceImagePaths = kept;
    } else {
      delete refitted.referenceImagePaths;
    }
    return { request: refitted, references };
  }

  private resolveFallbackAdapter(): ImageAdapter {
    if (this.fallbackAdapter) {
      return this.fallbackAdapter;
    }
    const adapter =
      typeof this.options.fallback.adapter === "function" ? this.options.fallback.adapter() : this.options.fallback.adapter;
    this.fallbackAdapter = adapter;
    return adapter;
  }

  /**
   * Both providers are out of answers — unless the second one was *cancelled*,
   * which is not an answer about this picture at all.
   *
   * `ImageGenerationFallbackError` is a verdict with a very particular
   * downstream meaning: `isImageContentRefusalError` reads it as settled when
   * both serialized attempts are refusals, and `renderCharacterReferenceSheets`
   * writes a settled one onto `PlanVersion.characterReferenceRefusals`, where
   * nothing in the product ever revisits it. A reader who presses Stop while
   * the fallback is rendering hands that class a `StopRequestedError` for its
   * second half — and the wrapper is not a `StopRequestedError` to anyone: the
   * worker's `isStopRequestedError` is an `instanceof` test by design, and
   * `imageAdapterCapabilities`' neighbours downstream gate on that same
   * identity. So a stop lost its name here, and every consumer of this class
   * read what was left. `CopyrightSafeRetryImageAdapter` then found the wrapper
   * was neither a stop nor a refusal, handed back the *original* two-provider
   * refusal instead — for which `isImageContentRefusalError` **is** true — and
   * a cancelled run settled as a finished book whose character has no reference
   * sheet for the life of the plan version. `generateImage`'s handler would
   * have stamped `imageFailureReason` on the page, and `generateCover`'s would
   * have swapped in a designed cover, on the same reading.
   *
   * It is the rule `runToolLoop` holds one module over — a cancellation raised
   * inside a step escapes the step; only a *failure* becomes that step's
   * result — and the rule `note` below holds for the run-log write. It lives
   * here rather than in any one guard because the wrapping is what destroys the
   * identity, so every consumer of the class is fixed by the same line. The
   * predicate is `isCancellationError`, which reads identity rather than prose
   * and sees the worker's `StopRequestedError` across a package boundary it
   * cannot import.
   *
   * The run-log line is still written first: what the primary said is the only
   * record of a fallback that was reached at all, and losing it would trade one
   * silence for another.
   */
  private async failWithFallbackError(
    primary: ImageFallbackAttempt & { error: Record<string, unknown> },
    fallbackError: unknown
  ): Promise<never> {
    const fallback = {
      provider: this.options.fallback.provider,
      model: this.options.fallback.model,
      error: serializeFallbackError(fallbackError)
    };
    await this.note({
      event: "fallback.error",
      primary,
      fallback
    });
    if (isCancellationError(fallbackError)) {
      throw fallbackError;
    }
    throw new ImageGenerationFallbackError({ primary, fallback });
  }

  /**
   * Writes the fallback down, and cannot decide anything by failing to.
   *
   * `onEvent` is a run-log append — `image.generate.fallback.*` in
   * `providers/loggedAdapters.ts`, a file write under `BOOK_STORAGE_DIR` — and
   * every one of these four calls used to be awaited bare, in a position where
   * a rejection settled the render. Three of them sit outside the try around
   * `fallbackAdapter.generateImage`, so a throw travelled straight out of
   * `generateImage` as an ordinary `Error`: not an `ImageGenerationFallbackError`,
   * therefore not an `isImageContentRefusalError` to anyone downstream, so
   * `renderCharacterReferenceSheets` read a diagnostic write as an outage, set
   * `failed` and failed the whole GENERATE_BOOK job — where a refusal would have
   * been recorded and the book would have finished without that one sheet. The
   * fourth was worse for being inside it: a throw from `fallback.success` was
   * caught as the *fallback provider's* error, so a picture that had already
   * been drawn was thrown away and reported as both providers failing.
   *
   * A note about a picture cannot be allowed to decide the picture, so the
   * guard lives here rather than at the four call sites — the worker's own
   * `bestEffortPass` is the same rule one package over, and
   * `RunLogger.append` swallowing its own write failures is not it: this
   * adapter takes an arbitrary caller's callback, and a caller reads the
   * config, builds a path and serializes an error before it ever reaches that
   * swallow. What is lost when this fires is a run-log line, which is a real
   * loss and the smaller one by the same margin every other rule in this file
   * is written under. A cancellation still travels: a reader who ended the run
   * must not have it continue into a second render.
   */
  private async note(event: ImageFallbackEvent): Promise<void> {
    try {
      await this.options.onEvent?.(event);
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }
      console.warn("Image fallback event could not be recorded", { event: event.event, error });
    }
  }
}

/**
 * Answers the prompt's claims about an attachment that is now empty.
 *
 * Appended rather than edited, because nothing here knows which sentences the
 * caller wrote — see {@link NO_REFERENCE_IMAGES_CORRECTION}. A prompt that
 * claimed nothing loses nothing by carrying it: with no references attached the
 * correction is simply true.
 */
function withoutReferenceImageClaims(prompt: string): string {
  return `${prompt.trimEnd()}\n\n${NO_REFERENCE_IMAGES_CORRECTION}`;
}

export function serializeFallbackError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { value: error };
  }
  const extra = Object.fromEntries(Object.entries(error as Error & Record<string, unknown>));
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...extra
  };
}

function fallbackMetadata(
  primary: ImageFallbackAttempt & { error: Record<string, unknown> },
  fallback: ImageFallbackProvider,
  references: ImageFallbackReferenceTrim | undefined
): ImageFallbackMetadata {
  return {
    used: true,
    primary,
    fallback,
    ...(references ? { references } : {})
  };
}

function errorMessage(error: Record<string, unknown>): string {
  return typeof error.message === "string" && error.message.trim() ? error.message : "Unknown error.";
}
