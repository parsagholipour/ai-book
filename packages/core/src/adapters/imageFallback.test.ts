import { describe, expect, it, vi } from "vitest";
import { libraryCharacterFaceInstruction } from "../generation/libraryCharacters.js";
import {
  FallbackImageAdapter,
  ImageGenerationFallbackError,
  NO_REFERENCE_IMAGES_CORRECTION,
  type ImageFallbackEvent
} from "./imageFallback.js";
import type { ImageAdapter, ImageAdapterCapabilities, ImageRequest, ImageResult } from "./types.js";

/**
 * A page render's prompt, shaped like the one the worker actually sends: a
 * count of the attached references, and — through the real
 * `libraryCharacterFaceInstruction` — a tail attribution naming the reader's
 * own saved artwork. Both sentences are *indexed*, which is the whole reason
 * `promptForReferenceImages` exists.
 */
function pagePrompt(selection: { paths: string[]; libraryFaceNames: string[] }) {
  const firstFace = selection.paths.length - selection.libraryFaceNames.length;
  return (attached: readonly string[]): string => {
    const faces = selection.libraryFaceNames.filter((_name, index) =>
      attached.includes(selection.paths[firstFace + index] ?? "")
    );
    return [
      "paint the cover",
      attached.length > 0
        ? `Use the ${attached.length} attached character reference image${attached.length === 1 ? "" : "s"} as the authoritative design source.`
        : "",
      libraryCharacterFaceInstruction(faces)
    ]
      .filter(Boolean)
      .join(" ");
  };
}

