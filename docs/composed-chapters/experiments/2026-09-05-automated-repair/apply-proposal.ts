/** Zero-provider-call diagnostic: does the captured proposal improve prose when length is assessed separately? */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { FakeTextModelAdapter } from "../../../../packages/core/src/adapters/fake.ts";
import { editManuscriptDevelopment, developmentParagraphs } from "../../../../packages/core/src/generation/developmentalEdit.ts";

const base = "docs/composed-chapters/experiments/2026-09-05-automated-repair";
const input = JSON.parse(readFileSync(`${base}/candidate-1/input.json`, "utf8"));
const response = JSON.parse(readFileSync(`${base}/candidate-1/planner-response.json`, "utf8"));
const out = `${base}/candidate-1-editorial`;
mkdirSync(out);
let calls = 0;
const model = new FakeTextModelAdapter(input.input);
model.generateJson = async (options) => {
  if (++calls > 1 || options.purpose !== "plan-developmental-edit") throw new Error("Unexpected diagnostic call");
  return { data: options.schema.parse(response.data), text: JSON.stringify(response.data), provider: "captured", model: "captured" };
};
const editorialBudget = { ...input.wordBudget, min: Math.floor(input.beforeWords * 0.85) };
const result = await editManuscriptDevelopment({ input: input.input, plan: input.plan, chapters: input.chapters, wordBudget: editorialBudget, textModel: model, mode: "extractive", editableChapterIndexes: input.scope });
const originalParagraphs = new Set(input.chapters.flatMap((chapter: { markdown: string }) => developmentParagraphs(chapter.markdown)));
if (result.chapters.some((chapter) => developmentParagraphs(chapter.markdown).some((paragraph) => !originalParagraphs.has(paragraph)))) throw new Error("Introduced prose");
const format = (chapters: Array<{ index: number; title: string; markdown: string }>) => chapters.filter((chapter) => [6, 7].includes(chapter.index)).map((chapter) => `## Chapter ${chapter.index}: ${chapter.title}\n\n${chapter.markdown}`).join("\n\n") + "\n";
writeFileSync(`${out}/original.md`, format(input.chapters));
writeFileSync(`${out}/revised.md`, format(result.chapters));
writeFileSync(`${out}/result.json`, JSON.stringify({ ...result, requestedBudget: input.wordBudget, editorialBudget, paidCalls: 0, limitation: "Diagnostic only. This proposal fails the real requested length floor and is not eligible for publication." }, null, 2) + "\n");
console.log(JSON.stringify({ before: result.beforeWords, after: result.afterWords, applied: result.appliedGroups, rejected: result.rejectedGroups, realLengthShortfall: Math.max(0, input.wordBudget.min - result.afterWords) }));
