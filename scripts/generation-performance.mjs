import { allAssessed } from "./generation-quality-acceptance.mjs";
import { reconcileGenerationAccounting } from "./generation-accounting.mjs";
const TIERS = ["fast", "balanced", "premium"];
export const GENERATION_WATCHDOG_MS = 240 * 60_000;
const TEXT_ONLY_30_MINUTES = "fast=5,balanced=8,premium=12";
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const time = (value) => value == null ? null : Number.isFinite(new Date(value).getTime()) ? new Date(value).getTime() : null;
const callKey = (event) => `${event.job?.generationJobId ?? ""}:${event.callId ?? ""}`;
const attemptKey = (event) => `${callKey(event)}:${event.requestIndex ?? event.providerRequest?.requestIndex ?? 1}`;

/** Ceilings are explicit experimental inputs, never product SLO defaults. */
export function parseBenchmarkOptions({ rounds = "1", maxMinutes, profile } = {}) {
  const roundCount = Number(rounds);
  if (!Number.isInteger(roundCount) || roundCount < 1 || roundCount > 3) throw new Error("--rounds must be 1, 2 or 3 matched tier rounds");
  if (profile !== undefined && profile !== "text-only-30") throw new Error("Unknown benchmark profile; use text-only-30");
  if (profile && maxMinutes !== undefined) throw new Error("Choose --benchmark-profile or --max-minutes, not both");
  if (profile) maxMinutes = TEXT_ONLY_30_MINUTES;
  if (typeof maxMinutes !== "string") throw new Error("Set explicit experimental --max-minutes or --benchmark-profile text-only-30");
  const ceilings = {};
  for (const pair of maxMinutes.split(",")) {
    const [tier, raw, extra] = pair.split("=");
    const minutes = Number(raw);
    if (!TIERS.includes(tier) || Object.hasOwn(ceilings, tier) || extra !== undefined || !Number.isFinite(minutes) || minutes <= 0 || minutes >= 240) {
      throw new Error("--max-minutes requires each tier exactly once with a positive target below the separate 240-minute watchdog");
    }
    ceilings[tier] = minutes * 60_000;
  }
  if (TIERS.some((tier) => !Object.hasOwn(ceilings, tier))) throw new Error("--max-minutes must include fast, balanced and premium");
  return { rounds: roundCount, maxElapsedMs: ceilings, targetKind: "experimental", ...(profile ? { profile } : {}) };
}

function intervals(rows) {
  const valid = rows.flatMap((row) => {
    const start = time(row.startedAt), end = time(row.finishedAt);
    return start !== null && end !== null && end >= start ? [[start, end]] : [];
  }).sort((a, b) => a[0] - b[0]);
  if (!valid.length) return { jobs: rows.length, spanMs: null, activeMs: null, summedJobMs: null, incompleteTimings: rows.length };
  let activeMs = 0, [start, end] = valid[0];
  for (const [nextStart, nextEnd] of valid.slice(1)) {
    if (nextStart > end) { activeMs += end - start; start = nextStart; end = nextEnd; }
    else end = Math.max(end, nextEnd);
  }
  activeMs += end - start;
  return { jobs: rows.length, spanMs: Math.max(...valid.map((pair) => pair[1])) - valid[0][0], activeMs,
    summedJobMs: valid.reduce((sum, pair) => sum + pair[1] - pair[0], 0), incompleteTimings: rows.length - valid.length };
}

