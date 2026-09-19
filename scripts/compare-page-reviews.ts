/** Saved-example replay. No production settings, books, or review labels are changed. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { decisionFixtures } from "./fixtures/fast-decisions.js";
import { withRecoverableNetworkRetry } from "../packages/core/src/adapters/retry.js";
import type { Usage } from "../packages/core/src/adapters/types.js";
import type { PageQualityReport } from "../packages/core/src/schemas/book.js";
import { createTextModelAdapter } from "../packages/core/src/adapters/factory.js";
import { FakeTextModelAdapter } from "../packages/core/src/adapters/fake.js";
import { createDecisionModelRoute } from "../packages/core/src/adapters/decisionRouting.js";
import { calculateTextGenerationCost } from "../packages/core/src/costs.js";
import { compiledGenerationTextModelRouting, JEV_SELECTION } from "../packages/core/src/adapters/generationTextModelRouting.js";
import { loadConfig } from "../packages/core/src/config.js";
import { makeFallbackPlan } from "../packages/core/src/prompting/templates.js";
import { createProjectSchema } from "../packages/core/src/schemas/book.js";
import { reviewPageDraft, type ReviewPageOptions } from "../packages/core/src/generation/pagesReview.js";
import { summarizePageReviewObservations, savedPageReviewFixturesSchema, savedReviewPagesSchema, type SavedPageReviewFixture } from "../packages/core/src/generation/pageReviewEvaluation.js";
import type { DecisionOutcome } from "../packages/core/src/adapters/decisions.js";
import type { DecisionEvaluationAttempt } from "../packages/core/src/adapters/decisionEvaluationRouting.js";

const flag = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const live = process.argv.includes("--live");
const config = { ...loadConfig(), MOCK_AI: !live };
const routing = compiledGenerationTextModelRouting(config, []);
type Fixture = SavedPageReviewFixture;
const fixturesPath = flag("--fixtures");
const fixtures: Fixture[] = [];
if (fixturesPath) fixtures.push(...savedPageReviewFixturesSchema.parse(JSON.parse(await readFile(fixturesPath, "utf8"))));
else if (process.argv.includes("--synthetic")) {
  for (const fixture of decisionFixtures.filter((fixture) => fixture.id.startsWith("opening-"))) {
    const input = createProjectSchema.parse({ prompt: fixture.request.context, category: "STORY", targetPages: 2, language: fixture.language, mediaSettings: {} });
    const plan = makeFallbackPlan(input);
    const pageBrief = { pageIndex: 1, chapterIndex: 1, purpose: fixture.request.context, beat: fixture.request.context, requiredContinuity: [], endingPressure: fixture.language === "fa" ? "به سوی فانوس دریایی راه می‌افتد." : "She leaves for the lighthouse." };
    const chapterBrief = { chapterIndex: 1, title: "Ledger", summary: fixture.request.context, continuityFocus: [], pages: [pageBrief, { ...pageBrief, pageIndex: 2, purpose: "Resolve who authorized the duplicate payment", beat: "At the lighthouse, evidence identifies who authorized the payment.", endingPressure: "The investigator secures the evidence." }] };
    for (const candidate of fixture.request.options) fixtures.push({ id: `${fixture.id}:${candidate.id}`, provenance: "scripts/fixtures/fast-decisions.ts; saved synthetic prose with an explicitly constructed two-page review assignment; no human label; configurable length/style local gates disabled for excerpt smoke only, mandatory opening and screen integrity retained", options: {
      input, plan, pageIndex: 1, pageBrief, chapterBrief, chapterPageStart: 1, chapterPageEnd: 2, previousPages: [], continuityNotes: [],
      draft: { title: "Ledger", markdown: candidate.description, summary: fixture.request.context, continuityNotes: [] }
    } });
  }
} else {
  // Actual saved prose, without inventing missing production briefs or treating status as a verdict.
  for (const run of ["composed-13-fast", "composed-12-balanced", "legacy-cuts-7b"]) {
    const path = `docs/composed-chapters/runs/${run}/pages.json`;
    const pages = savedReviewPagesSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const input = createProjectSchema.parse({ prompt: "Aggression Through Time", category: "CUSTOM", targetPages: pages.length, language: "en", mediaSettings: {} });
    const plan = makeFallbackPlan(input);
    for (const index of [1, 2, Math.ceil(pages.length / 2), pages.length]) {
      const page = pages.find((entry) => entry.index === index)!;
      fixtures.push({ id: `${run}:${index}`, provenance: `${path}; saved composed manuscript, production brief and model-page verdict unavailable`,
        options: { input, plan, pageIndex: index, draft: { ...page, continuityNotes: [] }, previousPages: pages.filter((entry) => entry.index < index).slice(-5), nextPages: pages.filter((entry) => entry.index > index).slice(0, 2), continuityNotes: [] } });
    }
  }
}
const { sourceRefsFromInput } = await import("../packages/core/src/sources/types.js");
if (fixtures.some((fixture) => sourceRefsFromInput(fixture.options.input).length)) throw new Error("Private-source replays require an authorized SourceAwareTextModel; this standalone harness cannot load private sources.");
const records = [];
for (const fixture of fixtures) {
  let outcome: DecisionOutcome | undefined;
  const attempts: DecisionEvaluationAttempt[] = [];
  let diagnosticCalls = 0;
  let diagnosticReport: PageQualityReport | undefined;
  const diagnosticAttempts: Array<{ durationMs: number; usage?: Usage | undefined; costUsd: number | null; error?: string | undefined }> = [];
  const route = createDecisionModelRoute(config, { loadRouting: async () => ({ ...routing, fastDecisions: JEV_SELECTION }),
    onEvaluationAttempt: async (attempt) => { attempts.push(attempt); } });
  const delegate = live ? createTextModelAdapter(config, routing.fastJudgments, { maxRetries: 0 }) : new FakeTextModelAdapter();
  const generateJson = delegate.generateJson.bind(delegate);
  delegate.generateJson = async (options) => withRecoverableNetworkRetry(async () => {
    options.signal?.throwIfAborted();
    diagnosticCalls++;
    const at = performance.now();
    try {
      const result = !live && fixture.frozenReview
        ? { data: options.schema.parse(fixture.frozenReview), text: JSON.stringify(fixture.frozenReview), provider: "frozen", model: "saved-review", usage: undefined }
        : await generateJson(options);
      diagnosticAttempts.push({ durationMs: performance.now() - at, usage: result.usage, costUsd: !live ? 0 : result.usage?.promptTokens === undefined ? null : calculateTextGenerationCost({ ...result, ...result.usage }) });
      return result;
    } catch (caught) {
      diagnosticAttempts.push({ durationMs: performance.now() - at, costUsd: null, error: caught instanceof Error ? caught.name : "UnknownError" });
      throw caught;
    }
  });
  const options: ReviewPageOptions = { ...fixture.options, textModel: delegate, skipLocalChecks: process.argv.includes("--synthetic"), pageReviewDecisionMode: "shadow", signal: AbortSignal.timeout(60_000),
    decisions: { ...route, recordOutcome: async (value) => { outcome = value; } } };
  const started = performance.now();
  let error: string | undefined;
  try { diagnosticReport = await reviewPageDraft(options); } catch (caught) { error = caught instanceof Error ? caught.name : "UnknownError"; }
  const elapsedMs = performance.now() - started;
  // A mock approval is never a reviewer comparison.
  if (!live && !fixture.frozenReview && outcome) { delete outcome.disagreement; delete outcome.diagnosticApproved; }
  records.push({ id: fixture.id, provenance: fixture.provenance, outcome, elapsedMs, diagnosticCalls, adjudication: fixture.adjudication,
    error, diagnosticReport: live || fixture.frozenReview ? diagnosticReport : undefined, diagnosticAttempts, attempts: attempts.map((attempt) => ({ role: attempt.role, durationMs: attempt.durationMs, escalationReason: attempt.escalationReason,
      answers: attempt.result?.answers, usage: attempt.result?.usage,
      costUsd: !live ? 0 : attempt.result?.usage?.promptTokens === undefined ? null : calculateTextGenerationCost({ ...attempt.result, ...attempt.result.usage }) })) });
}
const report = {
  mode: live ? "live shadow" : "offline saved-context coverage; decisions and uncaptured diagnostics are mocked",
  baselineSelection: routing.fastJudgments,
  note: "Agreement is not ground truth. Missing briefs are not reconstructed from the draft. Offline latency measures orchestration only. No net cost or production latency claim. Private-source fixtures require an authorized SourceAwareTextModel replay, not this standalone harness.",
  summary: {
    ...summarizePageReviewObservations(records),
    decisionPhysicalCalls: records.reduce((sum, record) => sum + record.attempts.length, 0),
    knownCostUsd: records.flatMap((record) => [...record.attempts, ...record.diagnosticAttempts]).reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0),
    unpricedCalls: records.flatMap((record) => [...record.attempts, ...record.diagnosticAttempts]).filter((attempt) => attempt.costUsd === null).length
  }, records
};
const output = JSON.stringify(report, null, 2) + "\n";
if (flag("--output")) await writeFile(resolve(flag("--output")!), output);
console.log(output);
if (records.some((row) => row.error)) process.exitCode = 1;
