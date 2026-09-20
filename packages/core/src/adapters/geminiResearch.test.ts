import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiResearchAdapter } from "./gemini.js";

describe("GeminiResearchAdapter", () => {
  it("attributes only grounded segments to each source, keeping the synthesis separate", async () => {
    const adapter = new GeminiResearchAdapter({ apiKey: "test-key", textModel: "test-model" });
    const first = "The British statute dates to 1880.";
    const second = "The American statute dates to 1918.";
    (adapter as any).ai = { models: { generateContent: async () => ({
      text: `${first} ${second} These changes followed different legal paths.`,
      candidates: [{ groundingMetadata: {
        groundingChunks: ["britain", "america", "unrelated"].map((name) => ({ web: { title: name, uri: `https://example.com/${name}` } })),
        groundingSupports: [
          { segment: { text: first }, groundingChunkIndices: [0] },
          { segment: { text: second }, groundingChunkIndices: [1] }
        ]
      } }]
    }) } };
    const result = await adapter.search({ query: "standard time statutes" });
    expect(result.sources.map((source) => source.summary)).toEqual([first, second, ""]);
    expect(result.summary).toContain("different legal paths");
  });

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
    expect(result.sources[0]?.summary).toBe("");
    expect(result.summary).toContain("A useful reader-facing note");
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

