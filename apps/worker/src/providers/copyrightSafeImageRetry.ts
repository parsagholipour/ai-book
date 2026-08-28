import {
  errorMessage,
  imageAdapterCapabilities,
  imageRefusalCategory,
  imageRefusalReason,
  isImageContentRefusalError,
  rewriteImagePromptForCopyright,
  type ImageAdapter,
  type ImageAdapterCapabilities,
  type ImageRequest,
  type ImageResult,
  type TextModelAdapter
} from "@book-maker/core";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { serializeError } from "../runtime/serialization.js";
import type { RunLogger } from "./runLogging.js";

/**
 * One second attempt at a picture an IP filter refused, drawn from a prompt
 * that names an original character instead of a protected one.
 *
 * It wraps the *outside* of the provider fallback deliberately: only a request
 * both providers refused has run out of other answers, and only then is a
 * rewritten prompt the last thing left to try. `imageRefusalCategory` is what
 * decides a refusal may be retried at all — a filter that objected to a name
 * has an honest answer, and one that objected to anything else does not.
 *
 * Exactly one retry, and no recursion: a rewritten prompt that is refused
 * again is the end of it. The rewrite may only remove protected names, so a
 * second refusal means the objection was never about the name, and asking a
 * third time would be paying to be told so.
 *
 * And it may only ever improve on the answer the caller already had. A refusal
 * is tolerated where an outage is fatal, so a second render that fails for
 * anything but a refusal hands the original refusal back rather than its own
 * error — otherwise attempting the rewrite is what fails the book.
 *
 * **What it rewrites is the prompt, so what it may claim is the prompt.** The
 * reference images travel unchanged, and on the character path they are exactly
 * where a protected likeness lives — a library character whose portrait is the
 * protected one, a `CHARACTER_REFERENCE` sheet drawn from it. The picture that
 * comes back is then drawn from a likeness the rewrite never touched, which is
 * why the record it installs stops naming the removed names on that path and
 * says so instead. `survivingReplacedNames` cannot see it: that check reads the
 * rewritten text, and this is the half of the render that is not text.
 *
 * **Which path a render took is measured off the render, never off the
 * request** — see {@link referenceImagesTheRenderRead}. A second attempt that
 * falls over to the other provider can be handed fewer sheets than it set out
 * with, or none, and the request cannot say so.
 */
export class CopyrightSafeRetryImageAdapter implements ImageAdapter {
  constructor(
    private readonly options: {
      image: ImageAdapter;
      text: TextModelAdapter;
      logger: RunLogger;
    }
  ) {}