describe("FallbackImageAdapter", () => {
  it("tries the fallback provider and preserves the primary error on success", async () => {
    const events: ImageFallbackEvent[] = [];
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "alibaba",
        model: "qwen-image-2.0",
        adapter: new FailingImageAdapter("Qwen unavailable")
      },
      fallback: {
        provider: "gemini",
        model: "gemini-2.5-flash-image",
        adapter: new StaticImageAdapter({
          provider: "gemini",
          model: "gemini-2.5-flash-image",
          mimeType: "image/png",
          data: Buffer.from("fallback")
        })
      },
      onEvent: (event) => {
        events.push(event);
      }
    });

    const result = await adapter.generateImage({ prompt: "paint a tiny house" });

    expect(result.provider).toBe("gemini");
    expect(result.fallback).toMatchObject({
      used: true,
      primary: {
        provider: "alibaba",
        model: "qwen-image-2.0",
        error: { message: "Qwen unavailable" }
      },
      fallback: {
        provider: "gemini",
        model: "gemini-2.5-flash-image"
      }
    });
    expect(events.map((event) => event.event)).toEqual(["fallback.start", "fallback.success"]);
  });

  it("throws a combined error when the fallback provider also fails", async () => {
    const events: ImageFallbackEvent[] = [];
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-2.5-flash-image",
        adapter: new FailingImageAdapter("Gemini unavailable")
      },
      fallback: {
        provider: "alibaba",
        model: "qwen-image-2.0",
        adapter: new FailingImageAdapter("Qwen unavailable")
      },
      onEvent: (event) => {
        events.push(event);
      }
    });

    await expect(adapter.generateImage({ prompt: "paint a tiny house" })).rejects.toMatchObject({
      name: "ImageGenerationFallbackError",
      primary: {
        provider: "gemini",
        model: "gemini-2.5-flash-image",
        error: { message: "Gemini unavailable" }
      },
      fallback: {
        provider: "alibaba",
        model: "qwen-image-2.0",
        error: { message: "Qwen unavailable" }
      }
    } satisfies Partial<ImageGenerationFallbackError>);
    expect(events.map((event) => event.event)).toEqual(["fallback.start", "fallback.error"]);
  });

  it("re-fits a reference-image request the fallback model cannot serve at all", async () => {
    const events: ImageFallbackEvent[] = [];
    const fallbackAdapter = new ReferenceAwareImageAdapter(
      { supportsReferenceImages: false, maxReferenceImages: 0 },
      { provider: "alibaba", model: "qwen-image-max", mimeType: "image/png", data: Buffer.from("fallback") }
    );
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-2.5-flash-image",
        adapter: new FailingImageAdapter("Gemini unavailable")
      },
      fallback: {
        provider: "alibaba",
        model: "qwen-image-max",
        adapter: fallbackAdapter
      },
      onEvent: (event) => {
        events.push(event);
      }
    });

    const result = await adapter.generateImage({
      prompt: "paint a tiny house",
      referenceImagePaths: ["/sheets/ada.png", "/sheets/bea.png", "/sheets/cal.png"]
    });

    expect(result.provider).toBe("alibaba");
    expect(fallbackAdapter.requests[0]?.referenceImagePaths).toBeUndefined();
    expect(fallbackAdapter.requests[0]?.prompt).toContain("paint a tiny house");
    // The retraction rides every unre-statable trim, including one whose prompt
    // happens to claim nothing: which sentences a caller wrote is the one thing
    // this layer cannot read, so the alternative is a guess that is wrong
    // exactly where it matters.
    expect(fallbackAdapter.requests[0]?.prompt).toContain(NO_REFERENCE_IMAGES_CORRECTION);
    expect(events.map((event) => event.event)).toEqual([
      "fallback.start",
      "fallback.references_trimmed",
      "fallback.success"
    ]);
    expect(events[1]).toMatchObject({
      event: "fallback.references_trimmed",
      fallback: { provider: "alibaba", model: "qwen-image-max" },
      references: { requested: 3, sent: 0, dropped: 3, limit: 0, restated: false }
    });
  });

  it("re-states the count claim when it can only send part of the attachment", async () => {
    const events: ImageFallbackEvent[] = [];
    const fallbackAdapter = new ReferenceAwareImageAdapter(
      { supportsReferenceImages: true, maxReferenceImages: 3 },
      { provider: "alibaba", model: "qwen-image-2.0-pro", mimeType: "image/png", data: Buffer.from("fallback") }
    );
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-3-pro-image",
        adapter: new FailingImageAdapter("Gemini unavailable")
      },
      fallback: {
        provider: "alibaba",
        model: "qwen-image-2.0-pro",
        adapter: fallbackAdapter
      },
      onEvent: (event) => {
        events.push(event);
      }
    });
    const selection = {
      paths: ["/sheets/ada.png", "/sheets/bea.png", "/sheets/cid.png", "/faces/ada.png", "/faces/bea.png"],
      libraryFaceNames: ["Ada", "Bea"]
    };

    const result = await adapter.generateImage({
      prompt: pagePrompt(selection)(selection.paths),
      referenceImagePaths: selection.paths,
      promptForReferenceImages: pagePrompt(selection)
    });

    expect(result.provider).toBe("alibaba");
    const sent = fallbackAdapter.requests[0];
    expect(sent?.referenceImagePaths).toEqual(["/sheets/ada.png", "/sheets/bea.png", "/sheets/cid.png"]);
    // The claim counts what went out, not what the primary was sized for.
    expect(sent?.prompt).toContain("Use the 3 attached character reference images");
    expect(sent?.prompt).not.toContain("Use the 5 attached");
    // Both faces were left behind, so the tail attribution goes with them
    // rather than re-pointing at Bea's and Cid's *sheets*.
    expect(sent?.prompt).not.toContain("saved artwork");
    expect(sent?.prompt).not.toContain("Ada");
    expect(sent?.prompt).not.toContain("Bea");
    expect(events.map((event) => event.event)).toEqual([
      "fallback.start",
      "fallback.references_trimmed",
      "fallback.success"
    ]);
    expect(events[1]).toMatchObject({
      event: "fallback.references_trimmed",
      references: { requested: 5, sent: 3, dropped: 2, limit: 3, restated: true }
    });
  });

  it("re-points the tail attribution at the faces that are still attached", async () => {
    const fallbackAdapter = new ReferenceAwareImageAdapter(
      { supportsReferenceImages: true, maxReferenceImages: 3 },
      { provider: "alibaba", model: "qwen-image-2.0-pro", mimeType: "image/png", data: Buffer.from("fallback") }
    );
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-3-pro-image",
        adapter: new FailingImageAdapter("Gemini unavailable")
      },
      fallback: { provider: "alibaba", model: "qwen-image-2.0-pro", adapter: fallbackAdapter }
    });
    // Two sheets and two faces: the cut takes one face and leaves the other.
    const selection = {
      paths: ["/sheets/ada.png", "/sheets/bea.png", "/faces/ada.png", "/faces/bea.png"],
      libraryFaceNames: ["Ada", "Bea"]
    };

    await adapter.generateImage({
      prompt: pagePrompt(selection)(selection.paths),
      referenceImagePaths: selection.paths,
      promptForReferenceImages: pagePrompt(selection)
    });

    const sent = fallbackAdapter.requests[0];
    expect(sent?.referenceImagePaths).toEqual(["/sheets/ada.png", "/sheets/bea.png", "/faces/ada.png"]);
    expect(sent?.prompt).toContain("Use the 3 attached character reference images");
    expect(sent?.prompt).toContain("The last reference image is the reader's own saved artwork for Ada.");
    // Bea's face never went out, so nothing may be offered as Bea's.
    expect(sent?.prompt).not.toContain("Bea");
  });

  it("draws the picture with no references at all rather than failing the book", async () => {
    const events: ImageFallbackEvent[] = [];
    const fallbackAdapter = new ReferenceAwareImageAdapter(
      { supportsReferenceImages: false, maxReferenceImages: 0 },
      { provider: "alibaba", model: "qwen-image-max", mimeType: "image/png", data: Buffer.from("fallback") }
    );
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-3-pro-image",
        adapter: new FailingImageAdapter("Gemini unavailable")
      },
      fallback: { provider: "alibaba", model: "qwen-image-max", adapter: fallbackAdapter },
      onEvent: (event) => {
        events.push(event);
      }
    });
    const selection = {
      paths: ["/sheets/ada.png", "/sheets/bea.png", "/faces/ada.png"],
      libraryFaceNames: ["Ada"]
    };

    const result = await adapter.generateImage({
      prompt: pagePrompt(selection)(selection.paths),
      referenceImagePaths: selection.paths,
      promptForReferenceImages: pagePrompt(selection)
    });

    expect(result.provider).toBe("alibaba");
    const sent = fallbackAdapter.requests[0];
    expect(sent?.referenceImagePaths).toBeUndefined();
    // Nothing is attached, so nothing may be claimed about an attachment.
    expect(sent?.prompt).toBe("paint the cover");
    expect(events[1]).toMatchObject({
      event: "fallback.references_trimmed",
      references: { requested: 3, sent: 0, dropped: 3, limit: 0, restated: true }
    });
  });

  it("attaches nothing at all when the caller left no way to re-state the prompt", async () => {
    const events: ImageFallbackEvent[] = [];
    const fallbackAdapter = new ReferenceAwareImageAdapter(
      { supportsReferenceImages: true, maxReferenceImages: 3 },
      { provider: "alibaba", model: "qwen-image-2.0-pro", mimeType: "image/png", data: Buffer.from("fallback") }
    );
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-3-pro-image",
        adapter: new FailingImageAdapter("Gemini unavailable")
      },
      fallback: { provider: "alibaba", model: "qwen-image-2.0-pro", adapter: fallbackAdapter },
      onEvent: (event) => {
        events.push(event);
      }
    });

    // A prompt that may say anything about five pictures, and no way to say it
    // again for three: three pictures under it are three wrong identities, so
    // the render goes out with none.
    //
    // This is the shape `CopyrightSafeRetryImageAdapter` sends — it deletes
    // `promptForReferenceImages` so the caller's re-statement cannot replace the
    // rewrite, and any primary failure on that second render lands here.
    const stalePrompt =
      "paint the cover. Use the 5 attached character reference images as the authoritative design source. " +
      "The last 2 reference images are the reader's own saved artwork for Ada and Bea; match it exactly.";
    await adapter.generateImage({
      prompt: stalePrompt,
      referenceImagePaths: ["/sheets/a.png", "/sheets/b.png", "/sheets/c.png", "/faces/a.png", "/faces/b.png"]
    });

    const sent = fallbackAdapter.requests[0];
    expect(sent?.referenceImagePaths).toBeUndefined();
    // Emptying the array is only half of it. The prompt's claims are *about*
    // that array, so left standing over nothing they tell the render to match,
    // exactly, a saved face it was never given. Nothing here can re-state a
    // sentence it did not write, but with the attachment empty it can retract
    // every one of them at once — which is what the caller's own restater does
    // on the path above, and what is missing on this one.
    expect(sent?.prompt).not.toBe(stalePrompt);
    expect(sent?.prompt).toContain(NO_REFERENCE_IMAGES_CORRECTION);
    expect(sent?.prompt).toContain("no reference images are attached");
    expect(events[1]).toMatchObject({
      event: "fallback.references_trimmed",
      references: { requested: 5, sent: 0, dropped: 5, limit: 3, restated: false }
    });
  });

  it("says nothing about an attachment the caller re-stated to nothing", async () => {
    const fallbackAdapter = new ReferenceAwareImageAdapter(
      { supportsReferenceImages: false, maxReferenceImages: 0 },
      { provider: "alibaba", model: "qwen-image-max", mimeType: "image/png", data: Buffer.from("fallback") }
    );
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-3-pro-image",
        adapter: new FailingImageAdapter("Gemini unavailable")
      },
      fallback: { provider: "alibaba", model: "qwen-image-max", adapter: fallbackAdapter }
    });
    const selection = { paths: ["/sheets/ada.png", "/faces/ada.png"], libraryFaceNames: ["Ada"] };

    await adapter.generateImage({
      prompt: pagePrompt(selection)(selection.paths),
      referenceImagePaths: selection.paths,
      promptForReferenceImages: pagePrompt(selection)
    });

    // The correction answers claims; a caller that already wrote its prompt for
    // an empty attachment made none, so it would only be noise.
    expect(fallbackAdapter.requests[0]?.prompt).toBe("paint the cover");
  });

  it("hands the fallback the request unchanged when it can take every reference", async () => {
    const events: ImageFallbackEvent[] = [];
    const fallbackAdapter = new ReferenceAwareImageAdapter(
      { supportsReferenceImages: true, maxReferenceImages: 4 },
      { provider: "alibaba", model: "qwen-image-2.0", mimeType: "image/png", data: Buffer.from("fallback") }
    );
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-2.5-flash-image",
        adapter: new FailingImageAdapter("Gemini unavailable")
      },
      fallback: { provider: "alibaba", model: "qwen-image-2.0", adapter: fallbackAdapter },
      onEvent: (event) => {
        events.push(event);
      }
    });

    await adapter.generateImage({ prompt: "paint a tiny house", referenceImagePaths: ["/sheets/a.png"] });

    expect(fallbackAdapter.requests).toEqual([
      { prompt: "paint a tiny house", referenceImagePaths: ["/sheets/a.png"] }
    ]);
    expect(events.map((event) => event.event)).toEqual(["fallback.start", "fallback.success"]);
  });

  it("keeps reporting the primary's reference budget, because the primary is what runs", () => {
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-3-pro-image",
        adapter: new ReferenceAwareImageAdapter(
          { supportsReferenceImages: true, maxReferenceImages: 5 },
          { provider: "gemini", model: "gemini-3-pro-image", mimeType: "image/png" }
        )
      },
      fallback: {
        provider: "alibaba",
        model: "qwen-image-max",
        adapter: new ReferenceAwareImageAdapter(
          { supportsReferenceImages: false, maxReferenceImages: 0 },
          { provider: "alibaba", model: "qwen-image-max", mimeType: "image/png" }
        )
      }
    });

    expect(adapter.capabilities()).toEqual({ supportsReferenceImages: true, maxReferenceImages: 5 });
  });

  it("uses its record-based fallback for empty serialized messages", async () => {
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-2.5-flash-image",
        adapter: new FailingImageAdapter("")
      },
      fallback: {
        provider: "alibaba",
        model: "qwen-image-2.0",
        adapter: new FailingImageAdapter("")
      }
    });

    await expect(adapter.generateImage({ prompt: "paint a tiny house" })).rejects.toThrow(
      "Primary error: Unknown error. Fallback error: Unknown error."
    );
  });

  it("does not let a run-log write that fails decide the render", async () => {
    // `onEvent` is a file append under `BOOK_STORAGE_DIR`. Three of the four
    // emissions sit *outside* the try around the fallback render, so a rejection
    // travelled straight out of `generateImage` as a plain `Error` — not an
    // `ImageGenerationFallbackError`, therefore not a refusal to anyone
    // downstream, so `renderCharacterReferenceSheets` read a diagnostic write as
    // an outage and failed the whole GENERATE_BOOK job.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const failing of ["fallback.start", "fallback.references_trimmed", "fallback.success"] as const) {
        const fallbackAdapter = new ReferenceAwareImageAdapter(
          { supportsReferenceImages: true, maxReferenceImages: 3 },
          { provider: "alibaba", model: "qwen-image-2.0-pro", mimeType: "image/png", data: Buffer.from("fallback") }
        );
        const adapter = new FallbackImageAdapter({
          primary: {
            provider: "gemini",
            model: "gemini-3-pro-image",
            adapter: new FailingImageAdapter("Gemini unavailable")
          },
          fallback: { provider: "alibaba", model: "qwen-image-2.0-pro", adapter: fallbackAdapter },
          onEvent: (event) => {
            if (event.event === failing) {
              throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
            }
          }
        });

        const result = await adapter.generateImage({
          prompt: "paint the cover. Use the 5 attached character reference images.",
          referenceImagePaths: ["/sheets/a.png", "/sheets/b.png", "/sheets/c.png", "/faces/a.png", "/faces/b.png"],
          promptForReferenceImages: (attached) => `paint the cover. Use the ${attached.length} attached.`
        });

        // The picture was drawn, and a lost log line is the whole of the loss.
        expect(result.provider, `${failing} decided the render`).toBe("alibaba");
        expect(fallbackAdapter.requests).toHaveLength(1);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the combined error when the run log cannot record the failure", async () => {
    // The fourth emission. A throw here replaced `ImageGenerationFallbackError`
    // with the write's own error, and that class is what `isImageContentRefusalError`
    // reads both attempts out of — so a failed append turned two refusals into
    // an outage, on the one path where a refusal is tolerated and an outage is not.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const adapter = new FallbackImageAdapter({
        primary: {
          provider: "gemini",
          model: "gemini-2.5-flash-image",
          adapter: new FailingImageAdapter("Gemini refused")
        },
        fallback: {
          provider: "alibaba",
          model: "qwen-image-2.0",
          adapter: new FailingImageAdapter("Qwen refused")
        },
        onEvent: (event) => {
          if (event.event === "fallback.error") {
            throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
          }
        }
      });

      await expect(adapter.generateImage({ prompt: "paint a tiny house" })).rejects.toMatchObject({
        name: "ImageGenerationFallbackError",
        primary: { error: { message: "Gemini refused" } },
        fallback: { error: { message: "Qwen refused" } }
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("still lets a stop travel out of the run-log write", async () => {
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-2.5-flash-image",
        adapter: new FailingImageAdapter("Gemini unavailable")
      },
      fallback: {
        provider: "alibaba",
        model: "qwen-image-2.0",
        adapter: new StaticImageAdapter({
          provider: "alibaba",
          model: "qwen-image-2.0",
          mimeType: "image/png",
          data: Buffer.from("fallback")
        })
      },
      onEvent: () => {
        // A reader who ended the run must not have it continue into a second
        // render, so this one error is not swallowed with the rest.
        throw Object.assign(new Error("Generation stopped by the reader"), { name: "StopRequestedError" });
      }
    });

    await expect(adapter.generateImage({ prompt: "paint a tiny house" })).rejects.toThrow(
      "Generation stopped by the reader"
    );
  });

  it("hands back the fallback attempt's cancellation rather than wrapping it as a two-provider failure", async () => {
    // The reader presses Stop while the second provider is rendering, so
    // `LoggingImageAdapter.assertJobNotStopped` raises a `StopRequestedError`
    // out of the fallback attempt. Wrapped, it stopped being a stop to
    // everyone: the worker's `isStopRequestedError` is an `instanceof` test, and
    // `isImageContentRefusalError` says no because the stop half is not a
    // refusal. `CopyrightSafeRetryImageAdapter` found neither guard matched,
    // handed back the *original* two-provider refusal — for which
    // `isImageContentRefusalError` is true — and
    // `renderCharacterReferenceSheets` wrote that onto
    // `PlanVersion.characterReferenceRefusals`, so a cancelled run settled as a
    // finished book whose character has no sheet for the life of the plan.
    const events: ImageFallbackEvent[] = [];
    const stop = Object.assign(new Error("Generation stopped by the reader"), { name: "StopRequestedError" });
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-2.5-flash-image",
        adapter: new FailingImageAdapter("Gemini refused")
      },
      fallback: {
        provider: "alibaba",
        model: "qwen-image-2.0",
        adapter: new ThrowingImageAdapter(stop)
      },
      onEvent: (event) => {
        events.push(event);
      }
    });

    const thrown = await adapter.generateImage({ prompt: "paint a tiny house" }).catch((error: unknown) => error);

    // The identity survives, which is the whole of the fix: every downstream
    // guard reads it off the error rather than out of prose.
    expect(thrown).toBe(stop);
    expect(thrown).not.toBeInstanceOf(ImageGenerationFallbackError);
    // What the primary said is still written down — a note about a picture may
    // not decide the picture, in either direction.
    expect(events.filter((event) => event.event === "fallback.error")).toMatchObject([
      { primary: { error: { message: "Gemini refused" } }, fallback: { error: { name: "StopRequestedError" } } }
    ]);
  });

  it("still wraps an ordinary fallback failure, cancellation-shaped prose included", async () => {
    // `isCancellationError` reads identity, never prose. A provider whose
    // message merely says the request was aborted is an outage that both
    // providers have now answered, and the wrapper is what tells the callers so.
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-2.5-flash-image",
        adapter: new FailingImageAdapter("Gemini refused")
      },
      fallback: {
        provider: "alibaba",
        model: "qwen-image-2.0",
        adapter: new FailingImageAdapter("request aborted by the upstream proxy")
      }
    });

    await expect(adapter.generateImage({ prompt: "paint a tiny house" })).rejects.toBeInstanceOf(
      ImageGenerationFallbackError
    );
  });

  it("reports the trim on the result, because the request no longer says what the render read", async () => {
    // The count a caller can read off its own request is the count it sent out,
    // and after an unre-statable trim that is not the count the render was
    // handed. `CopyrightSafeRetryImageAdapter` has to speak for the second in a
    // durable IP-provenance record, and nothing above this layer saw the cut.
    const fallbackAdapter = new ReferenceAwareImageAdapter(
      { supportsReferenceImages: false, maxReferenceImages: 0 },
      { provider: "alibaba", model: "qwen-image", mimeType: "image/png", data: Buffer.from("fallback") }
    );
    const adapter = new FallbackImageAdapter({
      primary: {
        provider: "gemini",
        model: "gemini-3-pro-image",
        adapter: new FailingImageAdapter("Gemini refused")
      },
      fallback: { provider: "alibaba", model: "qwen-image", adapter: fallbackAdapter }
    });

    const trimmed = await adapter.generateImage({
      prompt: "paint the cover",
      referenceImagePaths: ["/sheets/ada.png", "/sheets/bea.png"]
    });

    expect(trimmed.fallback?.references).toEqual({
      requested: 2,
      sent: 0,
      dropped: 2,
      limit: 0,
      restated: false
    });

    // And absent means "the attempt got what was asked for", so a caller that
    // reads it cannot mistake an untrimmed fallback for an emptied one.
    const untrimmed = await adapter.generateImage({ prompt: "paint the cover" });
    expect(untrimmed.fallback?.references).toBeUndefined();
  });
});

