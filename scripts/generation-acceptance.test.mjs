import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { capturePublishedArtifacts, classifyGenerationCompletion, expectedStoryIllustrationIndexes, prepareStorybookIllustrations, sha256, summarizeAcceptance, verifyArchive, verifyPdfStoryLayout, verifyStoryIllustrations, verifyStoryPages } from "./generation-acceptance.mjs";
import { nextBenchmarkRound, parseBenchmarkOptions, summarizeBenchmarkMatrix, summarizeGenerationPerformance } from "./generation-performance.mjs";

const requireCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const JSZip = requireCore("jszip");
const pages = Array.from({ length: 30 }, (_, n) => ({ id: `page-${n + 1}`, index: n + 1, status: "COMPLETED", markdown: `Page ${n + 1}.` }));
const job = (type, status, extra = {}) => ({ type, status, ...extra });
const cleanQuality = () => ({ state: "passed", score: 100, issues: [], briefCoverage: { review: {
  status: "reviewed", assessmentComplete: true, requirements: [{ id: "brief-1", text: "Character growth", status: "fulfilled" }]
} } });

test("publication inside a four-hour watchdog is not completed quality acceptance", () => {
  const report = summarizeAcceptance(publishedSample({ maxElapsedMs: 240 * 60_000 }));
  assert.equal(report.functionalPassed, true);
  assert.equal(report.passed, false);
  assert.equal(report.performance.passed, null);
});

function publishedSample(overrides = {}) {
  return {
    project: { id: "book", status: "COMPLETE" }, pages,
    jobs: [job("PLAN_BOOK", "COMPLETED"), job("GENERATE_BOOK", "COMPLETED"),
      job("COMPILE_EXPORT", "COMPLETED", { payload: { finalization: {} }, qualityReport: cleanQuality(), finishedAt: "2026-09-23T00:14:00Z" })],
    images: pages.map((page) => ({ type: "SCENE_ILLUSTRATION", pageId: page.id })),
    calls: [], characters: [], artifacts: [1, 2, 3], startedAt: "2026-09-23T00:00:00Z",
    tier: "fast", maxElapsedMs: 5 * 60_000, ...overrides
  };
}

