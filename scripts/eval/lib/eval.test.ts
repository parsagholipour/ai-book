/**
 * Unit tests for the pure half of the eval toolkit. Not part of `pnpm check` (scripts/ has no
 * workspace); run with:  node --import tsx --test scripts/eval/lib/eval.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deletionOnly, noNewProtectedTokens, protectedTokenDelta, quotesVerified, runaway, shapeMatches } from "./checks.ts";
import { stratifiedTake } from "./fixtures.ts";
import { asWinTieLoss, buildPairSet, pairOutcomes, verdictPath } from "./pairs.ts";
import { groupCalls, type RunEvent } from "./runlog.ts";
import { signTest, tallyPairs, wilson } from "./stats.ts";
import { writeJson } from "./fixtures.ts";

test("wilson interval and sign test", () => {
  const interval = wilson(8, 10);
  assert.ok(interval.low > 0.44 && interval.low < 0.5, `low ${interval.low}`);
  assert.ok(interval.high > 0.94 && interval.high < 0.97, `high ${interval.high}`);
  assert.equal(wilson(0, 0).low, 0);
  assert.ok(Math.abs(signTest(8, 0) - 0.0078125) < 1e-9);
  assert.equal(signTest(5, 5), 1);
  const tally = tallyPairs(["win", "win", "tie", "loss"]);
  assert.deepEqual([tally.wins, tally.ties, tally.losses, tally.decided], [2, 1, 1, 3]);
});

test("pair outcomes need both orders to agree", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-test-"));
  try {
    buildPairSet(root, "t", "chapter", [
      { pairId: "p1", textA: "Old text one.", textB: "New text one.", labelA: "ref", labelB: "cand", brief: "b" },
      { pairId: "p2", textA: "Old text two.", textB: "New text two.", labelA: "ref", labelB: "cand", brief: "b" },
      { pairId: "p3", textA: "Same.", textB: "Same.", labelA: "ref", labelB: "cand", brief: "b" }
    ], { reference: "ref", candidate: "cand" });
    // p1: o1 picks B (cand), o2 picks A (cand) → cand wins. p2: o1 B (cand), o2 B (ref) → tie.
    writeJson(verdictPath(root, "t", "j", "p1-o1"), { preferred: "B" });
    writeJson(verdictPath(root, "t", "j", "p1-o2"), { preferred: "A" });
    writeJson(verdictPath(root, "t", "j", "p2-o1"), { preferred: "B" });
    writeJson(verdictPath(root, "t", "j", "p2-o2"), { preferred: "B" });
    const { outcomes } = pairOutcomes(root, "t", ["j"]);
    assert.deepEqual(outcomes.map((outcome) => outcome.winner), ["cand", "tie", "tie"]);
    assert.ok(outcomes[2]!.identical);
    assert.deepEqual(asWinTieLoss(outcomes, "cand"), ["win", "tie", "tie"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected tokens: reordering is not a change, a new number or name is", () => {
  const draft = "In 1987 Maria Lopez met two officials. They did not agree.";
  assert.equal(noNewProtectedTokens(draft, "Two officials met Maria Lopez in 1987. They did not agree.").pass, true);
  const delta = protectedTokenDelta(draft, "In 1988 Maria Lopez met two officials from Lisbon. They agreed.");
  assert.deepEqual(delta.numbersAdded, ["1988"]);
  assert.ok(delta.namesAdded.includes("lisbon"));
  assert.equal(delta.negationsDelta, -1);
});

test("deletion-only, quotes, runaway and shape checks", () => {
  const draft = "First sentence here. Second sentence here. Third sentence here.";
  assert.equal(deletionOnly(draft, "First sentence here. Third sentence here.").pass, true);
  assert.equal(deletionOnly(draft, "First sentence here. A new sentence appears.").pass, false);
  assert.equal(quotesVerified("He wrote “the river was higher than anyone recalled”.", ["…the river was higher than anyone recalled, and…"]).pass, true);
  assert.equal(quotesVerified("He wrote “an invented line that no source has”.", ["nothing"]).pass, false);
  assert.equal(runaway(Array.from({ length: 8 }, () => "The same long sentence is repeated again and again.").join(" ")).pass, false);
  assert.equal(shapeMatches({ a: 1, b: [] }, { a: 2, b: [1] }).pass, true);
  assert.equal(shapeMatches({ a: "x" }, { a: 2, b: [1] }).pass, false);
});

test("run-log grouping by callId", () => {
  const job = { name: "generate-book", projectId: "p" };
  const events: RunEvent[] = [
    { event: "text.generateText.request", timestamp: "2026-10-15T10:00:00.000Z", callId: "c1", job, model: { provider: "openai", model: "m" }, request: { purpose: "edit-chapter", maxTokens: 100, messages: [{ role: "system", content: "s" }, { role: "user", content: "{\"draft\":\"d\"}" }] } },
    { event: "text.generateText.provider_request", callId: "c1", job },
    { event: "text.generateText.response", timestamp: "2026-10-15T10:00:02.500Z", callId: "c1", job, result: { text: "edited", provider: "openai", model: "m", usage: { promptTokens: 10, outputTokens: 5, reasoningTokens: 1 } } }
  ];
  const [call] = groupCalls(events);
  assert.equal(call!.purpose, "edit-chapter");
  assert.equal(call!.durationMs, 2500);
  assert.equal(call!.usage.outputTokens, 5);
  assert.equal(call!.attempts, 1);
  assert.ok(call!.ok);
});

test("stratified take alternates tiers", () => {
  const rows = [
    { id: 1, tier: "balanced", writingMode: "a", lengthBucket: "short" as const },
    { id: 2, tier: "balanced", writingMode: "b", lengthBucket: "short" as const },
    { id: 3, tier: "fast", writingMode: "a", lengthBucket: "short" as const }
  ];
  assert.deepEqual(stratifiedTake(rows, 2).map((row) => row.tier).sort(), ["balanced", "fast"]);
});
