/**
 * Validates the chapter judge against the blind panel: for two runs the panel
 * ranked, pair chapters by position and count how often the judge prefers the
 * higher-scored book's chapter. Runs where the worker's provider keys are:
 *
 *   docker exec ai-book-maker-worker-1 pnpm -F @book-maker/worker exec tsx scripts/judge-validation.ts composed-3 composed-2
 */
import { readFileSync } from "node:fs";
import {
  createLiveGenerationTextModel,
  judgeChapterDrafts,
  type BookPlan,
  type ChapterPlan,
  type CreateProjectInput
} from "@book-maker/core";
import { config } from "../src/runtime/config.js";
import { loadLiveGenerationTextRouting } from "../src/providers/generationTextRouting.js";

const [better, worse] = process.argv.slice(2);
if (!better || !worse) {
  console.error("usage: judge-validation.ts <better label> <worse label>");
  process.exit(1);
}

function chapters(label: string): { title: string; markdown: string }[] {
  const markdown = readFileSync(`../../.scratch/composed-chapters/runs/${label}/book.md`, "utf8");
  return markdown
    .split(/^(?=## Chapter \d+)/m)
    .filter((part) => part.startsWith("## Chapter"))
    .map((part) => ({ title: part.split("\n")[0]!.replace(/^## /, ""), markdown: part }));
}

const judge = createLiveGenerationTextModel(config, {
  tier: "balanced",
  fastJudgments: true,
  loadRouting: loadLiveGenerationTextRouting({ filePath: "", append: async () => "" })
});
const input = { prompt: "Aggression through time", temperature: 0.4 } as unknown as CreateProjectInput;
const plan = { title: "Aggression Through Time", audience: "general readers" } as unknown as BookPlan;

const a = chapters(better);
const b = chapters(worse);
const pairs = Math.min(a.length, b.length);
let preferredBetter = 0;
let preferredWorse = 0;
let disagreed = 0;
for (let index = 0; index < pairs; index += 1) {
  const chapter = { index: index + 1, title: a[index]!.title } as unknown as ChapterPlan;
  // Alternate which book is draft A so a position bias cannot pass as agreement.
  const swapped = index % 2 === 1;
  const drafts = swapped ? [b[index]!.markdown, a[index]!.markdown] : [a[index]!.markdown, b[index]!.markdown];
  const verdict = await judgeChapterDrafts({ input, plan, chapter, drafts, judge });
  const pickedBetter = verdict.agreed && (swapped ? verdict.pick === 1 : verdict.pick === 0);
  if (!verdict.agreed) disagreed += 1;
  else if (pickedBetter) preferredBetter += 1;
  else preferredWorse += 1;
  console.log(
    `${index + 1}\t${verdict.agreed ? (pickedBetter ? better : worse) : "disagreed"}\t${verdict.reasons[0] ?? ""}`
  );
}
console.log(`\n${better} over ${worse}: ${preferredBetter}/${pairs} preferred better, ${preferredWorse} preferred worse, ${disagreed} disagreed`);
process.exit(0);
