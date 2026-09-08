import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions } from "../adapters/types.js";
import { SourceAwareTextModel } from "./generation.js";
import { summarizeSource, summarizeSourceOverview } from "./summarization.js";
import { type SourcePassage, type SourceService, sourceCitation } from "./types.js";

const passage: SourcePassage = { sourceId: "source1", version: 3, ordinal: 41, name: "Report", locator: "Final section", content: "In 2047 the observatory closed. ORCHID-913 opened the archive." };
describe("sources through generation", () => {
  it("preserves model summaries beyond 600 characters without retries or truncation", async () => {
    const model = new FakeTextModelAdapter();
    const expected = "Important detail. ".repeat(45) + "ENDING-FACT";
    vi.spyOn(model, "generateJson").mockResolvedValue({ data: { summary: expected }, text: "", model: "fixture", provider: "fixture" });
    const summary = await summarizeSource("Full source content", model);
    expect(summary.length).toBeGreaterThan(600);
    expect(summary).toBe(expected);
    expect(model.generateJson).toHaveBeenCalledTimes(1);
  });
  it.each(["planner", "chapter-brief", "generate-page", "compose-chapter", "continue-book", "page-rewrite", "page-qa", "chapter-review"])("supplies deep evidence to %s and its bound model", async (purpose) => {
    const inner = new FakeTextModelAdapter();
    const generate = vi.spyOn(inner, "generateText");
    const service: SourceService = { overview: async () => [], search: async () => [passage], read: async () => passage };
    const wrapper = new SourceAwareTextModel(inner, async () => service);
    const bound = await wrapper.bindForCall(purpose);
    await bound.adapter.generateText({ purpose, messages: [{ role: "user", content: "Describe the observatory closure" }] });
    const prompt = JSON.stringify(generate.mock.calls[0]![0].messages);
    expect(prompt).toContain("ORCHID-913");
    expect(prompt).toContain(sourceCitation(passage));
    expect(prompt).not.toContain("https://");
  });
  it("gives a reviewer the precise passage cited by its candidate even when search ranks something else", async () => {
    const inner = new FakeTextModelAdapter();
    const generate = vi.spyOn(inner, "generateText");
    const read = vi.fn(async () => passage);
    const service: SourceService = { overview: async () => [], search: async () => [], read };
    await new SourceAwareTextModel(inner, async () => service).generateText({ purpose: "page-qa", messages: [{ role: "user", content: `The archive closed in 2047. ${sourceCitation(passage)}` }] });
    expect(read).toHaveBeenCalledWith("source1", 3, 41);
    expect(JSON.stringify(generate.mock.calls[0]![0].messages)).toContain("ORCHID-913");
  });
  it("includes all section summaries in the hierarchical document summary", async () => {
    class SummaryModel extends FakeTextModelAdapter {
      calls: string[] = [];
      override async generateJson<T>(options: GenerateJsonOptions<T>) {
        const content = options.messages.at(-1)!.content;
        this.calls.push(content);
        const summary = content.includes("FINAL-913") ? "Ending: FINAL-913" : "Earlier sections";
        return { data: options.schema.parse({ summary }), text: JSON.stringify({ summary }), provider: "fixture", model: "fixture" };
      }
    }
    const model = new SummaryModel();
    const sections = Array.from({ length: 70 }, (_, index) => `${index}: ${"earlier material ".repeat(35)}${index === 69 ? "FINAL-913" : ""}`);
    expect(await summarizeSourceOverview(sections, model)).toContain("FINAL-913");
    for (const section of sections) expect(model.calls.some((call) => call.includes(section))).toBe(true);
    expect(model.calls.length).toBeGreaterThan(2);
  });
});