test("sparse illustration input is explicit, recorded, and leaves the retained baseline unchanged", () => {
  const source = { prompt: "Make each page a distinct visual scene with concise prose. Exactly 30 story pages.", targetPages: 30,
    mediaSettings: { fullIllustrations: true, illustrationCadence: "template-driven", mobile: { characters: ["Rabbit", "Wise Turtle"] } } };
  const before = structuredClone(source);
  const variant = prepareStorybookIllustrations(source, "every-third-page");
  assert.deepEqual(source, before);
  assert.deepEqual(variant.policy.expectedPageIndexes, [3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
  assert.equal(variant.input.mediaSettings.illustrationCadence, "every-third-page");
  assert.equal(variant.input.targetPages, 30);
  assert.equal(variant.policy.changedFromBaseline, true);
  assert.equal(variant.policy.baselinePrompt, source.prompt);
  assert.match(variant.input.prompt, /distinct story scene/);
  assert.match(variant.input.prompt, /Exactly 10 interior illustrations/);
  assert.match(variant.input.prompt, /other 20 story pages contain text without illustrations/);
  assert.deepEqual(prepareStorybookIllustrations(source).input, source);
  assert.equal(prepareStorybookIllustrations(source).policy.changedFromBaseline, false);
  assert.equal(prepareStorybookIllustrations(source).policy.expectedPageIndexes.length, 30);
  assert.throws(() => prepareStorybookIllustrations(source, "sometimes"), /Unknown/);
});

test("text-only acceptance keeps the saved cast while rejecting every image asset and call", () => {
  const source = { prompt: "Write an original 30-page illustrated storybook. Use portrait references. Make each page a distinct visual scene.", targetPages: 30,
    mediaSettings: { fullIllustrations: true, illustrationCadence: "template-driven", coverArtSource: "design", mobile: { characters: ["Rabbit", "Wise Turtle"] } } };
  const variant = prepareStorybookIllustrations(source, "none");
  assert.equal(variant.input.mediaSettings.fullIllustrations, false);
  assert.equal(variant.input.mediaSettings.illustrationCadence, "manual");
  assert.equal(variant.input.mediaSettings.coverArtSource, "none");
  assert.deepEqual(variant.policy.expectedPageIndexes, []);
  assert.deepEqual(variant.input.mediaSettings.mobile.characters, source.mediaSettings.mobile.characters);
  const sample = publishedSample({ images: [], characters: [{ id: "rabbit", name: "Rabbit" }], calls: [],
    expectedIllustrationPageIndexes: [], illustrationCadence: "none", maxElapsedMs: 20 * 60_000 });
  assert.equal(summarizeAcceptance(sample).functionalPassed, true);
  assert.equal(summarizeAcceptance({ ...sample, images: [{ type: "COVER" }] }).functionalPassed, false);
  assert.equal(summarizeAcceptance({ ...sample, calls: [{ purpose: "image.generate" }] }).functionalPassed, false);
});

test("new benchmark prompts use the one-sided allowance without exact-30 or fixed illustration quotas", () => {
  const source = { prompt: "Write an original 30-page illustrated storybook. Exactly 30 story pages.", targetPages: 30,
    mediaSettings: { fullIllustrations: true } };
  for (const cadence of ["none", "every-third-page", "every-page"]) {
    const variant = prepareStorybookIllustrations(source, cadence, { minimumPages: 30, maximumPages: 33 });
    assert.match(variant.input.prompt, /30–33 story pages, never fewer than 30/);
    assert.doesNotMatch(variant.input.prompt, /exactly 30|Exactly 10 interior illustrations/i);
    assert.equal(variant.policy.baselinePrompt, source.prompt);
    if (cadence === "every-third-page") assert.match(variant.input.prompt, /through the selected last page/);
  }
  assert.match(source.prompt, /Exactly 30/);
});

test("acceptance honors 30–33 selected pages and retains strict historical manifests", () => {
  const policy = { mode: "one-physical-page-per-story", expectedStoryPages: 30, pageCountBounds: { minimumPages: 30, maximumPages: 33 } };
  for (const count of [29, 30, 31, 32, 33, 34]) {
    const selectedPages = Array.from({ length: count }, (_, i) => ({ ...pages[0], id: `page-${i + 1}`, index: i + 1 }));
    const sample = publishedSample({ project: { id: "book", status: "COMPLETE", targetPages: count }, pages: selectedPages,
      illustrationCadence: "none", images: [], expectedIllustrationPageIndexes: [], pdfLayoutPolicy: policy,
      artifacts: [{ format: "pdf", storyPageLayout: { mode: policy.mode, storySheets: count } }, 2, 3] });
    assert.equal(summarizeAcceptance(sample).functionalPassed, count >= 30 && count <= 33);
    assert.equal(summarizeAcceptance({ ...sample, pages: selectedPages.slice(1) }).functionalPassed, false);
    assert.equal(summarizeAcceptance({ ...sample, pdfLayoutPolicy: { mode: policy.mode, expectedStoryPages: 30 } }).functionalPassed, count === 30);
    if (count === 33) {
      const expected = expectedStoryIllustrationIndexes("every-third-page", count);
      const sparse = summarizeAcceptance({ ...sample, illustrationCadence: "every-third-page",
        images: selectedPages.filter(page => expected.includes(page.index)).map(page => ({ type: "SCENE_ILLUSTRATION", pageId: page.id })) });
      assert.equal(sparse.functionalPassed, true);
      assert.equal(sparse.expectedIllustrationPageIndexes.at(-1), 33);
    }
  }
});

test("sparse acceptance requires exactly the configured ten scene slots and two separate portraits", () => {
  const expected = expectedStoryIllustrationIndexes("every-third-page", 30);
  const scenes = pages.filter((page) => expected.includes(page.index)).map((page) => ({ type: "SCENE_ILLUSTRATION", pageId: page.id }));
  const characters = [{ id: "rabbit", name: "Rabbit" }, { id: "turtle", name: "Wise Turtle" }];
  const portraits = characters.map((character) => ({ type: "CHARACTER_REFERENCE", metadata: { libraryCharacterId: character.id, seededFromPortrait: true } }));
  const images = [...scenes, ...portraits, { type: "COVER" }];
  const sample = publishedSample({ images, characters, expectedIllustrationPageIndexes: expected, illustrationCadence: "every-third-page" });
  const report = summarizeAcceptance(sample);
  assert.equal(report.functionalPassed, true);
  assert.equal(report.storyPages, 30);
  assert.deepEqual(report.illustrationInventory, { expectedPageIndexes: expected, actualPageIndexes: expected,
    sceneAssets: 10, textOnlyStoryPages: 20, characterReferenceAssets: 2, coverAssets: 1 });
  for (const badScenes of [scenes.slice(1), [...scenes, scenes[0]], [...scenes.slice(1), scenes[1]],
    [...scenes.slice(1), { type: "SCENE_ILLUSTRATION", pageId: "page-1" }],
    [...scenes.slice(1), { type: "SCENE_ILLUSTRATION", pageId: "not-a-page" }]]) {
    assert.throws(() => verifyStoryIllustrations(pages, [...badScenes, ...portraits], expected), /Expected exactly 10/);
  }
  assert.equal(summarizeAcceptance({ ...sample, images: scenes }).functionalPassed, false);
  assert.equal(summarizeAcceptance({ ...sample, images: [...images, portraits[0]] }).functionalPassed, false);
  assert.equal(summarizeAcceptance({ ...sample, pages: pages.slice(1) }).functionalPassed, false);
  // A fully illustrated retained sample still uses its original expectation.
  assert.equal(summarizeAcceptance(publishedSample()).functionalPassed, true);
});

test("published exports are a functional pass but fail an exceeded experimental ceiling", () => {
  const result = summarizeAcceptance(publishedSample());
  assert.equal(result.functionalPassed, true);
  assert.equal(result.completion.state, "published");
  assert.equal(result.performance.status, "failed");
  assert.equal(result.performance.ceilingMs, 300_000);
  assert.equal(result.passed, false);
});

test("round advancement preserves publication and drains peers before judging the next round", () => {
  const slow = { state: "published", acceptancePassed: false, round: 1 };
  const pending = { state: "prepared", round: 2 };
  const snapshot = structuredClone(slow);
  assert.equal(nextBenchmarkRound([slow, { state: "running", round: 1 }, pending]), null);
  assert.equal(nextBenchmarkRound([slow, pending]), null);
  assert.deepEqual(slow, snapshot);
  assert.equal(nextBenchmarkRound([{ state: "published", round: 1 }, pending]), null);
  assert.equal(nextBenchmarkRound([{ state: "published", acceptancePassed: true, round: 1 }, pending]), 2);
});

test("a benchmark without an explicit ceiling cannot claim a performance pass", () => {
  const result = summarizeAcceptance(publishedSample({ maxElapsedMs: undefined }));
  assert.equal(result.functionalPassed, true);
  assert.equal(result.performance.status, "not_configured");
  assert.equal(result.performance.passed, null);
  assert.equal(result.passed, false);
});

test("one explicit matched round can pass without buying a nine-run matrix", () => {
  const options = parseBenchmarkOptions({ rounds: "1", maxMinutes: "fast=5,balanced=8,premium=12" });
  assert.equal(options.rounds, 1);
  assert.deepEqual(options.maxElapsedMs, { fast: 300_000, balanced: 480_000, premium: 720_000 });
  const good = summarizeAcceptance(publishedSample({ maxElapsedMs: 15 * 60_000 }));
  assert.equal(good.automatedPassed, true);
  assert.equal(good.passed, false);
  assert.equal(good.acceptanceStatus, "human_review_pending");
  const summary = summarizeBenchmarkMatrix([good, good, good], options.rounds * 3);
  assert.equal(summary.automatedPassed, true);
  assert.equal(summary.passed, false);
  assert.equal(summary.acceptanceStatus, "human_review_pending");
  assert.equal(summary.functionalPassed, true);
  assert.equal(summary.performancePassed, true);
  assert.equal(summarizeBenchmarkMatrix([good, good], 3).passed, false);
  const slow = summarizeAcceptance(publishedSample());
  const failed = summarizeBenchmarkMatrix([good, good, slow], 3);
  assert.equal(failed.functionalPassed, true);
  assert.equal(failed.performancePassed, false);
  assert.equal(failed.passed, false);
});

test("experimental limits cannot be missing, duplicated or silently defaulted", () => {
  assert.throws(() => parseBenchmarkOptions(), /explicit experimental/);
  for (const maxMinutes of ["fast=5,balanced=8", "fast=5,fast=8,premium=12", "fast=0,balanced=8,premium=12", "fast=5,balanced=NaN,premium=12"]) {
    assert.throws(() => parseBenchmarkOptions({ maxMinutes }));
  }
  assert.throws(() => parseBenchmarkOptions({ rounds: "0", maxMinutes: "fast=5,balanced=8,premium=12" }), /rounds/);
});

test("the text-only profile freezes practical targets independently of the watchdog", () => {
  assert.deepEqual(parseBenchmarkOptions({ profile: "text-only-30" }).maxElapsedMs,
    { fast: 300_000, balanced: 480_000, premium: 720_000 });
  assert.throws(() => parseBenchmarkOptions({ maxMinutes: "fast=240,balanced=240,premium=240" }), /watchdog/);
  assert.throws(() => parseBenchmarkOptions({ profile: "typo" }), /Unknown/);
  assert.throws(() => parseBenchmarkOptions({ profile: "text-only-30", maxMinutes: "fast=5,balanced=8,premium=12" }), /not both/);
});

test("quality and semantic acceptance remain independent of delivery and latency", () => {
  const run = (qualityReport) => {
    const sample = publishedSample({ maxElapsedMs: 15 * 60_000 });
    sample.jobs.at(-1).qualityReport = qualityReport;
    return summarizeAcceptance(sample);
  };
  const quick = cleanQuality();
  quick.state = "review_recommended";
  quick.briefCoverage.review.status = "incomplete";
  quick.briefCoverage.review.assessmentComplete = false;
  const incomplete = run(quick);
  assert.equal(incomplete.publicationPassed, true);
  assert.equal(incomplete.functionalPassed, true);
  assert.equal(incomplete.performance.passed, true);
  assert.equal(incomplete.semanticPassed, false);
  assert.equal(incomplete.qualityPassed, false);
  assert.equal(incomplete.automatedPassed, false);
  assert.equal(incomplete.acceptanceStatus, "failed");
  const missing = cleanQuality();
  missing.briefCoverage.review.requirements[0].status = "missing";
  assert.equal(run(missing).semantic.status, "complete");
  assert.equal(run(missing).semanticPassed, false);
  assert.equal(run(missing).automatedPassed, false);
  const unknown = run(undefined);
  assert.equal(unknown.semanticPassed, null);
  assert.equal(unknown.qualityPassed, null);
  assert.equal(unknown.acceptanceStatus, "unassessed");
  const matrix = summarizeBenchmarkMatrix([run(cleanQuality()), incomplete, unknown], 3);
  assert.equal(matrix.functionalPassed, true);
  assert.equal(matrix.performancePassed, true);
  assert.equal(matrix.semanticPassed, false);
  assert.equal(matrix.qualityPassed, false);
  assert.equal(matrix.automatedPassed, false);
  const slow = summarizeAcceptance(publishedSample());
  const noTarget = summarizeAcceptance(publishedSample({ maxElapsedMs: undefined }));
  assert.equal(summarizeBenchmarkMatrix([slow, noTarget], 2).performancePassed, false);
  assert.equal(summarizeBenchmarkMatrix([run(cleanQuality()), noTarget], 2).performancePassed, null);
});

test("performance telemetry counts physical truncation and retry without double-counting usage", () => {
  const first = { callId: "first", job: { generationJobId: "book-job" } };
  const second = { callId: "second", job: { generationJobId: "book-job" } };
  const events = [
    { ...first, event: "text.generateJson.request", request: { purpose: "revise-page" } },
    { ...first, event: "text.generateJson.provider_request", purpose: "revise-page", requestIndex: 1, attempt: 1, effectiveMaxTokens: 3_200 },
    { ...first, event: "text.generateJson.provider_usage", providerRequest: { requestIndex: 1 }, usage: { reasoningTokens: 3_200 } },
    { ...first, event: "text.generateJson.error", providerRequest: { requestIndex: 1 }, error: { message: "OpenAI response was incomplete: max_output_tokens." } },
    { ...second, event: "text.generateJson.request", request: { purpose: "revise-page" } },
    { ...second, event: "text.generateJson.provider_request", purpose: "revise-page", requestIndex: 1, attempt: 2, effectiveMaxTokens: 16_000 },
    { ...second, event: "text.generateJson.provider_usage", providerRequest: { requestIndex: 1 }, usage: { reasoningTokens: 4_300 } },
    { ...second, event: "text.generateJson.provider_usage", providerRequest: { requestIndex: 1 }, usage: { cacheHitTokens: 0 } },
    { ...second, event: "text.generateJson.response", providerRequest: { requestIndex: 1 }, result: { usage: { reasoningTokens: 4_300 } } }
  ];
  const calls = [{ purpose: "revise-page", durationMs: 20_000, metadata: { reasoningTokens: 3_200 } },
    { purpose: "revise-page", durationMs: 30_000, metadata: { reasoningTokens: 4_300 } }, { purpose: "image.generate" }];
  const result = summarizeGenerationPerformance({ jobs: [], calls, events, elapsedMs: 100_000, maxElapsedMs: 300_000, tier: "fast" });
  assert.equal(result.physicalTextAttempts, 2);
  assert.equal(result.physicalTextRetries, 1);
  assert.equal(result.outputLimitErrors, 1);
  assert.equal(result.nonImageRecordedCalls, 2);
  assert.equal(result.physicalReasoningTokens, 7_500);
  assert.deepEqual(result.textAttemptOutcomes, { succeeded: 1, failed: 1, notIndividuallySettled: 0 });
  assert.deepEqual(result.purposes[0].effectiveOutputLimits, [3_200, 16_000]);
  const missing = summarizeGenerationPerformance({ jobs: [], calls, elapsedMs: 100_000, maxElapsedMs: 300_000 });
  assert.equal(missing.physicalTextAttempts, null);
  assert.equal(missing.physicalReasoningTokens, null);
  assert.equal(missing.textAttemptOutcomes, null);
  assert.equal(missing.loggedErrors, null);
  assert.equal(missing.loggedImageAttempts, null);
  assert.equal(missing.traceAvailable, false);
});

test("fallback and schema repair attempts retain separate wire identities and cumulative ordinals", () => {
  const context = { callId: "primary-fallback", job: { generationJobId: "job" } };
  const request = (callId, requestIndex, attempt) => ({ ...context, callId, event: "text.generateJson.provider_request", requestIndex, attempt, purpose: "review-page" });
  const usage = (callId, requestIndex, reasoningTokens) => ({ ...context, callId, event: "text.generateJson.provider_usage", providerRequest: { requestIndex }, usage: { reasoningTokens } });
  const events = [request(context.callId, 1, 1), request(context.callId, 2, 2),
    request("schema-repair", 1, 3), usage(context.callId, 1, 20), usage(context.callId, 2, 30),
    usage("schema-repair", 1, 40), usage("schema-repair", 1, 40),
    { ...context, callId: "schema-repair", event: "text.generateJson.response", providerRequest: { requestIndex: 1 } }];
  const result = summarizeGenerationPerformance({ jobs: [], calls: [], events });
  assert.equal(result.physicalTextAttempts, 3);
  assert.equal(result.physicalTextRetries, 2);
  assert.equal(result.physicalReasoningTokens, 90);
  assert.deepEqual(result.textAttemptOutcomes, { succeeded: 1, failed: 0, notIndividuallySettled: 2 });
  const unreported = summarizeGenerationPerformance({ jobs: [], calls: [], events: [
    request(context.callId, 1, 1), { ...context, event: "text.generateJson.provider_usage", providerRequest: { requestIndex: 1 }, usage: { outputTokens: 20 } }
  ] });
  assert.equal(unreported.physicalReasoningTokens, null);
  assert.equal(unreported.textUsageWithoutReasoningCount, 1);
});

test("captured interrupted Balanced attempt remains failed with unknown usage and cost after fallback succeeds", () => {
  const capture = JSON.parse(readFileSync(new URL("./testing/balanced-interrupted-fallback.json", import.meta.url), "utf8"));
  const result = summarizeGenerationPerformance({ jobs: [], ...capture });
  assert.equal(result.loggedErrors, 0);
  assert.deepEqual(result.textAttemptOutcomes, { succeeded: 1, failed: 1, notIndividuallySettled: 0 });
  assert.equal(result.ledgerKnownFailedTextCalls, 1);
  assert.equal(result.textAttemptsWithoutUsage, 1);
  assert.equal(result.textUsageWithoutReasoningCount, 0);
  assert.equal(result.physicalReasoningTokens, 0);
  assert.deepEqual(result.tokenAccounting, { providerReportedPromptTokens: 4939, providerReportedOutputTokens: 393,
    estimatedPromptTokens: 5631, estimatedOutputTokens: 0, callsWithoutConfirmedUsage: 1, complete: false });
  assert.deepEqual(result.costAccounting, { knownCostHint: 0.007442, callsWithoutCostHint: 1, complete: false });
});

test("ledger fallback matching does not guess between repeated physical attempts on the same provider", () => {
  const capture = JSON.parse(readFileSync(new URL("./testing/balanced-interrupted-fallback.json", import.meta.url), "utf8"));
  const first = capture.events.find(event => event.event.endsWith("provider_request"));
  capture.events.push({ ...first, requestIndex: 3, attempt: 3 });
  const result = summarizeGenerationPerformance({ jobs: [], ...capture });
  assert.equal(result.ledgerKnownFailedTextCalls, 1);
  assert.deepEqual(result.textAttemptOutcomes, { succeeded: 1, failed: 0, notIndividuallySettled: 2 });
  assert.equal(result.textAttemptsWithoutUsage, 2);
  assert.equal(result.tokenAccounting.complete, false);
  const noLogs = summarizeGenerationPerformance({ jobs: [], calls: capture.calls });
  assert.equal(noLogs.textAttemptsWithoutUsage, null);
  assert.equal(noLogs.ledgerKnownFailedTextCalls, 1);
  assert.equal(noLogs.costAccounting.complete, false);
});

test("reported token counts and known prices cannot make an in-flight ledger look complete", () => {
  const call = { purpose: "review-page", promptTokens: 100, outputTokens: 10, costHint: null, generationJobId: "j", provider: "openai", model: "fixture",
    metadata: { callId: "c", provisional: true, liveStatus: "running", promptTokensEstimated: false, outputTokensEstimated: false } };
  const pending = summarizeGenerationPerformance({ jobs: [], calls: [call] });
  assert.equal(pending.tokenAccounting.providerReportedPromptTokens, 100);
  assert.equal(pending.tokenAccounting.complete, false);
  assert.equal(pending.costAccounting.callsWithoutCostHint, 1);
  const settled = summarizeGenerationPerformance({ jobs: [], calls: [{ ...call, costHint: 0, metadata: { ...call.metadata, provisional: false, liveStatus: "settled" } }] });
  assert.equal(settled.tokenAccounting.complete, false); // No physical trace to reconcile.
  assert.equal(settled.costAccounting.complete, false);
  const traced = summarizeGenerationPerformance({ jobs: [], calls: [{ ...call, costHint: 0, metadata: { ...call.metadata, provisional: false, liveStatus: "settled" } }],
    events: [{ event: "text.generateJson.provider_request", callId: "c", job: { generationJobId: "j" }, requestIndex: 1, provider: "openai", model: "fixture" }] });
  assert.equal(traced.tokenAccounting.complete, true);
  assert.equal(traced.costAccounting.complete, true);
});

test("critical stage timings separate wall-clock spans from parallel work and image handoff gaps", () => {
  const stamp = (seconds) => new Date(Date.UTC(2026, 8, 23, 0, 0, seconds)).toISOString();
  const timed = (type, start, end, payload = {}) => ({ type, startedAt: stamp(start), finishedAt: stamp(end), payload });
  const jobs = [timed("PLAN_BOOK", 0, 10), timed("GENERATE_BOOK", 10, 50),
    timed("COMPILE_EXPORT", 50, 60), timed("GENERATE_IMAGE", 60, 90, { pageId: "p1" }),
    timed("GENERATE_IMAGE", 65, 100, { pageId: "p2" }), timed("COMPILE_EXPORT", 100, 120)];
  const result = summarizeGenerationPerformance({ jobs, calls: [], elapsedMs: 120_000, maxElapsedMs: 300_000 });
  assert.equal(result.stages.planning.activeMs, 10_000);
  assert.equal(result.stages.manuscript.activeMs, 40_000);
  assert.equal(result.stages.illustrations.activeMs, 40_000);
  assert.equal(result.stages.illustrations.summedJobMs, 65_000);
  assert.equal(result.stages.finalizationAndExport.spanMs, 70_000);
  assert.equal(result.stages.finalizationAndExport.activeMs, 30_000);
});

test("failed compile is a failure even when the project and manuscript look complete", () => {
  assert.deepEqual(classifyGenerationCompletion({ status: "COMPLETE" }, [job("COMPILE_EXPORT", "FAILED")]), { state: "failed", reason: "COMPILE_EXPORT FAILED" });
});

test("handoff completion is pending until the successor actually publishes", () => {
  const jobs = [job("GENERATE_BOOK", "COMPLETED"), job("COMPILE_EXPORT", "COMPLETED")];
  assert.equal(classifyGenerationCompletion({ status: "GENERATING" }, jobs).state, "pending");
  jobs.push(job("COMPILE_EXPORT", "QUEUED"));
  assert.equal(classifyGenerationCompletion({ status: "COMPLETE" }, jobs).state, "pending");
  jobs.at(-1).status = "COMPLETED";
  jobs.at(-1).qualityReport = { state: "review_recommended" };
  assert.deepEqual(classifyGenerationCompletion({ status: "COMPLETE" }, jobs), { state: "published", reviewRecommended: true });
});

test("an explicit rerun can recover, but the acceptance score still rejects manual recovery", () => {
  const jobs = [job("PLAN_BOOK", "COMPLETED"), job("GENERATE_BOOK", "FAILED"), job("GENERATE_BOOK", "COMPLETED"), job("COMPILE_EXPORT", "COMPLETED", { payload: { finalization: {} } })];
  assert.equal(classifyGenerationCompletion({ status: "COMPLETE" }, jobs).state, "published");
  const result = summarizeAcceptance({ project: { id: "book", status: "COMPLETE" }, pages, jobs, images: [], calls: [], characters: [], artifacts: [1, 2, 3], startedAt: "2026-09-23T00:00:00Z" });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => issue.includes("required recovery")));
});

