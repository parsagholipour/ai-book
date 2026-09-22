import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema } from "../schemas/book.js";
import { generateAuthorStance } from "./authorStance.js";
import { fallbackChapterComposition, formPaletteFor } from "./chapterForms.js";
import { cutChapter } from "./composedChapter.js";
import { deletionOnlyResult } from "./composedChapterCuts.js";
import { paginateChapterMarkdown } from "./chapterPagination.js";

const prose = "The receiver checks the signature using the public key. The private key stays with the sender. ".repeat(8).trim();
const code = "```pseudocode\nSIGN_PAYLOAD(message):\n    digest = HASH(message)\n\n    return SIGN(digest)\n```";

describe("deletion-only cuts retain Markdown structure", () => {
  it("keeps both code fences intact through an accepted cut and pagination", () => {
    const second = code.replaceAll("SIGN", "VERIFY");
    const kept = [prose, code, prose, second, prose].join("\n\n");
    const result = deletionOnlyResult(`${kept}\n\nThis repeats the conclusion.`, kept);
    expect(result).toBe(kept);
    const pages = paginateChapterMarkdown(result!, 4).pages;
    for (const block of [code, second]) expect(pages.some((page) => page.includes(block))).toBe(true);
    for (const page of pages) expect((page.match(/^```/gm) ?? []).length % 2).toBe(0);
  });

  it.each([
    "| Job | Key |\n| --- | --- |\n| Sign | Private |\n| Verify | Public |",
    "$$\n5^6 \\bmod 23 = 8\n$$",
    "- First step\n  - Nested detail\n- Second step",
    "    let value = 2;\n    return value;",
    "~~~~js\nconst fence = '```';\n\n  return fence;\n~~~~"
  ])("restores original formatting instead of accepting candidate whitespace changes: %s", (block) => {
    const draft = [prose, block, "This repeats the conclusion."].join("\n\n");
    const candidate = [prose, block.replace(/\s+/g, " ").trim()].join("\n\n");
    expect(deletionOnlyResult(draft, candidate)).toBe([prose, block].join("\n\n"));
  });

  it("refuses partial deletions inside structured blocks", () => {
    const block = "```text\nA first sentence.\n\nA second sentence.\n```";
    const draft = [prose, block].join("\n\n");
    expect(deletionOnlyResult(draft, draft.replace("A first sentence.\n\n", ""))).toBeUndefined();
  });

  it.each([
    ["indented code", "    Print this sentence. Print that sentence.", "    Print that sentence."],
    ["a list item", "- A first sentence. A second sentence.", "A second sentence."],
    ["emphasis", "**A first sentence. A second sentence.**", "**A first sentence."],
    ["inline code", "`A first sentence. A second sentence.`", "`A first sentence."],
    ["inline math", "$\\text{A first sentence. A second sentence.}$", "$\\text{A first sentence."],
    ["bracket-delimited math", "\\(\\text{A first sentence. A second sentence.}\\)", "\\(\\text{A first sentence."]
  ])("refuses a sentence cut that breaks %s on a single line", (_, original, candidate) => {
    expect(deletionOnlyResult(`${prose}\n\n${original}`, `${prose}\n\n${candidate}`)).toBeUndefined();
  });

  it("allows prose deletions beside intact inline formatting and math", () => {
    const kept = "The **private key** signs the `message` and the public key verifies it. The modulus is $n$ with totient $\\phi(n)$.";
    const candidate = `${prose}\n\n${kept}`;
    expect(deletionOnlyResult(`${candidate} This repeats the conclusion.`, candidate)).toBe(candidate);
  });

  it.each([
    { label: "valid", malformed: false },
    { label: "malformed", malformed: true }
  ])("keeps Markdown through cutChapter with a $label provider cut", async ({ malformed }) => {
    const input = createProjectSchema.parse({ prompt: "Explain public key signatures and verification.", category: "SCIENCE", targetPages: 20 });
    const plan = makeFallbackPlan(input);
    const chapter = plan.chapters[0]!;
    const textModel = new FakeTextModelAdapter(input);
    const stance = await generateAuthorStance({ input, plan, textModel });
    const composition = fallbackChapterComposition({ chapter, startPage: 1, endPage: 1 }, formPaletteFor("analytical-history"), 0);
    const formatted = "**A first sentence. A second sentence.**";
    const kept = [Array.from({ length: 6 }, () => prose).join("\n\n"), code, formatted].join("\n\n");
    const markdown = `${kept}\n\nThis repeats the conclusion.`;
    const reply = malformed ? kept.replace(formatted, "**A first sentence.") : kept;
    const request = vi.spyOn(textModel, "generateText").mockResolvedValue({ text: reply, model: "fake", provider: "fake" });
    const result = await cutChapter({
      input, plan, chapter, composition, stance, textModel, markdown,
      chapterPageStart: 1, chapterPageEnd: 1, earlierChapters: [], continuityNotes: [], researchNotes: [],
      notes: ["Remove the redundant conclusion."], semanticAcceptance: false
    });
    expect(request).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ changed: !malformed, markdown: malformed ? markdown : kept });
    expect(result.markdown).toContain(code);
  });
});
