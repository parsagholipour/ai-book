import { ThinkingLevel } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { GeminiImageAdapter, GeminiResearchAdapter, GeminiTextAdapter } from "./gemini.js";
import { isImageContentRefusalError } from "./imageRefusal.js";
import { imageRefusalCategory } from "./imageRefusalVerdict.js";

describe("GeminiTextAdapter", () => {
  it("generates text from chat messages and maps usage metadata", async () => {
    const requests: any[] = [];
    const adapter = new GeminiTextAdapter({ apiKey: "test-key", textModel: "gemini-test" });
    (adapter as any).ai = {
      models: {
        generateContent: async (request: any) => {
          requests.push(request);
          return {
            text: "A generated response.",
            usageMetadata: {
              promptTokenCount: 11,
              candidatesTokenCount: 7,
              cachedContentTokenCount: 3
            }
          };
        }
      }
    };

    const result = await adapter.generateText({
      messages: [
        { role: "system", content: "Write in a direct style." },
        { role: "user", content: "Draft a paragraph." }
      ],
      temperature: 0.4,
      maxTokens: 100
    });

    expect(requests[0].model).toBe("gemini-test");
    expect(requests[0].config.systemInstruction).toContain("direct style");
    expect(requests[0].contents[0]).toMatchObject({ role: "user", parts: [{ text: "Draft a paragraph." }] });
    expect(result).toMatchObject({
      provider: "gemini",
      model: "gemini-test",
      text: "A generated response.",
      usage: { promptTokens: 11, outputTokens: 7, cacheHitTokens: 3 }
    });
  });

  it("counts thinking tokens as output tokens, because Google bills them that way", async () => {
    const usageFor = async (usageMetadata: Record<string, number>) => {
      const adapter = new GeminiTextAdapter({ apiKey: "test-key", textModel: "gemini-2.5-pro" });
      (adapter as any).ai = {
        models: { generateContent: async () => ({ text: "A generated response.", usageMetadata }) }
      };
      const result = await adapter.generateText({ messages: [{ role: "user", content: "Draft a paragraph." }] });
      return result.usage;
    };

    // `thoughtsTokenCount` sits beside `candidatesTokenCount`, not inside it, so
    // reading only the candidates count under-reported every reasoning call —
    // and `costHint` is what the admin margin columns sum.
    expect(await usageFor({ promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 512 })).toMatchObject({
      promptTokens: 11,
      outputTokens: 519
    });

    // Non-thinking models and older responses omit the field entirely, and they
    // report exactly what they always did.
    expect(await usageFor({ promptTokenCount: 11, candidatesTokenCount: 7 })).toMatchObject({
      promptTokens: 11,
      outputTokens: 7
    });

    // A call truncated while still thinking reports thoughts and no candidates.
    // Those tokens were still billed, so they are still output.
    expect(await usageFor({ promptTokenCount: 11, thoughtsTokenCount: 512 })).toMatchObject({ outputTokens: 512 });

    // Told nothing stays undefined rather than becoming a confident zero: the
    // cost tables price an unreported count differently from a real zero.
    expect((await usageFor({ promptTokenCount: 11 }))?.outputTokens).toBeUndefined();
  });

  it("passes a configured thinking budget to text generation requests", async () => {
    const requests: any[] = [];
    const adapter = new GeminiTextAdapter({
      apiKey: "test-key",
      textModel: "gemini-3.5-flash",
      thinkingBudget: 0,
      thinkingEffort: "high"
    });
    (adapter as any).ai = {
      models: {
        generateContent: async (request: any) => {
          requests.push(request);
          return { text: "A generated response." };
        }
      }
    };

    await adapter.generateText({
      messages: [{ role: "user", content: "Draft a paragraph." }]
    });

    expect(requests[0].config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("passes configured thinking levels to Gemini 3.5 and 3.7 Flash requests", async () => {
    const cases = [
      ["minimal", ThinkingLevel.MINIMAL],
      ["low", ThinkingLevel.LOW],
      ["medium", ThinkingLevel.MEDIUM],
      ["high", ThinkingLevel.HIGH]
    ] as const;

    for (const textModel of ["gemini-3.5-flash", "gemini-3.7-flash"] as const) {
      for (const [thinkingEffort, thinkingLevel] of cases) {
        const requests: any[] = [];
        const adapter = new GeminiTextAdapter({
          apiKey: "test-key",
          textModel,
          thinkingEffort
        });
        (adapter as any).ai = {
          models: {
            generateContent: async (request: any) => {
              requests.push(request);
              return { text: "A generated response." };
            }
          }
        };

        await adapter.generateText({
          messages: [{ role: "user", content: "Draft a paragraph." }]
        });

        expect(requests[0].config.thinkingConfig).toEqual({ thinkingLevel });
      }
    }
  });

  it("generates schema-constrained JSON and validates the parsed data", async () => {
    const requests: any[] = [];
    const adapter = new GeminiTextAdapter({ apiKey: "test-key", textModel: "gemini-json" });
    (adapter as any).ai = {
      models: {
        generateContent: async (request: any) => {
          requests.push(request);
          return {
            text: `{ "approved": true, "issues": [] }`,
            usageMetadata: {
              promptTokenCount: 5,
              candidatesTokenCount: 4
            }
          };
        }
      }
    };

    const result = await adapter.generateJson({
      purpose: "json-test",
      messages: [{ role: "user", content: "Return a report." }],
      schema: z.object({
        approved: z.boolean(),
        issues: z.array(z.string())
      })
    });

    expect(requests[0].config.responseMimeType).toBe("application/json");
    expect(requests[0].config.responseJsonSchema).toMatchObject({ type: "object" });
    expect(result.data).toEqual({ approved: true, issues: [] });
    expect(result.usage).toMatchObject({ promptTokens: 5, outputTokens: 4 });
  });

  it("streams text chunks", async () => {
    const adapter = new GeminiTextAdapter({ apiKey: "test-key", textModel: "gemini-stream" });
    (adapter as any).ai = {
      models: {
        generateContentStream: async function* () {
          yield { text: "first " };
          yield { candidates: [{ content: { parts: [{ text: "second" }] } }] };
        }
      }
    };

    const chunks: string[] = [];
    for await (const chunk of adapter.streamText({ messages: [{ role: "user", content: "Stream." }] })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["first ", "second"]);
  });
});

describe("GeminiResearchAdapter", () => {
  it("does not seed or store AI-book prompt echoes in research text", async () => {
    const requests: any[] = [];
    const adapter = new GeminiResearchAdapter({ apiKey: "test-key", textModel: "test-model" });
    (adapter as any).ai = {
      models: {
        generateContent: async (request: any) => {
          requests.push(request);
          return {
            text: [
              "For an AI book outline exploring the topic, consider these sources:",
              "- A useful reader-facing note."
            ].join("\n"),
            candidates: [
              {
                groundingMetadata: {
                  groundingChunks: [{ web: { title: "Example Source", uri: "https://example.com/source" } }]
                }
              }
            ]
          };
        }
      }
    };

    const result = await adapter.search({ query: "female-led societies", purpose: "plan-research" });

    expect(requests[0].contents).not.toContain("AI book");
    expect(result.summary).not.toContain("AI book");
    expect(result.sources[0]?.summary).not.toContain("AI book");
    expect(result.sources[0]?.summary).toContain("A useful reader-facing note");
  });

  it("cites the publisher's own address instead of Google's grounding redirect", async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://audubon.org/news/owls" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new GeminiResearchAdapter({ apiKey: "test-key", textModel: "test-model" });
    (adapter as any).ai = {
      models: {
        generateContent: async () => ({
          text: "Owls hunt at night.",
          candidates: [
            {
              groundingMetadata: {
                groundingChunks: [
                  {
                    web: {
                      title: "audubon.org",
                      uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123"
                    }
                  }
                ]
              }
            }
          ]
        })
      }
    };

    const result = await adapter.search({ query: "owls", purpose: "plan-research" });

    expect(result.sources[0]?.url).toBe("https://audubon.org/news/owls");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

describe("GeminiImageAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends reference images as inlineData parts for native Gemini image models", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "book-maker-gemini-ref-"));
    const referencePath = join(tempDir, "nora.png");
    await writeFile(referencePath, Buffer.from("fake-png"));
    const requests: any[] = [];
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "gemini-2.5-flash-image" });
    (adapter as any).ai = {
      models: {
        generateContent: async (request: any) => {
          requests.push(request);
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        data: Buffer.from("generated").toString("base64"),
                        mimeType: "image/png"
                      }
                    }
                  ]
                }
              }
            ]
          };
        }
      }
    };

    try {
      await adapter.generateImage({
        prompt: "Illustrate Nora in the garden.",
        referenceImagePaths: [referencePath]
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    const parts = requests[0]?.contents?.[0]?.parts;
    expect(parts?.[0]?.text).toContain("Illustrate Nora");
    expect(parts?.[1]?.inlineData?.mimeType).toBe("image/png");
    expect(parts?.[1]?.inlineData?.data).toBe(Buffer.from("fake-png").toString("base64"));
  });

  it("names the block when a native render comes back with no picture", async () => {
    // The primary half of the failure that ended a book. Gemini declines by
    // answering, so the HTTP call succeeds and the only trace is the finish
    // reason — which used to be dropped for a bare "did not return image bytes".
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "gemini-2.5-flash-image" });
    (adapter as any).ai = {
      models: {
        generateContent: async () => ({
          candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }]
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(true);
    expect(error).toMatchObject({ provider: "gemini", model: "gemini-2.5-flash-image", reason: "IMAGE_SAFETY" });
  });

  it("treats a turn that finished normally with a spoken refusal as a refusal", async () => {
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "gemini-2.5-flash-image" });
    (adapter as any).ai = {
      models: {
        generateContent: async () => ({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "I can't draw a copyrighted character." }] } }
          ]
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(true);
    expect(error).toMatchObject({ reason: "NO_IMAGE" });
    expect((error as Error).message).toContain("copyrighted character");
    // The rewrite path depends on this staying a *copyright* refusal.
    expect(imageRefusalCategory(error)).toBe("copyright");
  });

  it("leaves an empty turn that finished normally retryable", async () => {
    // The native image models intermittently answer a perfectly ordinary
    // request with a finished turn and no picture. Calling that a refusal made
    // a blip permanent: no retry ladder runs on one, and a character reference
    // sheet records it on the plan version for good.
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "gemini-2.5-flash-image" });
    (adapter as any).ai = {
      models: {
        generateContent: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [] } }] })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Nora in the garden." }).catch((thrown: unknown) => thrown);

    // Not a verdict: the provider fallback still runs, and nothing is written
    // onto the plan version as a settled fact.
    expect(isImageContentRefusalError(error)).toBe(false);
    expect((error as Error).message).toContain("STOP");
  });

  it("leaves a normally finished turn whose prose declines nothing retryable", async () => {
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "gemini-2.5-flash-image" });
    (adapter as any).ai = {
      models: {
        generateContent: async () => ({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "Here is the illustration of Nora in the garden." }] } }
          ]
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(false);
  });

  it("leaves IMAGE_OTHER retryable, because it names no objection", async () => {
    // "Image generation stopped for a reason not otherwise specified" is the
    // SDK's own gloss — a render that fell over reads exactly like this.
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "gemini-2.5-flash-image" });
    (adapter as any).ai = {
      models: {
        generateContent: async () => ({ candidates: [{ finishReason: "IMAGE_OTHER", content: { parts: [] } }] })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(false);
    expect((error as Error).message).toContain("IMAGE_OTHER");
  });

  it("still refuses IMAGE_OTHER when the model said why, and keeps the provider's word", async () => {
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "gemini-2.5-flash-image" });
    (adapter as any).ai = {
      models: {
        generateContent: async () => ({
          candidates: [
            {
              finishReason: "IMAGE_OTHER",
              finishMessage: "I cannot generate an image of a trademarked character.",
              content: { parts: [] }
            }
          ]
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(true);
    expect(error).toMatchObject({ reason: "IMAGE_OTHER" });
    expect(imageRefusalCategory(error)).toBe("copyright");
  });

  it("still names a filter that answered, whatever the turn said", async () => {
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "gemini-2.5-flash-image" });
    (adapter as any).ai = {
      models: {
        generateContent: async () => ({
          candidates: [{ finishReason: "STOP", content: { parts: [] } }],
          promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "Blocked by the prompt filter." }
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(true);
    expect(error).toMatchObject({ reason: "SAFETY" });
  });

  it("still names every prompt block reason that names an objection", async () => {
    // The other direction of the allowlist below, so trimming it cannot quietly
    // become "a filter that gave its own word settles nothing".
    for (const blockReason of ["SAFETY", "IMAGE_SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT"]) {
      const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "gemini-2.5-flash-image" });
      (adapter as any).ai = {
        models: {
          generateContent: async () => ({
            candidates: [{ finishReason: "STOP", content: { parts: [] } }],
            promptFeedback: { blockReason }
          })
        }
      };

      const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(true);
      expect(error).toMatchObject({ reason: blockReason });
    }
  });

  it("leaves an unspecified prompt block reason retryable, because it names no objection", async () => {
    // `blockReason` used to take any value at all, the argument being that the
    // field exists only when a filter blocked. Its own enum says otherwise.
    // `BLOCKED_REASON_UNSPECIFIED` is the proto zero value — what an *unset*
    // field deserializes to — and `OTHER` is the SDK's catch-all, glossed as
    // possibly "due to the prompt's language", which this product publishes in
    // nine of. Either one settled a picture-less turn as a permanent refusal:
    // no retry ladder runs on one, and a character reference sheet writes it
    // onto the plan version for the life of the plan. This is the bare-`STOP`
    // bug and `IMAGE_OTHER` beside it, one field over.
    for (const blockReason of ["OTHER", "BLOCKED_REASON_UNSPECIFIED"]) {
      const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "gemini-2.5-flash-image" });
      (adapter as any).ai = {
        models: {
          generateContent: async () => ({
            candidates: [{ finishReason: "STOP", content: { parts: [] } }],
            promptFeedback: { blockReason }
          })
        }
      };

      const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

      expect(isImageContentRefusalError(error)).toBe(false);
    }
  });

  it("leaves a block reason the SDK grows next retryable, without anyone editing this", async () => {
    // Membership is the whole test, so a value nobody here has weighed falls to
    // the cheap side on its own — a few retries and a fallback render, never a
    // character denied its reference sheet.
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "gemini-2.5-flash-image" });
    (adapter as any).ai = {
      models: {
        generateContent: async () => ({
          candidates: [{ finishReason: "STOP", content: { parts: [] } }],
          promptFeedback: { blockReason: "SOME_FUTURE_BLOCKED_REASON" }
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(false);
  });

  it("still refuses an unspecified block reason when the model said why, and keeps the provider's word", async () => {
    // The rejected reason is not thrown away: it travels as the qualifier it
    // is, the way DashScope's `InvalidParameter` does, so the run log still
    // shows what the provider sent without letting it settle anything.
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "gemini-2.5-flash-image" });
    (adapter as any).ai = {
      models: {
        generateContent: async () => ({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "I can't draw a copyrighted character." }] } }
          ],
          promptFeedback: { blockReason: "OTHER" }
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(true);
    expect(error).toMatchObject({ reason: "NO_IMAGE: OTHER" });
    expect(imageRefusalCategory(error)).toBe("copyright");
  });

  it("leaves a truncated response retryable, because no filter answered it", async () => {
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "gemini-2.5-flash-image" });
    (adapter as any).ai = {
      models: {
        generateContent: async () => ({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(false);
    expect((error as Error).message).toContain("MAX_TOKENS");
  });

  it("asks Imagen why it filtered, because the reason is opt-in", async () => {
    // Without `includeRaiReason` a filtered request answers 200 with an empty
    // picture and no reason at all, which is indistinguishable from a render
    // that fell over — and every classification below hangs on that field.
    const requests: any[] = [];
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" });
    (adapter as any).ai = {
      models: {
        generateImages: async (request: any) => {
          requests.push(request);
          return { generatedImages: [{ image: { imageBytes: Buffer.from("png").toString("base64") } }] };
        }
      }
    };

    await adapter.generateImage({ prompt: "Illustrate Nora in the garden." });

    expect(requests[0].config).toMatchObject({ numberOfImages: 1, includeRaiReason: true });
  });

  it("asks Imagen what tripped, not only whether something did", async () => {
    // The categories are a *second* opt-in. Without `includeSafetyAttributes`
    // the endpoint reports none, so every block was recorded as the bare word
    // `RAI_FILTERED` — and the child-safety veto, which is a word test over the
    // filter's own vocabulary, was left deciding over vocabulary nobody had
    // asked the provider for.
    const requests: any[] = [];
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" });
    (adapter as any).ai = {
      models: {
        generateImages: async (request: any) => {
          requests.push(request);
          return { generatedImages: [{ image: { imageBytes: Buffer.from("png").toString("base64") } }] };
        }
      }
    };

    await adapter.generateImage({ prompt: "Illustrate Nora in the garden." });

    expect(requests[0].config).toMatchObject({ includeRaiReason: true, includeSafetyAttributes: true });
  });

  it("sends both opt-ins through the real client, where an unsupported parameter would throw", async () => {
    // The SDK's mldev converter is the record of what the Gemini API accepts:
    // it forwards `includeSafetyAttributes` beside `includeRaiReason` and
    // throws outright for the parameters that endpoint really refuses (`seed`,
    // `negativePrompt`, `enhancePrompt`). Only a call through the real client
    // sees that — a stubbed `ai` forwards whatever it is handed.
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          predictions: [{ bytesBase64Encoded: Buffer.from("png").toString("base64"), mimeType: "image/png" }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" });

    const result = await adapter.generateImage({ prompt: "Illustrate Nora in the garden." });

    expect(bodies[0].parameters).toMatchObject({ includeRaiReason: true, includeSafetyAttributes: true });
    expect(result.data?.toString()).toBe("png");
  });

  it("records an Imagen RAI filter as a refusal, with the provider's prose kept as prose", async () => {
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" });
    (adapter as any).ai = {
      models: {
        generateImages: async () => ({
          generatedImages: [
            {
              raiFilteredReason:
                "Your current safety filter threshold filtered out 1 output image(s). You may try a different prompt."
            }
          ]
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(true);
    // The provider named no category, so the code stays its own field name and
    // the sentence stays where a sentence belongs.
    expect(error).toMatchObject({ reason: "RAI_FILTERED" });
    expect((error as any).detail).toContain("safety filter threshold");
    // Threshold prose is not evidence of anything a rewritten prompt answers.
    expect(imageRefusalCategory(error)).toBe("other");
  });

  it("lets an Imagen filter that names IP in words reach the rewrite path", async () => {
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" });
    (adapter as any).ai = {
      models: {
        generateImages: async () => ({
          generatedImages: [
            {
              raiFilteredReason:
                "The image was filtered because the prompt names a copyrighted character. Support codes: 29310472"
            }
          ]
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(true);
    expect(imageRefusalCategory(error)).toBe("copyright");
  });

  it("records an Imagen score table as diagnostics rather than as a reason", async () => {
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" });
    (adapter as any).ai = {
      models: {
        generateImages: async () => ({
          generatedImages: [
            {
              raiFilteredReason: "All images were filtered out because they violated the usage guidelines.",
              safetyAttributes: { categories: ["Celebrity", "  "], scores: [0.9] }
            }
          ],
          positivePromptSafetyAttributes: { categories: ["Violence"], scores: [0.7] }
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

    // The sentence names neither category, so neither is the filter speaking
    // about this block and neither reaches the field the veto tests.
    expect(error).toMatchObject({ reason: "RAI_FILTERED" });
    expect((error as any).detail).toBe("All images were filtered out because they violated the usage guidelines.");
    // The picture's readings and the prompt's stay tellable apart, which is the
    // whole point of reading them separately.
    expect((error as any).diagnostics).toBe("Celebrity=0.9, PROMPT Violence=0.7");
  });

  it("lets a category the Imagen sentence names veto the rewrite the rest of it asked for", async () => {
    // A category inside `raiFilteredReason` is the filter having written the
    // word into its own statement about this request, so a bare word test over
    // it is safe. `Porn` is the case that needs the fold: the prose half spells
    // the harm word `pornograph\w*`, so the sentence alone would slip past it.
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" });
    (adapter as any).ai = {
      models: {
        generateImages: async () => ({
          generatedImages: [
            {
              raiFilteredReason: "Filtered for Porn. The prompt also names a copyrighted character."
            }
          ],
          positivePromptSafetyAttributes: { categories: ["Porn", "Violence"], scores: [0.9, 0.1] }
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(true);
    expect(error).toMatchObject({ reason: "RAI_FILTERED: Porn" });
    expect(imageRefusalCategory(error)).toBe("other");
  });

  it("keeps an Imagen copyright rewrite reachable under a score table that names everything", async () => {
    // `categories` is the provider's standing RAI list and `scores` is the
    // reading it gave each one, so every answer names them all — including
    // `Porn`. Folding them into the reason put that word into every Imagen
    // refusal, and `NEVER_REWRITABLE_CODE` is a bare word test over exactly
    // that field: the veto fired on all of them and the copyright rewrite was
    // unreachable on this provider. Scoring them did not save it — this is the
    // real shape a copyright-blocked prompt came back with, 0.1 on `Porn` and
    // 0.8 on a category that had nothing to do with the block.
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" });
    (adapter as any).ai = {
      models: {
        generateImages: async () => ({
          generatedImages: [{ raiFilteredReason: "Filtered: the prompt names a copyrighted character." }],
          positivePromptSafetyAttributes: {
            categories: ["Death, Harm & Tragedy", "Porn", "Violence"],
            scores: [0, 0.1, 0.8],
            contentType: "Positive Prompt"
          }
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ reason: "RAI_FILTERED" });
    expect((error as any).diagnostics).toBe(
      "PROMPT Death, Harm & Tragedy=0, PROMPT Porn=0.1, PROMPT Violence=0.8"
    );
    expect(imageRefusalCategory(error)).toBe("copyright");
  });

  it("still vetoes an Imagen block whose sentence says child safety", async () => {
    // The other direction, and the one the veto exists for: what the filter
    // said about this block outranks a franchise the same sentence names.
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" });
    (adapter as any).ai = {
      models: {
        generateImages: async () => ({
          generatedImages: [
            {
              raiFilteredReason:
                "The prompt was blocked for child safety. It also names a copyrighted character. Support codes: 58061214"
            }
          ],
          positivePromptSafetyAttributes: { categories: ["Porn", "Violence"], scores: [0.1, 0] }
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(true);
    expect(imageRefusalCategory(error)).toBe("other");
  });

  it("takes no reason from the response itself, because the SDK cannot hand one down", async () => {
    // `GenerateImagesResponse` carries `generatedImages`,
    // `positivePromptSafetyAttributes` and `sdkHttpResponse` and nothing else,
    // and `generateImages` rebuilds its answer out of exactly those three — so
    // a top-level RAI reason is a field no Imagen call can produce. Reading one
    // could only ever settle a picture that never arrived as permanently
    // refused, on evidence the SDK had dropped before it got here.
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" });
    (adapter as any).ai = {
      models: {
        generateImages: async () => ({
          raiFilteredReason: "Your current safety filter threshold filtered out 1 output image(s).",
          generatedImages: [{}]
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(false);
    expect((error as Error).message).toContain("did not return image bytes");
  });

  it("leaves an Imagen response that named no filter retryable", async () => {
    // Safety attributes are scores, returned for a drawn picture as readily as
    // for a filtered one. Reading them as a verdict would make an Imagen blip
    // permanent, exactly as a bare STOP once did on the native models.
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" });
    (adapter as any).ai = {
      models: {
        generateImages: async () => ({
          generatedImages: [{ safetyAttributes: { categories: ["Violence"], scores: [0.2] } }],
          positivePromptSafetyAttributes: { categories: ["Violence"], scores: [0.2] }
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Nora." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(false);
    expect((error as Error).message).toContain("did not return image bytes");
  });

  it("finds the filtered Imagen entry by its reason rather than by its index", async () => {
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" });
    (adapter as any).ai = {
      models: {
        generateImages: async () => ({
          generatedImages: [
            {},
            { raiFilteredReason: "Filtered: the prompt names a trademarked character." }
          ]
        })
      }
    };

    const error = await adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((thrown: unknown) => thrown);

    expect(isImageContentRefusalError(error)).toBe(true);
    expect(imageRefusalCategory(error)).toBe("copyright");
  });

  it("rejects reference image requests for Imagen text-to-image models", async () => {
    const adapter = new GeminiImageAdapter({ apiKey: "test-key", imageModel: "imagen-4.0-generate-001" });
    await expect(
      adapter.generateImage({
        prompt: "Illustrate Nora.",
        referenceImagePaths: ["/tmp/nora.png"]
      })
    ).rejects.toThrow(/native Gemini image model/i);
  });
});
