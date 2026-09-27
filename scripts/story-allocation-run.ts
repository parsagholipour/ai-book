import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadWorkspaceEnv } from "../packages/core/src/config.js";
import { OpenAITextAdapter } from "../packages/core/src/adapters/openai.js";
import { FakeTextModelAdapter } from "../packages/core/src/adapters/fake.js";
import type { GenerateJsonOptions, Usage, TextProviderRequest } from "../packages/core/src/adapters/types.js";
import { bookPlanSchema, chapterBriefSchema, createProjectSchema, type TextModelThinkingEffort } from "../packages/core/src/schemas/book.js";
import { generateWholeBookDraft } from "../packages/core/src/generation/pages.js";
import { fingerprint, writeExclusive, assertOracleIsolation, summarizeAttempts, oracleComparisonReadiness } from "./story-allocation-experiment.mjs";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const root = resolve(process.argv[3] ?? ".scratch/story-allocation-controlled-2026-09-27");
const captureRoot = ".scratch/three-tier-flow-audit-2026-09-26-2214/premium";
const originalRun = ".scratch/storybook-text-only-2026-09-26-2214";
const descriptor = (request: GenerateJsonOptions<unknown>) => ({ purpose: request.purpose,
  temperature: request.temperature, maxTokens: request.maxTokens, messages: request.messages });

function sourceHashes() {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z",
    "packages/core", "apps/worker/src", "scripts"], { encoding: "utf8" }).split("\0")
    .filter(path => /\.(ts|mjs|json)$/.test(path));
  return Object.fromEntries([...new Set([...paths, "package.json", "pnpm-lock.yaml"])].sort()
    .map(path => [path, fingerprint(readFileSync(path, "utf8"))]));
}

function briefsFor(pages: unknown[], plan: ReturnType<typeof bookPlanSchema.parse>) {
  return plan.chapters.map(chapter => chapterBriefSchema.parse({ chapterIndex: chapter.index, title: chapter.title,
    summary: chapter.summary, continuityFocus: [],
    pages: pages.filter(page => (page as { chapterIndex: number }).chapterIndex === chapter.index) }));
}

async function prepare() {
  mkdirSync(root, { recursive: true });
  const captured = read(`${originalRun}/round-1-premium/captured.json`);
  const config = captured.jobs.find((job: { type: string }) => job.type === "COMPILE_EXPORT").payload.finalization.configuration;
  const input = createProjectSchema.parse(config.input), plan = bookPlanSchema.parse(config.plan);
  const maps = { original: read(`${captureRoot}/07-generate-whole-book-request.json`).pageMap,
    corrected: read("scripts/testing/story-allocation/premium-corrected-map.json") };
  const requests: Record<string, ReturnType<typeof descriptor>> = {};
  for (const variant of ["original", "corrected"] as const) {
    const model = new FakeTextModelAdapter(), stop = new Error("Capture complete");
    model.generateJson = async request => { requests[variant] = descriptor(request); throw stop; };
    try { await generateWholeBookDraft({ input, plan, chapterBriefs: briefsFor(maps[variant], plan), researchNotes: [], textModel: model }); }
    catch (error) { if (error !== stop) throw error; }
  }
  assertOracleIsolation(requests.original, requests.corrected);
  const route = read(`${originalRun}/manifest.json`).provenance.routing.premium.stages["generate-whole-book"].primary;
  if (route.provider !== "openai") throw new Error("This frozen route requires a different adapter");
  const rubric = {
    gate: "Both corrected-map drafts must improve targeted defects, preserve all explicit brief requirements and introduce no causal contradictions. Otherwise stop map experiments.",
    scoring: "Each defect: 0 absent, 1 partial/ambiguous, 2 definite. Cite pages; also record newly introduced defects and origin (map or writer).",
    defects: {
      turtleSetup: "A limiting habit has an early consequence before a later changed choice; helpfulness alone is insufficient.",
      deadline: "Before-moonrise goal appears before the extended search and is met.",
      direction: "Observed landings justify the predicted search; a new direction has additional evidence or stated reason.",
      location: "Turtle and all searchers move coherently between pages, including bank/rail access.",
      redDelay: "Known false signal is removed promptly or leaving it has a concrete constraint.",
      redundantScenes: "Count pages removable without losing an event, consequence, required transition, meaningful emotion or quiet closure; cite the paired pages.",
      inventoryProse: "Repeated reassurance about unchanged positions/conditions substitutes for story action."
    },
    requirements: ["30 distinct scenes", "Rabbit playful/hasty with consequential growth", "Wise Turtle slow/steady with consequential growth",
      "Storm scatters path lanterns", "Rabbit's solo fix confuses route", "Turtle notices a pattern in actual landing places",
      "Both follow clues and return lanterns", "Escort neighbors before moonrise", "Gentle stakes, no race or generic moral, no extra named main characters"]
  };
  // Counterbalance order while keeping the labels unavailable to the editorial reader.
  const samples = ["original", "corrected", "corrected", "original"].map((variant, index) => ({
    label: randomUUID().slice(0, 8), pair: index < 2 ? 1 : 2, variant
  }));
  writeExclusive(`${root}/oracle-manifest.json`, { version: 1, preparedAt: new Date().toISOString(),
    gitRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sources: sourceHashes(), input, plan, maps, requests, route, rubric, samples,
    providerSettings: { maxRetries: 0, watchdogMs: 600000, concurrency: 1 },
    note: "Current writer over frozen historical final maps; historical critic and map regeneration are not rerun. SDK transport retries disabled equally in both arms; production JSON/output recovery retained." });
  writeExclusive(`${root}/rubric.json`, rubric);
  console.log("Prepared four oracle drafts; no provider requests made.");
}