test("story count checks reject missing, duplicated and empty pages", () => {
  assert.doesNotThrow(() => verifyStoryPages(pages, 30));
  assert.throws(() => verifyStoryPages(pages.slice(1), 30), /found 29/);
  assert.throws(() => verifyStoryPages([...pages.slice(0, 29), pages[28]], 30), /page 30/);
  assert.throws(() => verifyStoryPages(pages.map((p) => ({ ...p, markdown: " " })), 30), /empty/);
});

test("physical story-page layout rejects collapsed or split scenes and measures extra front matter", () => {
  const policy = { mode: "one-physical-page-per-story", expectedStoryPages: 30 };
  const ranges = pages.map((page) => ({ index: page.index, startPdfPage: page.index + 3, endPdfPage: page.index + 3 }));
  const layout = verifyPdfStoryLayout(ranges, 33, policy);
  assert.equal(layout.storySheets, 30);
  assert.deepEqual(layout.frontMatterPhysicalPages, [1, 2, 3]);
  assert.deepEqual(layout.backMatterPhysicalPages, []);
  assert.deepEqual(layout.nonStoryPhysicalPages, [1, 2, 3]);
  assert.throws(() => verifyPdfStoryLayout(ranges.map((range) => ({ ...range, startPdfPage: Math.ceil(range.index / 3) + 3, endPdfPage: Math.ceil(range.index / 3) + 3 })), 15, policy), /distinct physical page/);
  assert.throws(() => verifyPdfStoryLayout(ranges.map((range) => range.index === 3 ? { ...range, endPdfPage: range.endPdfPage + 1 } : range), 33, policy), /single physical page/);
  assert.throws(() => verifyPdfStoryLayout(ranges.slice(1), 33, policy), /30 measured story ranges/);
  const withBackMatter = verifyPdfStoryLayout(ranges, 35, policy);
  assert.deepEqual(withBackMatter.backMatterPhysicalPages, [34, 35]);
  assert.equal(summarizeAcceptance(publishedSample({ pdfLayoutPolicy: policy })).functionalPassed, false);
});

