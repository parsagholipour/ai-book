/** Explicit synthetic-fixture comparison. No production settings or book data are changed. */
import {
  calculateTextGenerationCost,
  compiledGenerationTextModelRouting,
  createDecisionModelAdapter,
  createDecisionModelRoute,
  generationTextModelOptions,
  JEV_SELECTION,
  loadConfig,
  type DecisionAttempt,
  type DecisionRequest,
  type DecisionResult
} from "../packages/core/src/index.js";
import { decisionFixtures } from "./fixtures/fast-decisions.js";

const live = process.argv.includes("--live");
const config = { ...loadConfig(), MOCK_AI: !live };
if (live && !config.VERCEL_AI_GATEWAY_API_KEY?.trim()) throw new Error("Live comparison needs VERCEL_AI_GATEWAY_API_KEY.");
const routing = compiledGenerationTextModelRouting(config, generationTextModelOptions(config));
const llmSelection = routing.fastJudgments;
const reports = [];
const cost = (result: DecisionResult | undefined) => result?.usage?.promptTokens !== undefined
  ? calculateTextGenerationCost({ ...result, ...result.usage })
  : null;

for (const fixture of decisionFixtures) {
  const attempts: DecisionAttempt[] = [];
  const bound = await createDecisionModelRoute(config, {
    loadRouting: async () => ({ ...routing, fastDecisions: JEV_SELECTION, fastDecisionsFallback: llmSelection }),
    onAttempt: async (attempt) => { attempts.push(attempt); }
  }).resolve();
  const request: DecisionRequest = { ...fixture.request, signal: AbortSignal.timeout(60_000) };
  let final: DecisionResult | undefined;
  let finalError: string | undefined;
  const started = Date.now();
  try { final = await bound!.choose(request); } catch (error) { finalError = error instanceof Error ? error.name : "Error"; }
  const routedLatencyMs = Date.now() - started;
  let baseline: DecisionResult | undefined;
  let baselineError: string | undefined;
  const baselineStarted = Date.now();
  try { baseline = await createDecisionModelAdapter(config, llmSelection).choose({ ...fixture.request, signal: AbortSignal.timeout(60_000) }); }
  catch (error) { baselineError = error instanceof Error ? error.name : "Error"; }
  const primary = attempts.findLast((attempt) => attempt.role === "primary");
  reports.push({
    id: fixture.id,
    language: fixture.language,
    rawAgreement: primary?.result && baseline ? primary.result.selectedOption === baseline.selectedOption : null,
    finalAgreement: final && baseline ? final.selectedOption === baseline.selectedOption : null,
    escalated: attempts.some((attempt) => attempt.role === "fallback"),
    routedLatencyMs,
    finalChoice: final?.selectedOption ?? null,
    finalError: finalError ?? null,
    attempts: attempts.map((attempt) => ({
      role: attempt.role, provider: attempt.selection.provider, model: attempt.selection.model,
      selectedOption: attempt.result?.selectedOption ?? null, probabilities: attempt.result?.probabilities ?? null,
      escalationReason: attempt.escalationReason ?? null, durationMs: attempt.durationMs,
      usage: attempt.result?.usage ?? null, costUsd: live ? cost(attempt.result) : 0,
      error: attempt.error instanceof Error ? attempt.error.name : null
    })),
    baseline: { ...llmSelection, selectedOption: baseline?.selectedOption ?? null, latencyMs: Date.now() - baselineStarted, costUsd: live ? cost(baseline) : 0, usage: baseline?.usage ?? null, error: baselineError ?? null }
  });
}
const comparable = reports.filter((report) => report.rawAgreement !== null);
const pricedCalls = reports.flatMap((report) => [...report.attempts.map((attempt) => attempt.costUsd), report.baseline.costUsd]);
console.log(JSON.stringify({
  mode: live ? "live" : "mock (no network; validates the harness only)",
  note: "Agreement is not evidence of quality. Review disagreements and compare to human judgments before activation. The 0.70 winning-option probability policy is not calibrated confidence.",
  llm: llmSelection,
  summary: {
    fixtures: reports.length, comparable: comparable.length,
    jevLlmAgreement: comparable.length ? comparable.filter((report) => report.rawAgreement).length / comparable.length : null,
    escalationRate: reports.filter((report) => report.escalated).length / reports.length,
    meanRoutedLatencyMs: reports.reduce((sum, report) => sum + report.routedLatencyMs, 0) / reports.length,
    meanLlmLatencyMs: reports.reduce((sum, report) => sum + report.baseline.latencyMs, 0) / reports.length,
    totalKnownCostUsd: pricedCalls.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    unpricedCalls: pricedCalls.filter((value) => value === null).length
  },
  reports
}, null, 2));
if (reports.some((report) => report.finalError || report.baseline.error)) process.exitCode = 1;
