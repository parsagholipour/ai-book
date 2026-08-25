import { ThinkingLevel } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { GeminiImageAdapter, GeminiResearchAdapter, GeminiTextAdapter } from "./gemini.js";

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
