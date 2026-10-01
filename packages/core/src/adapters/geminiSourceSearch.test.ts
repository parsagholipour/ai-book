import { describe, expect, it, vi } from "vitest";
import { GeminiResearchAdapter, RESEARCH_MAX_OUTPUT_TOKENS } from "./gemini.js";

it("uses the existing Google search provider to discover originals for a dossier", async () => {
  const generateContent = vi.fn(async () => ({ text: "No accessible original found.", candidates: [] }));
  const adapter = new GeminiResearchAdapter({ apiKey: "fixture", textModel: "configured-model" });
  Object.assign(adapter, { ai: { models: { generateContent } } });
  await adapter.search({ query: "RSA paper", purpose: "case-source-search", projectId: "p" });
  expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({ model: "configured-model",
    contents: expect.stringContaining("Cite direct original document URLs"), config: expect.objectContaining({ tools: [{ googleSearch: {} }] }) }));
  generateContent.mockClear();
  await adapter.search({ query: "RSA background", projectId: "p" });
  expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({ contents: expect.stringContaining("Find concise, source-backed factual background") }));
});

describe("grounded search request", () => {
  function adapterFor(textModel: string, response: Record<string, unknown> = { text: "Notes.", candidates: [] }) {
    const generateContent = vi.fn(async (_request: { config: Record<string, unknown> }) => response);
    const adapter = new GeminiResearchAdapter({ apiKey: "fixture", textModel });
    Object.assign(adapter, { ai: { models: { generateContent } } });
    return { adapter, generateContent };
  }

  it.each(["gemini-2.5-flash", "gemini-2.5-flash-lite", "models/gemini-2.5-flash-preview-09-2025"])(
    "turns thinking off on %s, keeping the search tool, temperature and deadline",
    async (model) => {
      const { adapter, generateContent } = adapterFor(model);
      await adapter.search({ query: "ISO 1161 corner fittings", purpose: "case-source-search" });
      const config = generateContent.mock.calls[0]![0].config;
      expect(config).toMatchObject({
        tools: [{ googleSearch: {} }], temperature: 0.1, thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: RESEARCH_MAX_OUTPUT_TOKENS
      });
      expect(config.abortSignal).toBeInstanceOf(AbortSignal);
    }
  );

  it.each(["gemini-2.5-pro", "gemini-3.5-flash", "gemini-2.5-flash-image", "configured-model"])(
    "leaves %s the request it had, since a zero budget is either invalid there or unmeasured",
    async (model) => {
      const { adapter, generateContent } = adapterFor(model);
      await adapter.search({ query: "RSA paper", purpose: "chapter-research" });
      expect(generateContent.mock.calls[0]![0].config).not.toHaveProperty("thinkingConfig");
      // The output cap is not a thinking setting: every model and purpose carries it.
      expect(generateContent.mock.calls[0]![0].config).toMatchObject({ maxOutputTokens: RESEARCH_MAX_OUTPUT_TOKENS });
    }
  );

  it("reports the searches run and the web sources cited, which is what Google bills", async () => {
    const { adapter } = adapterFor("gemini-2.5-flash", {
      text: "Notes.",
      candidates: [{ groundingMetadata: {
        webSearchQueries: ["a", "b", "c"],
        groundingChunks: [{ web: { title: "One", uri: "https://example.com/1" } }, { retrievedContext: {} }, { web: { title: "Two", uri: "https://example.com/2" } }]
      } }]
    });
    expect((await adapter.search({ query: "q" })).grounding).toEqual({ searchQueries: 3, webSources: 2 });
    const { adapter: ungrounded } = adapterFor("gemini-2.5-flash");
    expect((await ungrounded.search({ query: "q" })).grounding).toEqual({ searchQueries: 0, webSources: 0 });
  });
});

describe("a grounded answer cut off at its output cap", () => {
  function truncatedAdapter(chunks: unknown[]) {
    const adapter = new GeminiResearchAdapter({ apiKey: "fixture", textModel: "gemini-2.5-flash" });
    Object.assign(adapter, { ai: { models: { generateContent: async () => ({
      text: "McLean's first voyage carried 58 containers. The voyage the voyage the voyage",
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: RESEARCH_MAX_OUTPUT_TOKENS },
      candidates: [{ finishReason: "MAX_TOKENS", groundingMetadata: {
        webSearchQueries: ["ideal x 1956"],
        groundingChunks: chunks,
        groundingSupports: [{ segment: { text: "McLean's first voyage carried 58 containers." }, groundingChunkIndices: [0] }]
      } }]
    }) } } });
    return adapter;
  }

  it("keeps its grounded sources and usage, drops the runaway text, and says so", async () => {
    const result = await truncatedAdapter([{ web: { title: "marad.dot.gov", uri: "https://www.maritime.dot.gov/ideal-x" } }])
      .search({ query: "Ideal X", purpose: "chapter-research" });

    expect(result).toMatchObject({
      summary: "",
      truncated: true,
      usage: { promptTokens: 200, outputTokens: RESEARCH_MAX_OUTPUT_TOKENS },
      grounding: { searchQueries: 1, webSources: 1 },
      sources: [{ title: "marad.dot.gov", url: "https://www.maritime.dot.gov/ideal-x", summary: "McLean's first voyage carried 58 containers." }]
    });
  });

  it("returns no stand-in source when the cut answer cited nothing", async () => {
    const result = await truncatedAdapter([]).search({ query: "Ideal X", purpose: "case-source-search" });

    expect(result.sources).toEqual([]);
    expect(result.truncated).toBe(true);
  });
});