type Attempt = { status: string; request: TextProviderRequest; usage: Usage[]; startedAt: string; endedAt?: string };

export function measuredAdapter(route: { model: string; thinkingEffort: TextModelThinkingEffort }, directory: string,
  transform: <T>(request: GenerateJsonOptions<T>) => GenerateJsonOptions<T> = request => request) {
  const adapter = new OpenAITextAdapter({ apiKey: process.env.OPENAI_API_KEY, model: route.model,
    thinkingEffort: route.thinkingEffort, maxRetries: 0 });
  const physical: Attempt[] = [];
  let calls = 0;
  const generate = adapter.generateJson.bind(adapter);
  const flush = () => writeFileSync(`${directory}/attempts.json`, JSON.stringify({ physical, summary: summarizeAttempts(physical) }, null, 2) + "\n");
  adapter.generateJson = async request => {
    const effective = transform(request), call = ++calls;
    writeExclusive(`${directory}/call-${call}-request.json`, descriptor(effective));
    let current: Attempt | undefined;
    const started = Date.now();
    try {
      const result = await generate({ ...effective, signal: AbortSignal.timeout(600000),
        onProviderRequest: async event => {
          current = { status: "pending", request: event, usage: [], startedAt: new Date().toISOString() };
          physical.push(current); flush(); await effective.onProviderRequest?.(event);
        },
        onProviderUsage: async event => {
          if (!current) throw new Error("Usage arrived without a physical dispatch");
          current.usage.push(event); flush(); await effective.onProviderUsage?.(event);
        }
      });
      if (current) { current.status = "succeeded"; current.endedAt = new Date().toISOString(); }
      writeExclusive(`${directory}/call-${call}-response.json`, { ...result, ms: Date.now() - started });
      return result;
    } catch (error) {
      if (current) { current.status = "failed"; current.endedAt = new Date().toISOString(); }
      const failure = error as Error & { context?: unknown };
      writeExclusive(`${directory}/call-${call}-error.json`, { name: failure.name, message: failure.message,
        context: failure.context, ms: Date.now() - started });
      throw error;
    } finally { flush(); }
  };
  return { adapter, summary: () => summarizeAttempts(physical) };
}

async function runOracle() {
  const manifest = read(`${root}/oracle-manifest.json`);
  if (fingerprint(sourceHashes()) !== fingerprint(manifest.sources)) throw new Error("Source drift; prepare a fresh experiment directory");
  loadWorkspaceEnv();
  const input = createProjectSchema.parse(manifest.input), plan = bookPlanSchema.parse(manifest.plan);
  for (const sample of manifest.samples) {
    // Exclusive directory creation makes a repeated launch fail before buying duplicates.
    const directory = `${root}/${sample.label}`; mkdirSync(directory);
    let first = true;
    const measured = measuredAdapter(manifest.route, directory, request => {
      if (first && fingerprint(descriptor(request)) !== fingerprint(manifest.requests[sample.variant])) throw new Error("Frozen request changed");
      first = false; return request;
    });
    const started = Date.now();
    console.log(`Starting blinded manuscript ${sample.label}`);
    try {
      const draft = await generateWholeBookDraft({ input, plan, chapterBriefs: briefsFor(manifest.maps[sample.variant], plan),
        researchNotes: [], textModel: measured.adapter });
      if (draft.pages.length !== 30 || draft.pages.some((page, index) => page.index !== index + 1 || !page.markdown.trim())) throw new Error("Invalid 30-page manuscript");
      writeExclusive(`${directory}/draft.json`, draft);
      writeFileSync(`${directory}/book.md`, draft.pages.map(page => `## Page ${page.index}: ${page.title}\n\n${page.markdown}`).join("\n\n") + "\n", { flag: "wx" });
      writeExclusive(`${directory}/result.json`, { status: "completed", ms: Date.now() - started, usage: measured.summary() });
      console.log(`Completed ${sample.label}: ${measured.summary().totalTokens} tokens`);
    } catch (error) {
      writeExclusive(`${directory}/result.json`, { status: "failed", ms: Date.now() - started,
        message: (error as Error).message, usage: measured.summary() });
      console.log(`Failed ${sample.label}; retained attempt records, no replacement sample.`);
    }
  }
  const samples = manifest.samples.map((sample: { label: string }) => ({ ...sample,
    result: read(`${root}/${sample.label}/result.json`) }));
  const readiness = oracleComparisonReadiness(samples);
  writeExclusive(`${root}/oracle-completion.json`, { samples, readiness });
  console.log(readiness.reason);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, "story-allocation-run.ts")) {
  if (process.argv[2] === "prepare") await prepare();
  else if (process.argv[2] === "oracle") await runOracle();
  else throw new Error("Usage: tsx scripts/story-allocation-run.ts prepare|oracle [output-directory]");
}
