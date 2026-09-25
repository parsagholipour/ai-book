import { describe, expect, it, vi } from "vitest";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { repairPictureBookManuscript } from "./pictureBookRepair.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle restore the lantern path.", category: "KIDS", targetPages: 5 });
const plan = makeFallbackPlan(input);
const pages = [
  { index: 1, title: "Matches", markdown: "Turtle carried four dry matches.", summary: "Four matches." },
  { index: 2, title: "Storm", markdown: "The storm put every flame out.", summary: "All lanterns dark." },
  { index: 3, title: "A Lantern", markdown: "Rabbit hung the glowing lantern. He waved to Turtle.", summary: "A lantern glows." },
  { index: 4, title: "The First Flame", markdown: "Turtle lit the first lantern. Three matches remained.", summary: "First match used." },
  { index: 5, title: "Picnic", markdown: "The neighbors reached the picnic together.", summary: "The end." }
];
const row = { pageIndex: 3, reason: "The first lighting occurs on the next page.", summary: "Rabbit hangs a dark lantern.",
  patches: [{ find: "the glowing lantern", replace: "the dark lantern" }] };
const setup = (answer: unknown = { pages: [row] }) => {
  const generateJson = vi.fn(async <T>(options: GenerateJsonOptions<T>) => ({ data: options.schema.parse(answer), text: JSON.stringify(answer) }));
  const options = { input, plan, pages, issues: [{ pageIndexes: [3], messages: ["Page 3 glows before the first lighting on page 4."] }],
    textModel: { generateJson } as unknown as TextModelAdapter };
  return { generateJson, run: () => repairPictureBookManuscript(options) };
};

describe("coordinated picture-book repair", () => {
  it("uses one frozen full manuscript and preserves every byte outside the exact repair", async () => {
    const { run, generateJson } = setup();
    const result = await run();
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(generateJson.mock.calls[0]![0]).toMatchObject({ purpose: "revise-page", maxTokens: 12_000 });
    expect(JSON.parse(generateJson.mock.calls[0]![0].messages[1]!.content).pages).toEqual(pages);
    expect(result.pages[2]).toEqual({ ...pages[2], markdown: "Rabbit hung the dark lantern. He waved to Turtle.", summary: row.summary });
    expect(result.pages.filter((page) => page.index !== 3)).toEqual(pages.filter((page) => page.index !== 3));
    expect(result.context.changes).toEqual([{ pageIndex: 3, reason: row.reason, originalMarkdown: pages[2]!.markdown }]);
    expect(pages[2]!.markdown).toContain("glowing");
  });

  it.each([
    { pages: [row, row] },
    { pages: [{ ...row, pageIndex: 20 }] },
    { pages: [row, { ...row, pageIndex: 4, patches: [{ find: "missing text", replace: "new prose" }] }] },
    { pages: [{ ...row, patches: [{ find: "the  glowing lantern", replace: "the dark lantern" }] }] },
    { pages: [{ ...row, patches: [...row.patches, { find: "glowing", replace: "dark" }] }] }
  ])("rejects the entire candidate when any page or exact span is invalid", async (answer) => {
    const { run, generateJson } = setup(answer);
    await expect(run()).rejects.toThrow(/Picture-book repair/);
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(pages[2]!.markdown).toContain("glowing");
  });

  it("may decline without inventing a replacement scene", async () => {
    const result = await setup({ pages: [] }).run();
    expect(result.pages).toEqual(pages);
    expect(result.context.changes).toEqual([]);
  });
});
