import { expect, it, vi } from "vitest";
import { GeminiResearchAdapter } from "./gemini.js";

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