  capabilities(): ImageAdapterCapabilities {
    return imageAdapterCapabilities(this.options.image);
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    try {
      return await this.options.image.generateImage(request);
    } catch (refusal) {
      // A reader who ended the run is owed nothing but the stop — it is not a
      // verdict about this prompt and there is no rewrite decision to record.
      if (isStopRequestedError(refusal)) {
        throw refusal;
      }
      if (imageRefusalCategory(refusal) !== "copyright") {
        // The gate used to short-circuit straight past every `append` below, so
        // the one decision that can silently cost a picture — the veto firing,
        // or a refusal carrying no IP evidence — was the only one the run log
        // never saw. That is how the whole feature stayed inert for the case it
        // was built for while looking exactly like a plain refused picture.
        // Written down before the rethrow, a suppressed rewrite is visible
        // beside `_declined` and `_failed` rather than being invisible.
        //
        // Only for a refusal, though. Anything else here is an outage that
        // never reached the gate as a verdict, `image.generate.error` already
        // has it, and calling it a rewrite decision would be inventing one.
        if (isImageContentRefusalError(refusal)) {
          await this.options.logger.append("image.generate.copyright_rewrite_not_offered", {
            refusalReason: imageRefusalReason(refusal),
            error: serializeError(refusal)
          });
        }
        throw refusal;
      }
      // Two different readings of one refusal: the code is what the asset row
      // records, and the message is what the model is shown — it names the
      // objection in words, which is what a rewrite has to answer.
      const refusalReason = imageRefusalReason(refusal);
      const rewrite = await rewriteImagePromptForCopyright({
        textModel: this.options.text,
        prompt: request.prompt,
        reason: errorMessage(refusal),
        // A reader who stopped the run must not have it continue into a
        // rewrite and a second image call.
        bailOnError: isStopRequestedError
      });
      if (rewrite.outcome !== "rewritten") {
        // Nothing to retry with. The refusal the caller already earned stands,
        // rather than being replaced by a failure to rewrite it — but the two
        // ways of getting here are different facts about this book, so they are
        // different lines. A decline is the model reading the prompt and
        // finding no protected name in it; a failure is a call that was paid
        // for and answered nothing, and the run log is where anyone would go
        // to tell a rewrite that never worked from one that was never needed.
        await this.options.logger.append(
          rewrite.outcome === "failed"
            ? "image.generate.copyright_rewrite_failed"
            : "image.generate.copyright_rewrite_declined",
          {
            refusalReason,
            ...(rewrite.outcome === "failed" ? { rewriteError: serializeError(rewrite.error) } : {}),
            error: serializeError(refusal)
          }
        );
        throw refusal;
      }

      // Everything but the prompt is carried over — the reference images
      // especially, since the sheets are what keep a rewritten character
      // looking like itself from one page to the next. The run log is where the
      // model's own `replaced` list and the sheets it *set out* with stay
      // legible together, because that is the half the row stops claiming.
      // What the render was actually handed is a different number, and it is
      // only knowable once the render has answered — see below.
      await this.options.logger.append("image.generate.copyright_rewrite", {
        refusalReason,
        replaced: rewrite.replaced,
        referenceImagePaths: request.referenceImagePaths ?? [],
        originalPrompt: request.prompt,
        rewrittenPrompt: rewrite.prompt
      });
      try {
        // The rewritten prompt is the text model's words, not the caller's, so
        // the caller's `promptForReferenceImages` no longer describes it: a
        // refit below that called it would replace the rewrite with the
        // original prompt and hand the protected name straight back to the
        // filter. Dropping it costs this second attempt any *partial*
        // attachment, since `refitForFallback` attaches nothing it cannot
        // state — the same trade this rewrite already makes about the
        // references, which are the half of the render it never read.
        const retryRequest: ImageRequest = { ...request, prompt: rewrite.prompt };
        delete retryRequest.promptForReferenceImages;
        const result = await this.options.image.generateImage(retryRequest);
        const unreadInputs = referenceImagesTheRenderRead(retryRequest, result);
        return {
          ...result,
          copyrightRewrite: {
            refusalReason,
            // The rewrite is one rewritten *prompt* and nothing else about the
            // request moves, so a render that was handed reference sheets was
            // drawn from a likeness nothing here has read. `replaced` is the
            // only IP-provenance record this product keeps, and a record that
            // overstates is worse than none — so on that path it claims
            // nothing and says, in `unverifiedReferenceImages`, what it could
            // not check. Dropping the sheets instead would buy the claim by
            // changing the request in a second, unstated way: the retry would
            // no longer be the "one rewritten prompt" whose narrowness is the
            // argument for making it automatically, a second refusal would stop
            // meaning "the objection was never about the name", and every page
            // salvaged this way would carry a character who matches no other
            // page in the book. The bytes are still worth having; only the
            // claim was never earned.
            replaced: unreadInputs > 0 ? [] : rewrite.replaced,
            ...(unreadInputs > 0 ? { unverifiedReferenceImages: unreadInputs } : {}),
            prompt: rewrite.prompt
          }
        };
      } catch (retryError) {
        // The retry may never leave the caller worse off than not retrying, and
        // an unwrapped second render did exactly that. A refusal both providers
        // gave is the one image failure the callers tolerate —
        // `renderCharacterReferenceSheets` records it and the book finishes
        // without that sheet — while anything else is fatal to `generate-book`.
        // So a rewritten render whose primary refused and whose fallback timed
        // out replaced a book missing one likeness with a FAILED project: the
        // rewrite made the outcome worse than never attempting it. The original
        // refusal is what the caller keeps instead, and the run log is the only
        // place a rewrite that was drawn from and answered nothing shows up.
        //
        // Two things still travel. A second *refusal* is the same kind of
        // settled answer and a stronger one — the objection was never about the
        // name — which is what the caller is owed. And a stop is nobody's to
        // swallow: a reader who ended the run must not have it continue.
        if (isStopRequestedError(retryError) || isImageContentRefusalError(retryError)) {
          throw retryError;
        }
        await this.options.logger.append("image.generate.copyright_rewrite_render_failed", {
          refusalReason,
          rewrittenPrompt: rewrite.prompt,
          renderError: serializeError(retryError),
          error: serializeError(refusal)
        });
        throw refusal;
      }
    }
  }
}

/**
 * How many reference images the render that produced these bytes was actually
 * handed — which is not always how many the retry sent it out with.
 *
 * The request is the wrong place to read this, and the difference is reachable
 * on exactly the path the provenance record exists for. The retry deletes
 * `promptForReferenceImages` (rightly: the rewritten prompt is the text model's
 * words, and re-stating the caller's would hand the protected name back to the
 * filter), so a rewritten render whose primary fails arrives at
 * `FallbackImageAdapter.refitForFallback` with no way to say a shorter
 * attachment again — and an unre-statable trim goes out with **none**. Reading
 * the request there wrote `unverifiedReferenceImages: 5` over a picture drawn
 * from the rewritten text alone, and dropped `replaced` in the one case where
 * `survivingReplacedNames` had fully verified it: a false record in both
 * directions at once, in the field whose whole rule is that a false one is
 * worse than none.
 *
 * `ImageFallbackMetadata.references` is the only account of that cut, because
 * the layer that made it is the only layer that saw it — `fallback` alone says
 * *who* drew the picture and nothing about what it read. Absent means the
 * attempt got what was asked for, so the request's own count stands.
 *
 * The residual error is one-directional and it is the safe direction. An
 * adapter that silently slices to its own model limit is over-counted here, so
 * the record claims *more* unread inputs than there were and `replaced` stays
 * narrowed — never the reverse, and it is the reverse that would claim a
 * removal over pixels nothing read. Neither adapter does slice in practice:
 * `capabilities().maxReferenceImages` is the same number each one cuts to, and
 * `refitForFallback` has already cut to it.
 */
function referenceImagesTheRenderRead(request: ImageRequest, result: ImageResult): number {
  const trimmed = result.fallback?.references;
  return trimmed ? trimmed.sent : (request.referenceImagePaths?.length ?? 0);
}