test("a best-version export can retain a nonempty failed-QA page only with a review warning", () => {
  const flagged = pages.map((page) => ({ ...page, status: "FAILED_QA" }));
  assert.throws(() => verifyStoryPages(flagged, 30), /unfinished/);
  assert.doesNotThrow(() => verifyStoryPages(flagged, 30, { state: "review_recommended", issues: [{ code: "PAGE_QA_REVIEW" }] }));
  assert.throws(() => verifyStoryPages(flagged.map((page) => ({ ...page, markdown: " " })), 30, { state: "review_recommended", issues: [{}] }), /empty/);
});

async function archives() {
  const docx = new JSZip();
  docx.file("[Content_Types].xml", "<Types/>");
  docx.file("_rels/.rels", "<Relationships/>");
  docx.file("word/document.xml", '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Story</w:t></w:r></w:p></w:body></w:document>');
  const epub = new JSZip();
  epub.file("mimetype", "application/epub+zip");
  epub.file("META-INF/container.xml", '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
  epub.file("OEBPS/content.opf", '<package><manifest><item id="page" href="page.xhtml"/></manifest><spine><itemref idref="page"/></spine></package>');
  epub.file("OEBPS/page.xhtml", '<html><body><p>Story</p></body></html>');
  return { docx: await docx.generateAsync({ type: "nodebuffer" }), epub: await epub.generateAsync({ type: "nodebuffer" }) };
}

test("archive integrity requires readable documents and referenced EPUB spine content", async () => {
  const bytes = await archives();
  await verifyArchive("docx", bytes.docx);
  await verifyArchive("epub", bytes.epub);
  const broken = await JSZip.loadAsync(bytes.epub);
  broken.remove("OEBPS/page.xhtml");
  await assert.rejects(verifyArchive("epub", await broken.generateAsync({ type: "nodebuffer" })), /missing OEBPS\/page.xhtml/);
  await assert.rejects(verifyArchive("docx", Buffer.from("not an archive")));
});

test("parseable archives with no readable story text are rejected", async () => {
  const bytes = await archives();
  const docx = await JSZip.loadAsync(bytes.docx);
  docx.file("word/document.xml", '<w:document xmlns:w="w"><w:body><w:p/></w:body></w:document>');
  await assert.rejects(verifyArchive("docx", await docx.generateAsync({ type: "nodebuffer" })), /no readable document text/);
  const epub = await JSZip.loadAsync(bytes.epub);
  epub.file("OEBPS/page.xhtml", '<html><head><title>Not story content</title><style>p{color:black}</style></head><body><p> </p></body></html>');
  await assert.rejects(verifyArchive("epub", await epub.generateAsync({ type: "nodebuffer" })), /no readable reading-order text/);
  epub.file("OEBPS/page.xhtml", '<html><body><p>Rabbit helped Turtle.</p></body></html>');
  await verifyArchive("epub", await epub.generateAsync({ type: "nodebuffer" }));
});

for (const targetPages of [30, 33]) test(`publication capture requires three intact downloads for ${targetPages} selected pages`, async () => {
  const pages = Array.from({ length: targetPages }, (_, i) => ({ id: `page-${i + 1}`, index: i + 1, status: "COMPLETED", markdown: "Story." }));
  const dir = mkdtempSync(join(tmpdir(), "book-acceptance-"));
  const pdf = Buffer.from("%PDF-1.7\nfixture PDF parsed by injected test reader\n%%EOF");
  const bytes = { pdf, ...await archives() };
  const project = { id: "book", targetPages, contentRevision: 4, pdfPageMap: {
    totalPdfPages: targetPages + 2, contentRevision: 4, pdfDigest: sha256(pdf), hasCoverPage: true,
    pages: pages.map((p) => ({ index: p.index, startPdfPage: p.index + 2, endPdfPage: p.index + 2 }))
  } };
  const store = new Map();
  for (const [format, body] of Object.entries(bytes)) {
    const key = `books/book/book.${format}`;
    store.set(key, body);
    store.set(`${key}.provenance.json`, Buffer.from(JSON.stringify({ revision: 4, digest: sha256(body), byteSize: body.length })));
  }
  const options = { project, pages, getObject: async (key) => store.get(key) ?? null, outputDir: dir, pdfInfo: () => `Pages: ${targetPages + 2}\n`,
    expectedIllustrationPageIndexes: expectedStoryIllustrationIndexes("every-third-page", targetPages),
    pdfLayoutPolicy: { mode: "one-physical-page-per-story", expectedStoryPages: 30,
      ...(targetPages === 33 ? { pageCountBounds: { minimumPages: 30, maximumPages: 33 } } : {}) } };
  try {
    const captured = await capturePublishedArtifacts(options);
    assert.equal(captured.length, 3);
    assert.equal(captured[0].physicalPages, targetPages + 2);
    assert.equal(captured[0].storyPages, targetPages);
    assert.equal(captured[0].mappedIllustratedStoryPageIndexes.length, targetPages / 3);
    assert.equal(captured[0].mappedTextOnlyStoryPageIndexes.length, targetPages * 2 / 3);
    assert.equal(captured[0].storyPageLayout.storySheets, targetPages);
    assert.deepEqual(captured[0].storyPageLayout.frontMatterPhysicalPages, [1, 2]);
    const completeMap = project.pdfPageMap.pages;
    project.pdfPageMap.pages = completeMap.map((range) => ({ ...range, startPdfPage: Math.ceil(range.index / 3) + 3, endPdfPage: Math.ceil(range.index / 3) + 3 }));
    await assert.rejects(capturePublishedArtifacts(options), /distinct physical page/);
    project.pdfPageMap.pages = completeMap.filter((page) => page.index !== 1);
    await assert.rejects(capturePublishedArtifacts(options), /map every story page/);
    project.pdfPageMap.pages = completeMap;
    store.set("books/book/book.pdf.provenance.json", Buffer.from(JSON.stringify({ revision: 3, digest: sha256(pdf), byteSize: pdf.length })));
    await assert.rejects(capturePublishedArtifacts(options), /provenance/);
    store.delete("books/book/book.pdf");
    await assert.rejects(capturePublishedArtifacts(options), /missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
