import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rewriteImagePromptForCopyright: vi.fn(),
  append: vi.fn()
}));

vi.mock("@book-maker/core", () => ({
  rewriteImagePromptForCopyright: mocks.rewriteImagePromptForCopyright,
  // The real classifier is tested in packages/core; this seam only needs the
  // one distinction the adapter turns on.
  imageRefusalCategory: (error: unknown) =>
    (error as Record<string, unknown>)?.category === "copyright" ? "copyright" : "other",
  imageRefusalReason: (error: unknown) => String((error as Record<string, unknown>)?.reason ?? "refused"),
  // Same seam, other half: a fixture carrying a provider category is one both
  // providers answered with a filter, and a bare Error is an outage.
  isImageContentRefusalError: (error: unknown) => typeof (error as Record<string, unknown>)?.category === "string",
  // The undeclared-adapter default is core's own; this suite only asks that the
  // wrapper forwards the delegate's answer rather than inventing one.
  imageAdapterCapabilities: (image: { capabilities: () => unknown }) => image.capabilities(),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
}));
vi.mock("../runtime/jobTypes.js", () => ({
  isStopRequestedError: (error: unknown) => (error as Error)?.name === "StopRequestedError"
}));
vi.mock("../runtime/serialization.js", () => ({ serializeError: (error: unknown) => ({ message: String(error) }) }));

import type { ImageAdapter } from "@book-maker/core";
import { CopyrightSafeRetryImageAdapter } from "./copyrightSafeImageRetry.js";

const copyrightRefusal = () => Object.assign(new Error("both providers refused"), { category: "copyright", reason: "IMAGE_RECITATION" });
const otherRefusal = () => Object.assign(new Error("blocked"), { category: "other", reason: "IMAGE_SAFETY" });

const drawing = { provider: "gemini", model: "gemini-2.5-flash-image", mimeType: "image/png", data: Buffer.from("art") };

const adapterOver = (generateImage: ReturnType<typeof vi.fn>) =>
  new CopyrightSafeRetryImageAdapter({
    image: {
      generateImage: generateImage as unknown as ImageAdapter["generateImage"],
      capabilities: () => ({ supportsReferenceImages: true, maxReferenceImages: 3 })
    },
    text: {} as never,
    logger: { append: mocks.append } as never
  });

describe("CopyrightSafeRetryImageAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.append.mockResolvedValue(undefined);
  });

  it("draws from a rewritten prompt and records what was replaced", async () => {
    mocks.rewriteImagePromptForCopyright.mockResolvedValue({
      outcome: "rewritten",
      prompt: "A young masked hero in a red-and-blue suit on a rooftop.",
      replaced: ["Spider-Man"]
    });
    const generateImage = vi.fn().mockRejectedValueOnce(copyrightRefusal()).mockResolvedValueOnce(drawing);

    const result = await adapterOver(generateImage).generateImage({
      prompt: "Spider-Man on a rooftop.",
      referenceImagePaths: ["/images/sheet.png"],
      aspectRatio: "4:3"
    });

    expect(generateImage).toHaveBeenCalledTimes(2);
    // Everything but the prompt is carried over — the sheets especially, since
    // they are what keep a rewritten character looking like itself per page.
    expect(generateImage.mock.calls[1]?.[0]).toEqual({
      prompt: "A young masked hero in a red-and-blue suit on a rooftop.",
      referenceImagePaths: ["/images/sheet.png"],
      aspectRatio: "4:3"
    });
    // The model is shown what the providers said; the row records the code.
    expect(mocks.rewriteImagePromptForCopyright.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Spider-Man on a rooftop.",
      reason: "both providers refused"
    });
    // And the record claims only what was checked. This used to say
    // `replaced: ["Spider-Man"]` over a render whose one visual input was a
    // sheet nothing had read — see the case below.
    expect(result.copyrightRewrite).toEqual({
      refusalReason: "IMAGE_RECITATION",
      replaced: [],
      unverifiedReferenceImages: 1,
      prompt: "A young masked hero in a red-and-blue suit on a rooftop."
    });
  });

  it("claims the removal outright when nothing but the rewritten text fed the render", async () => {
    mocks.rewriteImagePromptForCopyright.mockResolvedValue({
      outcome: "rewritten",
      prompt: "A young masked hero in a red-and-blue suit on a rooftop.",
      replaced: ["Spider-Man"]
    });
    const generateImage = vi.fn().mockRejectedValueOnce(copyrightRefusal()).mockResolvedValueOnce(drawing);

    const result = await adapterOver(generateImage).generateImage({ prompt: "Spider-Man on a rooftop." });

    // `survivingReplacedNames` re-read the rewritten prompt and found none of
    // these in it, and the prompt is the whole of what was drawn from — so the
    // claim is the check's, and it stands unqualified.
    expect(result.copyrightRewrite).toEqual({
      refusalReason: "IMAGE_RECITATION",
      replaced: ["Spider-Man"],
      prompt: "A young masked hero in a red-and-blue suit on a rooftop."
    });
    expect(result.copyrightRewrite).not.toHaveProperty("unverifiedReferenceImages");
  });

  it("stops claiming a removal it could not check, and leaves the check in the run log", async () => {
    // The rewrite is one rewritten *prompt*: the reference images travel
    // unchanged, and on the character path they are exactly where a protected
    // likeness lives — a library character whose portrait is the protected one,
    // a CHARACTER_REFERENCE sheet drawn from it. The second provider can then
    // draw the likeness out of the pixels with generic text beside it, and the
    // row said "Spider-Man removed" over it. `survivingReplacedNames` cannot
    // see that: it reads the rewritten text, and this is the half of the render
    // that is not text. So `replaced` narrows to nothing and the row says how
    // many inputs it could not speak for; the model's own list and the sheets
    // it travelled with stay together in the run log, which is where anyone
    // reconstructing the claim would go.
    mocks.rewriteImagePromptForCopyright.mockResolvedValue({
      outcome: "rewritten",
      prompt: "A young masked hero in a red-and-blue suit on a rooftop.",
      replaced: ["Spider-Man"]
    });
    const generateImage = vi.fn().mockRejectedValueOnce(copyrightRefusal()).mockResolvedValueOnce(drawing);

    const result = await adapterOver(generateImage).generateImage({
      prompt: "Spider-Man on a rooftop.",
      referenceImagePaths: ["/images/spider-man-portrait.png", "/images/sheet.png"]
    });

    expect(result.copyrightRewrite).toMatchObject({ replaced: [], unverifiedReferenceImages: 2 });
    expect(mocks.append).toHaveBeenCalledWith("image.generate.copyright_rewrite", {
      refusalReason: "IMAGE_RECITATION",
      replaced: ["Spider-Man"],
      referenceImagePaths: ["/images/spider-man-portrait.png", "/images/sheet.png"],
      originalPrompt: "Spider-Man on a rooftop.",
      rewrittenPrompt: "A young masked hero in a red-and-blue suit on a rooftop."
    });
    // The sheets are still sent: dropping them would buy the claim by changing
    // the request a second, unstated way, and hand back a page whose character
    // matches no other page in the book.
    expect(generateImage.mock.calls[1]?.[0]).toMatchObject({
      referenceImagePaths: ["/images/spider-man-portrait.png", "/images/sheet.png"]
    });
  });

  it("claims the removal when the render the fallback ran was handed no sheets after all", async () => {
    // The retry deletes `promptForReferenceImages`, so a rewritten render whose
    // primary fails reaches `refitForFallback` with no way to state a shorter
    // attachment — and an unre-statable trim goes out with **none**. The
    // picture is then drawn from the rewritten text alone, which is exactly
    // where `survivingReplacedNames` has fully verified the claim. Counting the
    // request instead stored `replaced: []` beside `unverifiedReferenceImages:
    // 5`: five unread likeness inputs asserted over a render that had none, and
    // the `replaced` list dropped in the one case that earned it — both halves
    // false, in opposite directions, in the only IP-provenance record this
    // product keeps.
    mocks.rewriteImagePromptForCopyright.mockResolvedValue({
      outcome: "rewritten",
      prompt: "A young masked hero in a red-and-blue suit on a rooftop.",
      replaced: ["Spider-Man"]
    });
    const generateImage = vi
      .fn()
      .mockRejectedValueOnce(copyrightRefusal())
      .mockResolvedValueOnce({
        ...drawing,
        provider: "alibaba",
        model: "qwen-image",
        // What `FallbackImageAdapter` reports about the cut it made. Nothing
        // else can see it: `fallback` alone says who drew the picture.
        fallback: {
          used: true,
          primary: { provider: "gemini", model: "gemini-3-pro-image", error: { message: "refused" } },
          fallback: { provider: "alibaba", model: "qwen-image" },
          references: { requested: 5, sent: 0, dropped: 5, limit: 0, restated: false }
        }
      });

    const result = await adapterOver(generateImage).generateImage({
      prompt: "Spider-Man on a rooftop.",
      referenceImagePaths: ["/a.png", "/b.png", "/c.png", "/d.png", "/e.png"]
    });

    expect(result.copyrightRewrite).toEqual({
      refusalReason: "IMAGE_RECITATION",
      replaced: ["Spider-Man"],
      prompt: "A young masked hero in a red-and-blue suit on a rooftop."
    });
    expect(result.copyrightRewrite).not.toHaveProperty("unverifiedReferenceImages");
    // The run log still keeps what the retry *set out* with, which is the half
    // the row no longer speaks for.
    expect(mocks.append).toHaveBeenCalledWith(
      "image.generate.copyright_rewrite",
      expect.objectContaining({ referenceImagePaths: ["/a.png", "/b.png", "/c.png", "/d.png", "/e.png"] })
    );
  });

  it("counts what a partly trimmed fallback render actually read", async () => {
    mocks.rewriteImagePromptForCopyright.mockResolvedValue({
      outcome: "rewritten",
      prompt: "an original hero",
      replaced: ["Spider-Man"]
    });
    const generateImage = vi
      .fn()
      .mockRejectedValueOnce(copyrightRefusal())
      .mockResolvedValueOnce({
        ...drawing,
        fallback: {
          used: true,
          primary: { provider: "gemini", model: "gemini-3-pro-image", error: { message: "refused" } },
          fallback: { provider: "alibaba", model: "qwen-image-2.0-pro" },
          references: { requested: 5, sent: 3, dropped: 2, limit: 3, restated: true }
        }
      });

    const result = await adapterOver(generateImage).generateImage({
      prompt: "Spider-Man on a rooftop.",
      referenceImagePaths: ["/a.png", "/b.png", "/c.png", "/d.png", "/e.png"]
    });

    // Three sheets were read and nothing re-read them, so the claim stays
    // narrowed and the count is the render's rather than the request's.
    expect(result.copyrightRewrite).toMatchObject({ replaced: [], unverifiedReferenceImages: 3 });
  });

  it("tries exactly once, so a rewritten prompt refused again is the end of it", async () => {
    mocks.rewriteImagePromptForCopyright.mockResolvedValue({
      outcome: "rewritten",
      prompt: "an original hero",
      replaced: ["Spider-Man"]
    });
    const second = copyrightRefusal();
    const generateImage = vi.fn().mockRejectedValueOnce(copyrightRefusal()).mockRejectedValueOnce(second);

    await expect(adapterOver(generateImage).generateImage({ prompt: "Spider-Man." })).rejects.toBe(second);
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(mocks.rewriteImagePromptForCopyright).toHaveBeenCalledTimes(1);
  });

  it("keeps the original refusal when the rewritten render fails for a reason that is not one", async () => {
    // The retry may never leave the caller worse off than not retrying. Both
    // providers refusing is a settled fact `renderCharacterReferenceSheets`
    // records before finishing the book without that sheet; an outage is not,
    // and it fails GENERATE_BOOK. So a rewritten render whose primary refused
    // and whose fallback timed out hands back the refusal, not the outage.
    mocks.rewriteImagePromptForCopyright.mockResolvedValue({
      outcome: "rewritten",
      prompt: "an original hero",
      replaced: ["Spider-Man"]
    });
    const refusal = copyrightRefusal();
    const outage = new Error("primary refused and the fallback timed out");
    const generateImage = vi.fn().mockRejectedValueOnce(refusal).mockRejectedValueOnce(outage);

    await expect(adapterOver(generateImage).generateImage({ prompt: "Spider-Man." })).rejects.toBe(refusal);
    expect(generateImage).toHaveBeenCalledTimes(2);
    // The picture that never arrived is still written down — it is the only
    // trace that a rewrite was drawn from and answered nothing.
    expect(mocks.append).toHaveBeenCalledWith("image.generate.copyright_rewrite_render_failed", {
      refusalReason: "IMAGE_RECITATION",
      rewrittenPrompt: "an original hero",
      renderError: { message: `Error: ${outage.message}` },
      error: { message: `Error: ${refusal.message}` }
    });
  });

  it("still hands back a rewritten render's stop rather than the refusal", async () => {
    mocks.rewriteImagePromptForCopyright.mockResolvedValue({
      outcome: "rewritten",
      prompt: "an original hero",
      replaced: ["Spider-Man"]
    });
    const stop = Object.assign(new Error("stopped"), { name: "StopRequestedError" });
    const generateImage = vi.fn().mockRejectedValueOnce(copyrightRefusal()).mockRejectedValueOnce(stop);

    await expect(adapterOver(generateImage).generateImage({ prompt: "Spider-Man." })).rejects.toBe(stop);
    expect(mocks.append).not.toHaveBeenCalledWith("image.generate.copyright_rewrite_render_failed", expect.anything());
  });

  it("leaves a refusal that is not about a name completely alone", async () => {
    const refusal = otherRefusal();
    const generateImage = vi.fn().mockRejectedValue(refusal);

    await expect(adapterOver(generateImage).generateImage({ prompt: "something else." })).rejects.toBe(refusal);
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(mocks.rewriteImagePromptForCopyright).not.toHaveBeenCalled();
    // Alone is not silent. The gate used to short-circuit past every append
    // below it, so the one decision that can quietly cost a picture — the
    // child-safety veto firing, or a refusal carrying no IP evidence — was the
    // only one the run log never saw, and a suppressed rewrite looked exactly
    // like a plain refused picture.
    expect(mocks.append).toHaveBeenCalledWith("image.generate.copyright_rewrite_not_offered", {
      refusalReason: "IMAGE_SAFETY",
      error: { message: `Error: ${refusal.message}` }
    });
  });

  it("writes down no rewrite decision for a failure that was never a refusal", async () => {
    // An outage never reached the gate as a verdict — `image.generate.error`
    // already has it — and calling it a rewrite decision would invent one.
    const outage = new Error("the model is overloaded");
    const generateImage = vi.fn().mockRejectedValue(outage);

    await expect(adapterOver(generateImage).generateImage({ prompt: "Spider-Man." })).rejects.toBe(outage);
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("keeps the original refusal when there is nothing to retry with", async () => {
    mocks.rewriteImagePromptForCopyright.mockResolvedValue({ outcome: "declined" });
    const refusal = copyrightRefusal();
    const generateImage = vi.fn().mockRejectedValue(refusal);

    await expect(adapterOver(generateImage).generateImage({ prompt: "Spider-Man." })).rejects.toBe(refusal);
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(mocks.append).toHaveBeenCalledWith("image.generate.copyright_rewrite_declined", {
      refusalReason: "IMAGE_RECITATION",
      error: { message: `Error: ${refusal.message}` }
    });
  });

  it("says so in the run log when the rewrite failed rather than declined", async () => {
    // Both outcomes keep the refusal and draw nothing, so the run log is the
    // only place a rewrite that was paid for and answered nothing can be told
    // from one that read the prompt and found no protected name.
    const outage = new Error("rewrite model is down");
    mocks.rewriteImagePromptForCopyright.mockResolvedValue({ outcome: "failed", error: outage });
    const refusal = copyrightRefusal();
    const generateImage = vi.fn().mockRejectedValue(refusal);

    await expect(adapterOver(generateImage).generateImage({ prompt: "Spider-Man." })).rejects.toBe(refusal);
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(mocks.append).toHaveBeenCalledWith("image.generate.copyright_rewrite_failed", {
      refusalReason: "IMAGE_RECITATION",
      rewriteError: { message: `Error: ${outage.message}` },
      error: { message: `Error: ${refusal.message}` }
    });
    expect(mocks.append).not.toHaveBeenCalledWith("image.generate.copyright_rewrite_declined", expect.anything());
  });

  it("does not rewrite its way past a stop", async () => {
    const stop = Object.assign(new Error("stopped"), { name: "StopRequestedError", category: "copyright" });
    const generateImage = vi.fn().mockRejectedValue(stop);

    await expect(adapterOver(generateImage).generateImage({ prompt: "Spider-Man." })).rejects.toBe(stop);
    expect(mocks.rewriteImagePromptForCopyright).not.toHaveBeenCalled();
    // A stop is not a verdict about this prompt, so there is no rewrite
    // decision to write down either.
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("passes the wrapped adapter's reference-image capabilities through", () => {
    expect(adapterOver(vi.fn()).capabilities()).toEqual({ supportsReferenceImages: true, maxReferenceImages: 3 });
  });
});
