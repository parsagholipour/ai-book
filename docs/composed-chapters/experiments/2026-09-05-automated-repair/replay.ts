/** Offline paid replay: reads stored plans and logs calls; never changes a manuscript or queues a job. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  bindTextModelCall, bookPlanSchema, chapterWordBudget, createProjectSchema, createProviders,
  type TextModelAdapter
} from "../../../../packages/core/src/index.ts";
import { editManuscriptDevelopment, developmentParagraphs } from "../../../../packages/core/src/generation/developmentalEdit.ts";
import { countReadableWords } from "../../../../packages/core/src/generation/proseShape.ts";
import { prisma } from "../../../../packages/db/src/index.ts";
import { createLoggedProviders } from "../../../../apps/worker/src/providers/loggedAdapters.ts";
import { config } from "../../../../apps/worker/src/runtime/config.ts";
import type { WorkerRuntimeJob } from "../../../../apps/worker/src/runtime/jobPayloads.ts";

if (config.MOCK_AI) throw new Error("Replay needs the real configured writer");
const label = process.argv[2];
if (!label || !/^[a-z0-9-]+$/.test(label)) throw new Error("Provide a new experiment label");
const projectId = process.argv[3] ?? "cmtnwyp3d0000fwg07qgd68uo";
const sourcePath = process.argv[4] ?? "docs/composed-chapters/runs/development-fixes-1d/book.md";
const scope = (process.argv[5] ?? "6,7,8").split(",").map(Number);
const crossChapterCasesOnly = process.argv.includes("--cross-chapter");
const base = "docs/composed-chapters/experiments/2026-09-05-automated-repair";
const out = join(base, label);
mkdirSync(out);
const started = new Date();
const runId = `development-replay-${label}-${started.getTime()}`;
const attempts: Array<{ purpose?: string; selection?: unknown }> = [];
const write = (file: string, data: unknown) => writeFileSync(join(out, file), JSON.stringify(data, null, 2) + "\n");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

try {
  const row = await prisma.planVersion.findFirstOrThrow({ where: { projectId }, orderBy: { version: "desc" }, select: { id: true, inputSnapshot: true, planningPackage: true } });
  const input = createProjectSchema.parse(row.inputSnapshot);
  const plan = bookPlanSchema.parse(row.planningPackage);
  const source = readFileSync(sourcePath, "utf8");
  const chapters = [...source.matchAll(/^## Chapter (\d+): ([^\n]+)\n([\s\S]*?)(?=^## Chapter \d+:|$(?![\s\S]))/gm)].map((match) => ({ index: Number(match[1]), title: match[2]!.trim(), markdown: match[3]!.trim() }));
  if (chapters.length !== plan.chapters.length || scope.some((index) => !chapters.some((chapter) => chapter.index === index))) throw new Error("Manuscript and plan chapter coverage disagree");
  const wordBudget = plan.chapters.map((chapter) => chapterWordBudget(input, chapter.targetPages)).reduce((a, b) => ({ min: a.min + b.min, target: a.target + b.target, max: a.max + b.max }), { min: 0, target: 0, max: 0 });
  const settings = await prisma.generationQualityRevision.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
  write("input.json", { runId, projectId, planId: row.id, sourcePath, sourceHash: hash(source), scope, mode: "extractive", qualityRevision: settings?.version, wordBudget, beforeWords: chapters.reduce((sum, chapter) => sum + countReadableWords(chapter.markdown), 0), input, plan, chapters });
  const providers = createLoggedProviders({ id: runId, name: "development-replay", data: { projectId } } as WorkerRuntimeJob, createProviders(config, input), input);
  function bounded(adapter: TextModelAdapter, selection?: unknown): TextModelAdapter {
    return {
      generateText: () => { throw new Error("Replay forbids prose generation"); },
      streamText: async function* () { throw new Error("Replay forbids prose generation"); },
      generateWithTools: () => { throw new Error("Replay forbids tools generation"); },
      bindForCall: async (purpose) => { const bound = await bindTextModelCall(adapter, purpose); return { ...bound, adapter: bounded(bound.adapter, bound.selection) }; },
      generateJson: async (options) => {
        if (options.purpose !== "plan-developmental-edit" || attempts.length >= 2) throw new Error("Replay reached its two-attempt planning cap");
        attempts.push({ purpose: options.purpose, selection });
        write("attempts.json", attempts);
        const response = await adapter.generateJson(options);
        write("planner-response.json", response);
        return response;
      }
    };
  }
  const result = await editManuscriptDevelopment({ input, plan, chapters, wordBudget, textModel: bounded(providers.text), mode: "extractive", editableChapterIndexes: scope, crossChapterCasesOnly });
  const originals = new Set(chapters.flatMap((chapter) => developmentParagraphs(chapter.markdown)));
  const introduced = result.chapters.flatMap((chapter) => developmentParagraphs(chapter.markdown)).filter((paragraph) => !originals.has(paragraph));
  if (introduced.length) throw new Error("Extractive output introduced prose");
  if (hash(readFileSync(sourcePath, "utf8")) !== hash(source)) throw new Error("Source changed during replay");
  write("result.json", { ...result, runId, attempts: attempts.length, elapsedMs: Date.now() - started.getTime(), introducedParagraphs: introduced.length });
  const format = (items: typeof chapters) => items.map((chapter) => `## Chapter ${chapter.index}: ${chapter.title}\n\n${chapter.markdown}`).join("\n\n") + "\n";
  writeFileSync(join(out, "original-excerpt.md"), format(chapters.filter((chapter) => scope.includes(chapter.index))));
  writeFileSync(join(out, "revised-excerpt.md"), format(result.chapters.filter((chapter) => scope.includes(chapter.index))));
  console.log(JSON.stringify({ runId, wordBudget, beforeWords: result.beforeWords, afterWords: result.afterWords, appliedGroups: result.appliedGroups, rejectedGroups: result.rejectedGroups, attempts: attempts.length }));
} catch (error) {
  write("failure.json", { runId, attempts: attempts.length, error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  const calls = await prisma.providerCallLog.findMany({ where: { projectId, createdAt: { gte: started }, purpose: { in: ["plan-developmental-edit", "rewrite-developmental-sections"] } }, select: { id: true, provider: true, model: true, purpose: true, promptTokens: true, outputTokens: true, costHint: true, durationMs: true, metadata: true } });
  write("provider-calls.json", calls);
  await prisma.$disconnect();
}