class ReferenceAwareImageAdapter implements ImageAdapter {
  readonly requests: Array<{ prompt: string; referenceImagePaths: string[] | undefined }> = [];

  constructor(
    private readonly declared: ImageAdapterCapabilities,
    private readonly result: ImageResult
  ) {}

  capabilities(): ImageAdapterCapabilities {
    return this.declared;
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    // Mirrors `AlibabaImageAdapter.generateImage`: a model that declared it
    // cannot take references refuses the request outright rather than ignoring
    // the extra images, and the throw is a plain `Error`.
    if (request.referenceImagePaths?.length && !this.declared.supportsReferenceImages) {
      throw new Error(`Qwen image model ${this.result.model} cannot consume character reference images.`);
    }
    this.requests.push({ prompt: request.prompt, referenceImagePaths: request.referenceImagePaths });
    return this.result;
  }
}

class StaticImageAdapter implements ImageAdapter {
  constructor(private readonly result: ImageResult) {}

  async generateImage(_request: ImageRequest): Promise<ImageResult> {
    return this.result;
  }
}

class FailingImageAdapter implements ImageAdapter {
  constructor(private readonly message: string) {}

  async generateImage(_request: ImageRequest): Promise<ImageResult> {
    throw new Error(this.message);
  }
}

class ThrowingImageAdapter implements ImageAdapter {
  constructor(private readonly error: unknown) {}

  async generateImage(_request: ImageRequest): Promise<ImageResult> {
    throw this.error;
  }
}
