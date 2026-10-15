import { describe, expect, it } from "vitest";
import { parseManuscript } from "./manuscriptImport.js";

const CHAPTERS = [
  { title: "雨の夜", text: "静かな村に雨が降っていた。" },
  { title: "朝の光", text: "夜明けが来た。" }
];

function manuscript(contents: string): Buffer {
  return Buffer.from(
    `# 春の風\n\n## 目次\n\n${contents}\n\n${CHAPTERS.map(({ title, text }) => `## ${title}\n\n${text}`).join("\n\n")}`
  );
}

describe("imported contents page numbers", () => {
  it.each([
    { script: "ASCII", first: "1", second: "12" },
    { script: "fullwidth", first: "１", second: "１２" },
    { script: "Arabic", first: "١", second: "١٢" },
    { script: "Persian", first: "۱", second: "۱۲" },
    { script: "Devanagari", first: "१", second: "१२" }
  ])("removes contents using $script page numbers and short headings", async ({ first, second }) => {
    const parsed = await parseManuscript({
      data: manuscript(`雨の夜 ${first}\n\n朝の光 ··· ${second}`),
      format: "text"
    });

    expect(parsed.matterRemoved).toContain("contents");
    expect(parsed.sections).toEqual(CHAPTERS);
  });

  it("removes the original single-entry fullwidth contents page", async () => {
    const parsed = await parseManuscript({ data: manuscript("雨の夜 １"), format: "text" });

    expect(parsed.matterRemoved).toContain("contents");
    expect(parsed.sections).toEqual(CHAPTERS);
  });

  it("preserves a contents section containing real body text beside a matching numbered entry", async () => {
    const body = "雨の夜 １\n\nまだ誰も知らない物語が始まった。";
    const parsed = await parseManuscript({ data: manuscript(body), format: "text" });

    expect(parsed.matterRemoved ?? []).not.toContain("contents");
    expect(parsed.sections).toEqual([{ title: "目次", text: body }, ...CHAPTERS]);
  });
});