/** Uses observed wire events; missing telemetry is unknown rather than zero. */
export function summarizeGenerationPerformance({ jobs, calls, events = [], elapsedMs, maxElapsedMs, tier }) {
  const ceilingMs = number(maxElapsedMs);
  const watchdogOnly = ceilingMs !== null && ceilingMs >= GENERATION_WATCHDOG_MS;
  const status = ceilingMs === null || ceilingMs === 0 || watchdogOnly ? "not_configured"
    : number(elapsedMs) === null ? "pending" : elapsedMs <= ceilingMs ? "passed" : "failed";
  const issues = status === "failed" ? [`${tier ?? "Tier"} took ${Math.round(elapsedMs / 1000)}s, exceeding its experimental ${Math.round(ceilingMs / 1000)}s ceiling`]
    : status === "not_configured" ? [watchdogOnly ? "The four-hour watchdog is not a performance target; configure a separate experimental ceiling" : "No explicit experimental elapsed-time ceiling was configured"] : [];
  const requests = new Map(events.filter((event) => /^text\..+\.request$/.test(event.event ?? "")).map((event) => [callKey(event), event]));
  const physical = new Map(events.filter((event) => /^text\..+\.provider_request$/.test(event.event ?? "")).map((event) => [attemptKey(event), event]));
  const usage = new Map();
  for (const event of events.filter(event => /^text\..+\.provider_usage$/.test(event.event ?? ""))) {
    const key = attemptKey(event);
    usage.set(key, { ...event, usage: { ...usage.get(key)?.usage, ...event.usage } });
  }
  const terminal = new Map(events.filter((event) => /^text\..+\.(response|error)$/.test(event.event ?? "")).map((event) => [attemptKey(event), event]));
  const physicalRows = [...physical.values()];
  const errors = events.filter((event) => String(event.event).endsWith(".error") || (event.event === "decision.choose.attempt" && event.error));
  const purpose = (event) => event.purpose ?? event.request?.purpose ?? requests.get(callKey(event))?.request?.purpose
    ?? (String(event.event).startsWith("image.generate.") ? "image.generate" : "unknown");
  const purposes = new Map();
  const row = (name) => {
    if (!purposes.has(name)) purposes.set(name, { purpose: name, recordedCalls: 0, recordedDurationMs: 0,
      recordedReasoningTokens: 0, physicalTextAttempts: 0, physicalTextRetries: 0, loggedErrors: 0, effectiveOutputLimits: new Set() });
    return purposes.get(name);
  };
  for (const call of calls) {
    const entry = row(call.purpose ?? "unknown");
    entry.recordedCalls++;
    entry.recordedDurationMs += number(call.durationMs) ?? 0;
    entry.recordedReasoningTokens += number(call.metadata?.reasoningTokens) ?? 0;
  }
  for (const event of physicalRows) {
    const entry = row(purpose(event));
    entry.physicalTextAttempts++;
    if (event.attempt > 1) entry.physicalTextRetries++;
    if (number(event.effectiveMaxTokens) !== null) entry.effectiveOutputLimits.add(event.effectiveMaxTokens);
  }
  for (const event of errors) row(purpose(event)).loggedErrors++;
  const reasoningUsage = [...usage.values()].filter((event) => number(event.usage?.reasoningTokens) !== null);
  const imageAttempts = events.filter((event) => event.event === "image.generate.request");
  const decisionAttempts = events.filter((event) => event.event === "decision.choose.attempt");
  const traceAvailable = events.length > 0;
  return {
    status, passed: status === "passed" ? true : status === "failed" ? false : null,
    targetKind: "experimental", ceilingMs, elapsedMs, issues,
    watchdog: { ceilingMs: GENERATION_WATCHDOG_MS, withinLimit: number(elapsedMs) === null ? null : elapsedMs <= GENERATION_WATCHDOG_MS },
    nonImageRecordedCalls: calls.filter((call) => call.purpose !== "image.generate").length,
    physicalTextAttempts: physical.size || (requests.size || calls.some((call) => call.purpose !== "image.generate") || !events.length ? null : 0),
    physicalTextRetries: physical.size ? physicalRows.filter((event) => event.attempt > 1).length : null,
    textAttemptsWithoutRetryOrdinal: physicalRows.filter((event) => !Number.isInteger(event.attempt)).length,
    ...reconcileGenerationAccounting({ calls, physical, usage, terminal }),
    loggedImageAttempts: traceAvailable ? imageAttempts.length : null, loggedDecisionAttempts: traceAvailable ? decisionAttempts.length : null,
    loggedErrors: traceAvailable ? errors.length : null,
    outputLimitErrors: traceAvailable ? errors.filter((event) => /max_output_tokens|MAX_TOKENS|output.token.*limit/i.test(event.error?.message ?? "")).length : null,
    physicalReasoningTokens: reasoningUsage.length ? reasoningUsage.reduce((sum, event) => sum + event.usage.reasoningTokens, 0) : null,
    textUsageWithoutReasoningCount: usage.size - reasoningUsage.length,
    recordedReasoningTokens: calls.reduce((sum, call) => sum + (number(call.metadata?.reasoningTokens) ?? 0), 0),
    callsWithoutReasoningCount: calls.filter((call) => call.purpose !== "image.generate" && number(call.metadata?.reasoningTokens) === null).length,
    traceAvailable,
    stages: {
      planning: intervals(jobs.filter((job) => job.type === "PLAN_BOOK")),
      manuscript: intervals(jobs.filter((job) => ["GENERATE_BOOK", "GENERATE_PAGE"].includes(job.type))),
      illustrations: intervals(jobs.filter((job) => job.type === "GENERATE_IMAGE" && job.payload?.pageId)),
      finalizationAndExport: intervals(jobs.filter((job) => job.type === "COMPILE_EXPORT"))
    },
    timingNote: "Stage spans can overlap; activeMs is the union of job intervals and summedJobMs includes parallel work. Finalization span includes image handoff gaps. Recorded provider duration is not wall-clock latency.",
    attemptNote: "Physical text attempts come from wire callbacks. Retry ordinals include schema repair, budget widening and fallback; tool continuations can also consume the budget. Outcomes also use uniquely matched ledger attempts. loggedErrors counts raw error events; ledgerKnownFailedTextCalls includes failures missing from those logs. Missing usage or cost is unknown, never zero. Image/decision counts exclude unobservable SDK-internal retries.",
    purposes: [...purposes.values()].map((entry) => ({ ...entry,
      physicalTextAttempts: physical.size ? entry.physicalTextAttempts : null,
      physicalTextRetries: physical.size ? entry.physicalTextRetries : null,
      loggedErrors: traceAvailable ? entry.loggedErrors : null,
      effectiveOutputLimits: [...entry.effectiveOutputLimits].sort((a, b) => a - b) }))
      .sort((a, b) => b.recordedDurationMs - a.recordedDurationMs)
  };
}

