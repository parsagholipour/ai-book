import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOracleIsolation, mapExperimentRequest, summarizeAttempts, writeExclusive, oracleComparisonReadiness } from "./story-allocation-experiment.mjs";

const request = () => ({ temperature: 0.7, maxTokens: 24000, purpose: "generate-chapter-brief",
  messages: [{ role: "system", content: "Keep beat within 18 words. Keep other rules." },
    { role: "user", content: JSON.stringify({ prompt: "Keep beat within 18 words.", pageMap: [
      { pageIndex: 1, chapterIndex: 1, chapterTitle: "Opening", beat: "original" }
    ] }) }] });

test("variant leaves source, user content, budgets, and baseline untouched", () => {
  const original = request(), before = structuredClone(original);
  const changed = mapExperimentRequest(original, "variable-beats", 30);
  assert.deepEqual(original, before);
  assert.deepEqual(mapExperimentRequest(original, "baseline", 30), before);
  assert.deepEqual({ ...changed, messages: original.messages }, original);
  assert.deepEqual(changed.messages[1], original.messages[1]);
  assert.notEqual(changed.messages[0].content, original.messages[0].content);
});

test("unknown variants and ambiguous prompt revisions cannot silently run", () => {
  assert.throws(() => mapExperimentRequest(request(), "typo", 30));
  const changed = request(); changed.messages[0].content = "different prompt";
  assert.throws(() => mapExperimentRequest(changed, "variable-beats", 30));
  changed.messages[0].content = "beat within 18 words; beat within 18 words";
  assert.throws(() => mapExperimentRequest(changed, "variable-beats", 30));
});

test("oracle isolation permits map editing but rejects context and slot changes", () => {
  const original = request(), corrected = request();
  const payload = JSON.parse(corrected.messages[1].content);
  payload.pageMap[0].beat = "revised";
  corrected.messages[1].content = JSON.stringify(payload);
  assert.doesNotThrow(() => assertOracleIsolation(original, corrected));
  assert.throws(() => assertOracleIsolation(original, { ...corrected, temperature: 0.2 }));
  payload.pageMap[0].chapterIndex = 2;
  corrected.messages[1].content = JSON.stringify(payload);
  assert.throws(() => assertOracleIsolation(original, corrected));
});

test("accounting retains failed attempts without double counting reasoning or usage updates", () => {
  assert.deepEqual(summarizeAttempts([
    { status: "failed", usage: [{ promptTokens: 10, outputTokens: 20, reasoningTokens: 15 }] },
    { status: "succeeded", usage: [{ promptTokens: 11, outputTokens: 2 },
      { promptTokens: 11, outputTokens: 30, reasoningTokens: 20 }] }
  ]), { physicalAttempts: 2, promptTokens: 21, outputTokens: 50, totalTokens: 71,
    reasoningTokens: 35, attemptsWithoutUsage: 0, failedAttempts: 1, complete: true });
});

test("missing usage, unfinished attempts, and empty runs cannot establish savings", () => {
  assert.equal(summarizeAttempts([]).complete, false);
  assert.equal(summarizeAttempts([{ status: "failed", usage: [] }]).attemptsWithoutUsage, 1);
  assert.equal(summarizeAttempts([{ status: "failed", usage: [{ outputTokens: 1 }] }]).complete, false);
  assert.equal(summarizeAttempts([{ status: "pending", usage: [{ promptTokens: 1, outputTokens: 1 }] }]).complete, false);
});

test("frozen artifacts cannot be overwritten", () => {
  const directory = mkdtempSync(join(tmpdir(), "allocation-test-")), path = join(directory, "manifest.json");
  try {
    writeExclusive(path, { original: true });
    assert.throws(() => writeExclusive(path, { replacement: true }));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { original: true });
  } finally { rmSync(directory, { recursive: true }); }
});

test("a failed, unaccounted, or duplicated sample cannot advance the experiment", () => {
  const samples = [1, 2].flatMap(pair => ["original", "corrected"].map(variant => ({
    pair, variant, label: `${pair}-${variant}`, result: { status: "completed", usage: { complete: true } }
  })));
  assert.equal(oracleComparisonReadiness(samples).ready, true);
  assert.equal(oracleComparisonReadiness(samples.slice(1)).ready, false);
  const duplicate = [...samples.slice(0, 3), samples[0]];
  assert.equal(oracleComparisonReadiness(duplicate).ready, false);
  samples[0].result.status = "failed";
  assert.equal(oracleComparisonReadiness(samples).ready, false);
  samples[0].result.status = "completed";
  samples[0].result.usage.complete = false;
  assert.equal(oracleComparisonReadiness(samples).ready, false);
});
