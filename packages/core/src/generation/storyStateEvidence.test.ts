import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { extractStoryState, seedStoryStateFromPromises, withStoryContradictions } from "./storyState.js";
import { pageQualityReportSchema } from "../schemas/book.js";

describe("story contradiction evidence", () => {
  async function extract(reply: unknown, priorMarkdown: string) {
    const model = new FakeTextModelAdapter();
    model.generateJson = async (options) => ({ data: options.schema.parse(reply), text: JSON.stringify(reply), model: "fixture", provider: "fixture" });
    const currentState = seedStoryStateFromPromises(["Find every lantern."]);
    currentState.promises[0] = { ...currentState.promises[0]!, status: "paid", paidAtPage: 18 };
    return extractStoryState({ textModel: model, pageIndex: 20, title: "The last lantern",
      markdown: "Rabbit found the last lantern in the reeds.", summary: "The final lantern is found.", currentState,
      previousPages: [{ index: 18, markdown: priorMarkdown }] });
  }

  it("does not turn a paid-promise marker into an instruction to remove a real lantern", async () => {
    const issue = "The last lantern contradicts the promise being marked paid at page 18.";
    const result = await extract({ storyDelta: {}, contradictions: [issue] }, "Three lanterns were ready to carry uphill.");
    const report = withStoryContradictions(pageQualityReportSchema.parse({ approved: true, score: 95, issues: [], requiredRevisions: [], notes: "The final lantern reveal is correct." }), result.contradictions);
    expect(report.approved).toBe(true);
    expect(report.requiredRevisions).toEqual([]);
    expect(result.unverifiedContradictions).toEqual([issue]);
  });

  it("still blocks a contradiction anchored in actual preceding and current prose", async () => {
    const issue = "A new lantern appears after all four were recovered.";
    const result = await extract({ storyDelta: {}, contradictions: [issue], contradictionEvidence: [{ issue,
      priorPageIndex: 18, priorQuote: "All four lanterns were recovered.", currentQuote: "Rabbit found the last lantern in the reeds." }] }, "All four lanterns were recovered.");
    expect(result.contradictions).toEqual([issue]);
    expect(result.unverifiedContradictions).toEqual([]);
  });

  it("does not accept invented prior quotes or quotes from the wrong page", async () => {
    const issue = "Every lantern was found already.";
    const result = await extract({ storyDelta: {}, contradictions: [issue], contradictionEvidence: [{ issue,
      priorPageIndex: 18, priorQuote: "All four lanterns were recovered.", currentQuote: "Rabbit found the last lantern in the reeds." }] }, "Three lanterns were ready to carry uphill.");
    expect(result.contradictions).toEqual([]);
    expect(result.unverifiedContradictions).toEqual([issue]);
  });
  it("bounds prior prose while preserving both edges and declaring omitted context unknown", async () => {
    const model = new FakeTextModelAdapter();
    let payload: { sourcePages: Array<{ index: number; markdown: string }>; sourceContext: { complete: boolean; omittedPageCount: number } } | undefined;
    model.generateJson = async (options) => {
      payload = JSON.parse(options.messages.find((message) => message.role === "user")!.content);
      return { data: options.schema.parse({ storyDelta: {}, contradictions: [] }), text: "{}", model: "fixture", provider: "fixture" };
    };
    await extractStoryState({ textModel: model, pageIndex: 11, title: "A lantern", markdown: "Rabbit found the final lantern.", summary: "A discovery.", currentState: seedStoryStateFromPromises([]),
      previousPages: Array.from({ length: 10 }, (_, i) => ({ index: i + 1, markdown: `Opening edge ${i}. ${"middle ".repeat(500)} Closing edge ${i}.` })) });
    expect(payload?.sourcePages.map((page) => page.index)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(payload?.sourcePages.every((page) => page.markdown.length <= 1800)).toBe(true);
    expect(payload?.sourcePages[0]?.markdown).toMatch(/^Opening edge 2\./);
    expect(payload?.sourcePages[0]?.markdown).toMatch(/Closing edge 2\.$/);
    expect(payload?.sourceContext).toMatchObject({ complete: false, omittedPageCount: 2 });
  });
});