/** Publication and benchmark success are independent; never replace failed samples. */
export function nextBenchmarkRound(runs) {
  if (runs.some((run) => run.state === "running" || run.state === "failed"
    || (run.state === "published" && run.acceptancePassed !== true))) return null;
  return runs.find((run) => run.state === "prepared")?.round ?? null;
}

export function summarizeBenchmarkMatrix(summaries, expectedRuns) {
  const complete = summaries.length === expectedRuns;
  return {
    passed: false,
    acceptanceStatus: !complete ? "incomplete" : summaries.some(s => s.acceptanceStatus === "failed") ? "failed"
      : summaries.every(s => s.automatedPassed === true) ? "human_review_pending" : "unassessed",
    automatedPassed: complete && summaries.every(s => s.automatedPassed === true),
    functionalPassed: complete && summaries.every((summary) => summary.functionalPassed),
    performancePassed: !complete ? null : allAssessed(summaries.map(s => s.performance?.passed)),
    publicationPassed: complete && summaries.every(s => s.completion?.state === "published"),
    qualityPassed: !complete ? null : allAssessed(summaries.map(s => s.qualityPassed)),
    semanticPassed: !complete ? null : allAssessed(summaries.map(s => s.semanticPassed)),
    expectedRuns, capturedRuns: summaries.length, runs: summaries, humanReview: "pending"
  };
}
