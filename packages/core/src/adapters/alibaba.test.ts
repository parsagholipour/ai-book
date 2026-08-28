import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AlibabaImageAdapter, AlibabaTextAdapter } from "./alibaba.js";
import type { ImageRequest } from "./types.js";
import { isImageContentRefusalError } from "./imageRefusal.js";
import { imageRefusalCategory } from "./imageRefusalVerdict.js";
import { ProviderHttpError } from "./retry.js";

describe("AlibabaTextAdapter", () => {
  it("keeps provider usage on JSON validation errors", async () => {
    const adapter = new AlibabaTextAdapter({ apiKey: "test-key", textModel: "qwen-plus" });
    (adapter as any).client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: `{ "approved": "yes" }` } }],
            usage: { prompt_tokens: 123, completion_tokens: 45 }
          })
        }
      }
    };

    await expect(
      adapter.generateJson({
        purpose: "plan-book",
        messages: [{ role: "user", content: "Return a report." }],
        schema: z.object({ approved: z.boolean() })
      })
    ).rejects.toMatchObject({
      provider: "alibaba",
      model: "qwen-plus",
      usage: { promptTokens: 123, outputTokens: 45 }
    });
  });
});

describe("AlibabaImageAdapter", () => {
  it("reports Qwen Image 2.0 models can consume up to three references", () => {
    for (const imageModel of ["qwen-image-2.0", "qwen-image-2.0-pro"]) {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel });

      expect(adapter.capabilities()).toEqual({
        supportsReferenceImages: true,
        maxReferenceImages: 3
      });
    }

    const legacyAdapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-plus" });
    expect(legacyAdapter.capabilities()).toEqual({
      supportsReferenceImages: false,
      maxReferenceImages: 0
    });
  });

  it("sends reference images as base64 image parts for Qwen Image 2.0", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "book-maker-qwen-ref-"));
    const referencePath = join(tempDir, "nora.png");
    const secondReferencePath = join(tempDir, "milo.webp");
    await writeFile(referencePath, Buffer.from("fake-png"));
    await writeFile(secondReferencePath, Buffer.from("fake-webp"));
    const calls = mockAlibabaImageFetch();
    const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0" });

    try {
      await adapter.generateImage({
        prompt: "Illustrate Nora and Milo beside the moon bell.",
        referenceImagePaths: [referencePath, secondReferencePath]
      });
    } finally {
      calls.restore();
      await rm(tempDir, { recursive: true, force: true });
    }

    const content = calls.bodies[0]?.input?.messages?.[0]?.content;
    expect(content).toEqual([
      { image: `data:image/png;base64,${Buffer.from("fake-png").toString("base64")}` },
      { image: `data:image/webp;base64,${Buffer.from("fake-webp").toString("base64")}` },
      { text: "Illustrate Nora and Milo beside the moon bell." }
    ]);
  });

  it("clips Qwen reference images to the supported limit", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "book-maker-qwen-ref-limit-"));
    const referencePaths = await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const path = join(tempDir, `reference-${index + 1}.png`);
        await writeFile(path, Buffer.from(`fake-png-${index + 1}`));
        return path;
      })
    );
    const calls = mockAlibabaImageFetch();
    const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0-pro" });

    try {
      await adapter.generateImage({
        prompt: "Illustrate the selected characters.",
        referenceImagePaths: referencePaths
      });
    } finally {
      calls.restore();
      await rm(tempDir, { recursive: true, force: true });
    }

    const content = calls.bodies[0]?.input?.messages?.[0]?.content;
    expect(content).toHaveLength(4);
    expect(content.filter((part: Record<string, unknown>) => "image" in part)).toHaveLength(3);
    expect(content[3]).toEqual({ text: "Illustrate the selected characters." });
    expect(JSON.stringify(content)).not.toContain(Buffer.from("fake-png-4").toString("base64"));
  });

  it("rejects reference images for unsupported Qwen image models", async () => {
    const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-plus" });

    await expect(
      adapter.generateImage({
        prompt: "Illustrate Nora.",
        referenceImagePaths: ["/tmp/nora.png"]
      })
    ).rejects.toThrow(/cannot consume character reference images/i);
  });

  it("types DashScope's content filter as a refusal rather than a retryable HTTP failure", async () => {
    // The 400 that ended a book: Qwen's IP inspector answering a prompt naming
    // a copyrighted character. Re-asking gets the same answer, so it must not
    // reach the retry ladder as an ordinary provider error.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: "DataInspectionFailed",
          message: "Output data is suspected of being involved in IP infringement"
        }),
        { status: 400 }
      )) as typeof fetch;

    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0" });
      const error = await adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(true);
      expect(error).toMatchObject({ provider: "alibaba", model: "qwen-image-2.0", reason: "DataInspectionFailed" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("leaves an ordinary 400 a retryable provider error, because it is a bug and not a verdict", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "InvalidParameter", message: "size is not supported" }), {
        status: 400
      })) as typeof fetch;

    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0" });
      const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(false);
      expect(error).toBeInstanceOf(ProviderHttpError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("leaves a DashScope filter *outage* a retryable failure, not a settled refusal", async () => {
    // DashScope spells its inspector's name into its outages exactly as it does
    // into its verdicts, and the error-body path read that vocabulary with
    // nothing above it — so this sentence left here as an `ImageContentRefusedError`
    // recorded under the reason `InternalError`. Nothing retries one: all three
    // `withRecoverableNetworkRetry` attempts are skipped, the async endpoint is
    // refused, and a character reference sheet writes the outage onto
    // `PlanVersion.characterReferenceRefusals` as a fact no pass revisits. The
    // very same sentence through `isSpokenImageRefusal` — the sync 200's path —
    // has always answered "not a refusal", which is the asymmetry this closes.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: "InternalError",
          message: "InternalError: the data inspection service is temporarily unavailable, please retry."
        }),
        { status: 400 }
      )) as typeof fetch;

    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0" });
      const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(false);
      expect(error).toBeInstanceOf(ProviderHttpError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("leaves a FAILED async task that reports the filter broken retryable too", async () => {
    // The second error-body path, and the same statement: a task that failed
    // while DashScope's inspector was down is not a picture DashScope declined.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      if (String(url).includes("text2image/image-synthesis")) {
        return new Response(JSON.stringify({ output: { task_id: "task-1", task_status: "PENDING" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          output: {
            task_status: "FAILED",
            code: "InternalError",
            message: "InternalError: the data inspection service is temporarily unavailable, please retry."
          }
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    vi.useFakeTimers();
    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image" });
      const pending = (adapter as any)
        .generateAsyncImage({ prompt: "Illustrate Nora." })
        .catch((thrown: unknown) => thrown);
      await vi.advanceTimersByTimeAsync(5000);
      const error = await pending;

      expect(isImageContentRefusalError(error)).toBe(false);
      expect((error as Error).message).toMatch(/Qwen image generation failed for task/i);
    } finally {
      vi.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });

  it("still refuses a FAILED async task whose filter actually answered", async () => {
    // The other direction, so the veto above cannot quietly become "DashScope's
    // vocabulary settles nothing in an error body".
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      if (String(url).includes("text2image/image-synthesis")) {
        return new Response(JSON.stringify({ output: { task_id: "task-1", task_status: "PENDING" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          output: {
            task_status: "FAILED",
            code: "DataInspectionFailed",
            message: "Output data is suspected of being involved in IP infringement"
          }
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    vi.useFakeTimers();
    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image" });
      const pending = (adapter as any)
        .generateAsyncImage({ prompt: "Illustrate Spiderman." })
        .catch((thrown: unknown) => thrown);
      await vi.advanceTimersByTimeAsync(5000);
      const error = await pending;

      expect(isImageContentRefusalError(error)).toBe(true);
      expect(error).toMatchObject({ reason: "DataInspectionFailed" });
      expect(imageRefusalCategory(error)).toBe("copyright");
    } finally {
      vi.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });

  it("reads a filtered result row out of a FAILED async task, not only a succeeded one", async () => {
    // The async endpoint puts a per-picture verdict in the result row, and the
    // task around it says FAILED as readily as SUCCEEDED. Only the SUCCEEDED
    // half read that row, so this left the poll as a bare `Error` — retryable to
    // `withRecoverableNetworkRetry`, to the image fallback and to BullMQ, which
    // is a settled verdict bought three times over and the copyright rewrite
    // never offered.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      if (String(url).includes("text2image/image-synthesis")) {
        return new Response(JSON.stringify({ output: { task_id: "task-1", task_status: "PENDING" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          output: {
            task_status: "FAILED",
            results: [
              { code: "DataInspectionFailed", message: "Output data is suspected of being involved in IP infringement" }
            ]
          }
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    vi.useFakeTimers();
    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image" });
      const pending = (adapter as any)
        .generateAsyncImage({ prompt: "Illustrate Spiderman." })
        .catch((thrown: unknown) => thrown);
      await vi.advanceTimersByTimeAsync(5000);
      const error = await pending;

      expect(isImageContentRefusalError(error)).toBe(true);
      expect(error).toMatchObject({ reason: "DataInspectionFailed" });
      // The row's message travels with its code, or the rewrite path cannot
      // tell a name it may replace from a category it may not.
      expect(imageRefusalCategory(error)).toBe("copyright");
    } finally {
      vi.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });

  it("does not re-ask the async endpoint after the sync endpoint refused the prompt", async () => {
    // `qwen-image` is one of the two models `supportsAsyncQwenImage` accepts, so
    // this is the pair where a refusal typed as anything other than a
    // `ProviderHttpError` falls straight through the status test and buys a
    // second, fully billed render of a prompt DashScope has already declined.
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          code: "DataInspectionFailed",
          message: "Input data may contain inappropriate content"
        }),
        { status: 400 }
      );
    }) as typeof fetch;

    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image" });
      const error = await adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(true);
      expect(error).toMatchObject({ provider: "alibaba", model: "qwen-image", reason: "DataInspectionFailed" });
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("multimodal-generation/generation");
      expect(urls.some((url) => url.includes("text2image/image-synthesis"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("types a spoken decline in a 200 as a refusal, and does not re-ask the async endpoint for it", async () => {
    // The sync multimodal endpoint is a chat endpoint, so DashScope can decline
    // by talking: HTTP 200, a normal turn, and a sentence where the image
    // belongs. `qwen-image` is one of the two async-capable models, so this is
    // also the pair where a verdict left untyped buys a second billed render.
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          output: {
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: [{ text: "I can't create an image of Spider-Man — he is a copyrighted character." }]
                }
              }
            ]
          }
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image" });
      const error = await adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(true);
      expect(error).toMatchObject({ provider: "alibaba", model: "qwen-image", reason: "NO_IMAGE" });
      // The prose travels, so the rewrite path can tell a name it may replace
      // from a category it may not.
      expect(imageRefusalCategory(error)).toBe("copyright");
      expect(urls).toHaveLength(1);
      expect(urls.some((requested) => requested.includes("text2image/image-synthesis"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records a spoken refusal under the spoken label, not a code the filter test already rejected", async () => {
    // A picture-less 200 that names a code having nothing to do with a filter,
    // and declines in words beside it. `isAlibabaRefusalCode` has already been
    // asked about that code and said no, so recording it as *the* reason the
    // picture was refused points whoever reads it at the wrong cause — and for
    // a character reference sheet that reason is written onto
    // `PlanVersion.characterReferenceRefusals` as a settled, permanent fact.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: "InvalidParameter",
          output: {
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: [{ text: "I can't create an image of Spider-Man — he is a copyrighted character." }]
                }
              }
            ]
          }
        }),
        { status: 200 }
      )) as typeof fetch;

    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0" });
      const error = await adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(true);
      expect((error as { reason: string }).reason).not.toBe("InvalidParameter");
      // The prose is what settled it, so the label says so — and the code
      // still travels as the qualifier it is, because the classifier reads a
      // recorded reason as evidence and DashScope's filter vocabulary is wider
      // than `data inspection`.
      expect(error).toMatchObject({ reason: "NO_IMAGE: InvalidParameter" });
      expect(imageRefusalCategory(error)).toBe("copyright");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("types DashScope's filter code inside a 200 as a refusal", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: "DataInspectionFailed",
          message: "Input data may contain inappropriate content.",
          output: {}
        }),
        { status: 200 }
      )) as typeof fetch;

    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0" });
      const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(true);
      expect(error).toMatchObject({ provider: "alibaba", model: "qwen-image-2.0", reason: "DataInspectionFailed" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("leaves an empty or non-declining 200 a retryable failure", async () => {
    // A render that did not happen. Calling this permanent is how a character
    // loses its reference sheet for the life of the plan.
    const bodies = [
      { output: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: [] } }] } },
      {
        output: {
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: [{ text: "Here you go!" }] } }]
        }
      }
    ];

    for (const body of bodies) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;

      try {
        const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0" });
        const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

        expect(isImageContentRefusalError(error)).toBe(false);
        expect((error as Error).message).toMatch(/did not return an image URL or bytes/i);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  it("leaves a 200 that narrates its own compliance a retryable failure", async () => {
    // The sync endpoint's prose is the *model* talking, so a turn that drew a
    // picture and lost its bytes arrives here narrating its own care. DashScope's
    // vocabulary used to be ORed beside `isSpokenImageRefusal` rather than handed
    // into it, and its bare `/content policy/i` had no clearance veto in front of
    // it — so this exact sentence was a permanent refusal on Alibaba and a
    // retryable blip on Gemini, and for a character reference sheet the first
    // answer is written onto the plan version for good.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          output: {
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: [{ text: "The image was generated in accordance with the content policy." }]
                }
              }
            ]
          }
        }),
        { status: 200 }
      )) as typeof fetch;

    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0" });
      const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(false);
      expect((error as Error).message).toMatch(/did not return an image URL or bytes/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("still refuses on DashScope's own filter words inside a 200", async () => {
    // The other direction, so the veto above cannot quietly become "DashScope's
    // vocabulary settles nothing". No first-person decline and none of the
    // general filter words — the provider's half of reading 1 is all there is.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: "InvalidParameter",
          output: {
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: [{ text: "Output data is suspected of IP infringement." }] }
              }
            ]
          }
        }),
        { status: 200 }
      )) as typeof fetch;

    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0" });
      const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(true);
      expect(error).toMatchObject({ reason: "NO_IMAGE: InvalidParameter" });
      expect(imageRefusalCategory(error)).toBe("copyright");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reads a filtered result row out of a succeeded async task", async () => {
    // The async endpoint reports a filtered picture as a SUCCEEDED task whose
    // result row carries the code, so the poll lands in the same no-image path.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      if (String(url).includes("text2image/image-synthesis")) {
        return new Response(JSON.stringify({ output: { task_id: "task-1", task_status: "PENDING" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          output: {
            task_status: "SUCCEEDED",
            results: [
              { code: "DataInspectionFailed", message: "Output data is suspected of being involved in IP infringement" }
            ]
          }
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    vi.useFakeTimers();
    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image" });
      const pending = (adapter as any)
        .generateAsyncImage({ prompt: "Illustrate Spiderman." })
        .catch((thrown: unknown) => thrown);
      await vi.advanceTimersByTimeAsync(5000);
      const error = await pending;

      expect(isImageContentRefusalError(error)).toBe(true);
      expect(error).toMatchObject({ reason: "DataInspectionFailed" });
      expect(imageRefusalCategory(error)).toBe("copyright");
    } finally {
      vi.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses to draw a reference-carrying request on the async endpoint, rather than dropping the references", async () => {
    // `text2image/image-synthesis` posts `input: { prompt }` and nothing else,
    // and every model `supportsAsyncQwenImage` routes there declares
    // `supportsReferenceImages: false`. So a reference-carrying request handed
    // to it came back as a picture drawn from the prompt alone — no cast
    // likeness, no library face seed, no event and no run-log line. For a
    // character reference sheet that picture is written as an ordinary
    // `ImageAsset`, `characterReferenceSetIsSettled` then reports the cast
    // settled, and the off-model sheet is what every page and the cover are
    // drawn against for the life of the plan version.
    const tempDir = await mkdtemp(join(tmpdir(), "book-maker-qwen-async-ref-"));
    const referencePath = join(tempDir, "nora.png");
    await writeFile(referencePath, Buffer.from("fake-png"));
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url) => {
      urls.push(String(url));
      if (String(url).includes("text2image/image-synthesis")) {
        return new Response(JSON.stringify({ output: { task_id: "task-1", task_status: "PENDING" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ output: { task_status: "SUCCEEDED", results: [{ url: "https://example.com/drawn.png" }] } }),
        { status: 200 }
      );
    }) as typeof fetch;

    vi.useFakeTimers();
    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image" });
      const pending = (adapter as unknown as { generateAsyncImage: (request: ImageRequest) => Promise<unknown> })
        .generateAsyncImage({ prompt: "Illustrate Nora.", referenceImagePaths: [referencePath] })
        .catch((thrown: unknown) => thrown);
      await vi.advanceTimersByTimeAsync(5000);
      const outcome = await pending;

      expect((outcome as Error).message).toMatch(/cannot consume character reference images/i);
      expect(urls).toEqual([]);
    } finally {
      vi.useRealTimers();
      globalThis.fetch = originalFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the sync failure when the async endpoint cannot carry the request's references", async () => {
    // The fork is guarded today only by two hand-kept lists that happen to be
    // disjoint — `supportsAsyncQwenImage` names `qwen-image`/`qwen-image-plus`,
    // `supportsQwenImageReferenceImages` names the 2.0 family — and nothing
    // ties them together. Widening either by one word arms the loss above, so
    // this drives the fork with the widening applied: a transient 500 on a
    // reference-carrying render must leave the `ProviderHttpError` standing for
    // `withRecoverableNetworkRetry` and the provider fallback (both of which can
    // serve the request *with* its references), never buy a reference-less
    // picture from the other endpoint.
    const tempDir = await mkdtemp(join(tmpdir(), "book-maker-qwen-async-fork-"));
    const referencePath = join(tempDir, "nora.png");
    await writeFile(referencePath, Buffer.from("fake-png"));
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url) => {
      urls.push(String(url));
      if (String(url).includes("multimodal-generation/generation")) {
        return new Response(JSON.stringify({ message: "upstream unavailable" }), { status: 500 });
      }
      // A create with no task ID ends the async attempt immediately, which is
      // all this test needs: the question is only whether it was taken.
      return new Response(JSON.stringify({ output: {} }), { status: 200 });
    }) as typeof fetch;

    vi.resetModules();
    vi.doMock("./alibabaModels.js", async () => {
      const actual = await vi.importActual<typeof import("./alibabaModels.js")>("./alibabaModels.js");
      return {
        ...actual,
        supportsQwenImageReferenceImages: (model: string) =>
          model === "qwen-image" || actual.supportsQwenImageReferenceImages(model),
        qwenImageReferenceLimit: (model: string) => (model === "qwen-image" ? 3 : actual.qwenImageReferenceLimit(model))
      };
    });

    try {
      const { AlibabaImageAdapter: PatchedAdapter } = await import("./alibaba.js");
      // `resetModules` gave that graph its own copy of `retry.js`, so the class
      // to compare against is the one it actually throws.
      const { ProviderHttpError: PatchedProviderHttpError } = await import("./retry.js");
      const adapter = new PatchedAdapter({ apiKey: "test-key", imageModel: "qwen-image" });
      const error = await adapter
        .generateImage({ prompt: "Illustrate Nora.", referenceImagePaths: [referencePath] })
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(PatchedProviderHttpError);
      expect((error as ProviderHttpError).status).toBe(500);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("multimodal-generation/generation");
      expect(urls.some((url) => url.includes("text2image/image-synthesis"))).toBe(false);
    } finally {
      vi.doUnmock("./alibabaModels.js");
      vi.resetModules();
      globalThis.fetch = originalFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves a filter outage retryable even when DashScope answers with its inspector's own code", async () => {
    // The outage veto lived inside the *prose* arm, and the code arm answers
    // first — so a filter outage reported under `DataInspectionFailed` rather
    // than `InternalError` short-circuited past the veto entirely. Nothing
    // retries the result: all three `withRecoverableNetworkRetry` attempts are
    // skipped, the async endpoint is refused, and a character reference sheet
    // writes the outage onto `PlanVersion.characterReferenceRefusals` as a
    // settled fact no pass revisits and nothing in the product ever clears.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: "DataInspectionFailed",
          message: "the data inspection service is temporarily unavailable, please retry."
        }),
        { status: 400 }
      )) as typeof fetch;

    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0" });
      const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(false);
      expect(error).toBeInstanceOf(ProviderHttpError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("leaves a FAILED async task retryable when the inspector's code names an outage too", async () => {
    // The same asymmetry through the second error-body door.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      if (String(url).includes("text2image/image-synthesis")) {
        return new Response(JSON.stringify({ output: { task_id: "task-1", task_status: "PENDING" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          output: {
            task_status: "FAILED",
            code: "DataInspectionFailed",
            message: "the data inspection service is temporarily unavailable, please retry."
          }
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    vi.useFakeTimers();
    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image" });
      const pending = (adapter as unknown as { generateAsyncImage: (request: ImageRequest) => Promise<unknown> })
        .generateAsyncImage({ prompt: "Illustrate Nora." })
        .catch((thrown: unknown) => thrown);
      await vi.advanceTimersByTimeAsync(5000);
      const error = await pending;

      expect(isImageContentRefusalError(error)).toBe(false);
      expect((error as Error).message).toMatch(/Qwen image generation failed for task/i);
    } finally {
      vi.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });

  it("leaves a picture-less 200 retryable when its code and its prose both report the filter broken", async () => {
    // And through the third: `missingImageError` carried the same
    // short-circuit, so the veto `isSpokenImageRefusal` applies to the model's
    // prose was never reached when a code was present.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: "DataInspectionFailed",
          output: {
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: [{ text: "the data inspection service is temporarily unavailable, please retry." }]
                }
              }
            ]
          }
        }),
        { status: 200 }
      )) as typeof fetch;

    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0" });
      const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(false);
      expect((error as Error).message).toMatch(/did not return an image URL or bytes/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("still refuses on the filter's own code when nothing reports it broken", async () => {
    // The other direction, so the veto above cannot quietly become "DashScope's
    // own code settles nothing": a bare `DataInspectionFailed` with no sentence
    // beside it is still the filter answering.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "DataInspectionFailed" }), { status: 400 })) as typeof fetch;

    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0" });
      const error = await adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(true);
      expect(error).toMatchObject({ provider: "alibaba", reason: "DataInspectionFailed" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("still falls back to the async endpoint when the sync attempt died in transport", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url) => {
      urls.push(String(url));
      if (urls.length === 1) {
        throw new TypeError("fetch failed");
      }
      // A create with no task ID ends the async attempt immediately, which is
      // all this test needs: the fallback was taken.
      return new Response(JSON.stringify({ output: {} }), { status: 200 });
    }) as typeof fetch;

    try {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image" });
      const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/did not return a task ID/i);
      expect(urls).toHaveLength(2);
      expect(urls[1]).toContain("text2image/image-synthesis");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function mockAlibabaImageFetch() {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    if (typeof init?.body === "string") {
      bodies.push(JSON.parse(init.body));
    }
    return new Response(
      JSON.stringify({
        output: {
          choices: [
            {
              message: {
                content: [{ image: "https://example.com/generated.png" }]
              }
            }
          ]
        }
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  return {
    bodies,
    restore: () => {
      globalThis.fetch = originalFetch;
    }
  };
}
