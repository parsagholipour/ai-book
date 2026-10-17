/**
 * E2 arms for the chapter line edit (harness plan §H2), built on one shared edit per fixture × sample so
 * the arms differ only in what decides which of its changes reach print:
 *
 *   today           (b) the edit — sample 0 as recorded in the book, sample 1 the `baseline` replay of the same
 *                   sample — through the product's guards and, on Balanced, today's whole-chapter acceptance
 *                   (sample 0: the recorded verdict; sample 1: today's acceptance prompt on the replayed edit).
 *   hunk-judged     (d) `today`'s edit split into hunks; one acceptance call at medium effort judges each hunk.
 *   hunk-protected  (d′) `today`'s edit; code reverts every hunk that changes a number, name or negation unless
 *                   the fact ledger licenses it. No call.
 *
 * Run order: `baseline` (samples 0–1) → `today` → `hunk-judged`, `hunk-protected` (each reads its peer's result).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chapterEditAcceptanceSystem } from "../../../packages/core/src/generation/chapterEditAcceptance.ts";
import { core, costOf } from "../container/runtime.ts";
import { dataDir, readJsonl, type ChatMessage, type Fixture, type FixtureUsage, type ReplayResult } from "../lib/fixtures.ts";
import { closeOverMoves, diffChapter, knownNamesOf, mergeHunks, mergeIntroducesDuplicate, protectedChange, type HunkDiff } from "./chapterEditHunks.ts";
import { compositionFromEditorSystem, hunkAcceptancePayload, hunkAcceptanceSystem, readHunkVerdicts } from "./hunkAcceptance.ts";
import { chapterFinal } from "./common.ts";
import type { Variant, VariantContext } from "./types.ts";

type Cost = { usage: FixtureUsage; latencyMs: number; costUsd: number | null };
type AcceptanceRow = { editFixtureId: string; messages: ChatMessage[]; response: { data?: unknown }; usage: FixtureUsage; durationMs: number; model: { provider: string; model: string } };
const ZERO: FixtureUsage = { promptTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheHitTokens: 0 };

let acceptanceRows: Map<string, AcceptanceRow> | undefined;
function loggedAcceptance(fixtureId: string): AcceptanceRow | undefined {
  acceptanceRows ??= new Map(readJsonl<AcceptanceRow>(join(dataDir(), "fixtures", "edit-acceptance.jsonl")).map((row) => [row.editFixtureId, row]));
  return acceptanceRows.get(fixtureId);
}

const budgetOf = (fixture: Fixture) => (fixture.payload?.wordBudget ?? {}) as { min: number; target: number; max: number };
const draftOf = (fixture: Fixture) => String(fixture.payload?.draft ?? "");

/** What `editChapter` itself refuses before any review: a cut past the floor, a third lost, a degenerate text. */
export function productGuards(fixture: Fixture, draft: string, edit: string): { passed: boolean; failed: string[] } {
  const budget = budgetOf(fixture);
  const failed: string[] = [];
  if (!edit.trim()) failed.push("empty");
  if (budget.min && core.editShortensPastFloor(draft, edit, budget.min)) failed.push("shortens_past_floor");
  if (core.proseWordCount(edit) < core.proseWordCount(draft) * 0.62) failed.push("lost_a_third");
  if (budget.max && core.chapterDegeneracy(edit, { maxWords: budget.max, language: fixture.language }).degenerate) failed.push("degenerate");
  return { passed: failed.length === 0, failed };
}

const passes = (data: unknown) => {
  const record = (data ?? {}) as Record<string, unknown>;
  return record.meaning === "pass" && record.intent === "pass";
};

const sum = (...costs: Array<Cost | null | undefined>): Cost => ({
  usage: costs.reduce<FixtureUsage>((total, cost) => (cost ? { promptTokens: total.promptTokens + cost.usage.promptTokens, outputTokens: total.outputTokens + cost.usage.outputTokens, reasoningTokens: total.reasoningTokens + cost.usage.reasoningTokens, cacheHitTokens: total.cacheHitTokens + cost.usage.cacheHitTokens } : total), ZERO),
  latencyMs: costs.reduce((total, cost) => total + (cost?.latencyMs ?? 0), 0),
  costUsd: costs.reduce<number>((total, cost) => total + (cost?.costUsd ?? 0), 0)
});

export const today: Variant = {
  name: "today",
  description: "E2 (b): the edit (sample 0 recorded, sample 1 = baseline's sample 1) through editChapter's guards and, on Balanced, today's whole-chapter acceptance (recorded verdict / replayed).",
  purposes: ["edit-chapter"],
  async run(context) {
    const { fixture } = context;
    const sample = context.sample ?? 0;
    const draft = draftOf(fixture);
    let raw: string;
    let edit: Cost;
    if (sample === 0) {
      raw = fixture.response.text;
      edit = { usage: fixture.usage, latencyMs: fixture.durationMs, costUsd: costOf(fixture.model, fixture.usage) };
    } else {
      const peer = context.peer?.("baseline");
      if (!peer || peer.error) throw new Error("run `baseline` for this sample first");
      raw = peer.output;
      edit = { usage: peer.usage, latencyMs: peer.latencyMs, costUsd: peer.costUsd };
    }
    const editFinal = chapterFinal(fixture, raw);
    const draftFinal = chapterFinal(fixture, draft);
    const guards = productGuards(fixture, draft, editFinal);
    let acceptance: (Cost & { verdict: string; source: string }) | null = null;
    const calls = [];
    if (guards.passed && fixture.tier !== "fast" && editFinal !== draft) {
      const logged = loggedAcceptance(fixture.fixtureId);
      if (!logged) throw new Error("no logged acceptance call for this Balanced edit (run container/edit-acceptances.ts)");
      if (sample === 0) {
        acceptance = { usage: logged.usage, latencyMs: logged.durationMs, costUsd: costOf(logged.model, logged.usage), verdict: String(fixture.meta.acceptanceVerdict ?? (passes(logged.response.data) ? "pass" : "reject")), source: "recorded" };
      } else {
        const payload = JSON.parse(logged.messages.at(-1)!.content) as Record<string, unknown>;
        const system = chapterEditAcceptanceSystem({ cut: false, establishedFacts: Array.isArray(payload.establishedFacts) && payload.establishedFacts.length > 0 });
        const record = await context.call({ purpose: "review-chapter-edit-acceptance", json: true, temperature: 0.1, maxTokens: 2000, messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify({ ...payload, candidate: editFinal }) }] });
        calls.push(record);
        acceptance = { usage: record.usage, latencyMs: record.latencyMs, costUsd: record.costUsd, verdict: passes(record.data) ? "pass" : "reject", source: "replayed" };
      }
    }
    const accepted = guards.passed && (acceptance === null || acceptance.verdict === "pass");
    const total = sum(edit, acceptance);
    return {
      output: raw,
      finalText: accepted ? editFinal : draftFinal,
      calls,
      extra: { rawEdit: editFinal, editSource: sample === 0 ? "recorded" : "baseline", guards, accepted, verdict: acceptance?.verdict ?? null, edit, acceptance, total }
    };
  }
};

type HunkReport = { id: string; kind: string; words: number; protected: boolean; protectedReasons: string[]; quantifierChange: boolean; ledger: boolean; touchesBlock: boolean; meaning?: string; intent?: string; reason?: string; accepted: boolean };

function baseEdit(context: VariantContext): { draftFinal: string; editFinal: string; guardsPassed: boolean; edit: Cost } {
  const peer: ReplayResult | undefined = context.peer?.("today");
  if (!peer?.extra) throw new Error("run `today` for this sample first");
  const extra = peer.extra as { rawEdit: string; guards: { passed: boolean }; edit: Cost };
  return { draftFinal: chapterFinal(context.fixture, draftOf(context.fixture)), editFinal: extra.rawEdit, guardsPassed: extra.guards.passed, edit: extra.edit };
}

function hunkReports(fixture: Fixture, diff: HunkDiff): HunkReport[] {
  const names = knownNamesOf(diff.draft);
  const facts = Array.isArray(fixture.payload?.establishedFacts) ? (fixture.payload.establishedFacts as unknown[]).map(String) : [];
  return diff.hunks.map((hunk) => {
    const verdict = protectedChange(hunk, names, facts);
    return { id: hunk.id, kind: hunk.kind, words: core.countReadableWords(hunk.before) + core.countReadableWords(hunk.after), protected: verdict.protected, protectedReasons: verdict.reasons, quantifierChange: verdict.quantifierChange, ledger: verdict.ledger, touchesBlock: hunk.touchesBlock, accepted: false };
  });
}

/**
 * The merged chapter, or the draft when the merge fails a guard. Moves are closed over first (a hunk that inserts
 * text another hunk deletes is applied only with it); a merge that prints a near-duplicate sentence neither the draft
 * nor the edit has is refused, as is one that fails the product's own length/degeneracy guards.
 */
function settle(fixture: Fixture, draftFinal: string, diff: HunkDiff, verdictAccepted: Set<string>): { text: string; accepted: Set<string>; mergeGuards: string[] } {
  const accepted = closeOverMoves(diff, verdictAccepted);
  const merged = mergeHunks(diff, accepted);
  if (merged === draftFinal) return { text: draftFinal, accepted, mergeGuards: [] };
  if (mergeIntroducesDuplicate(diff, merged)) return { text: draftFinal, accepted: new Set(), mergeGuards: ["near_duplicate"] };
  const guards = productGuards(fixture, draftOf(fixture), merged);
  return guards.passed ? { text: merged, accepted, mergeGuards: [] } : { text: draftFinal, accepted: new Set(), mergeGuards: guards.failed };
}

function planContext(fixture: Fixture) {
  try {
    const plan = JSON.parse(readFileSync(join(dataDir(), "plans", `${fixture.projectId}.json`), "utf8")) as { planningPackage?: Record<string, unknown>; inputSnapshot?: Record<string, unknown> };
    const pkg = plan.planningPackage ?? {};
    const input = plan.inputSnapshot ?? {};
    const chapter = (Array.isArray(pkg.chapters) ? (pkg.chapters as Array<Record<string, unknown>>) : []).find((entry) => entry.index === fixture.chapterIndex);
    return {
      book: { title: String(pkg.title ?? fixture.context.bookTitle), audience: String(pkg.audience ?? ""), category: String(input.category ?? fixture.category), language: fixture.language, voiceGuide: pkg.voiceGuide, readerBrief: String(input.prompt ?? "") },
      chapter: { index: fixture.chapterIndex ?? 0, title: String(chapter?.title ?? fixture.context.chapterTitle ?? ""), ...(chapter?.summary ? { summary: String(chapter.summary) } : {}) }
    };
  } catch {
    return { book: { title: fixture.context.bookTitle, language: fixture.language }, chapter: { index: fixture.chapterIndex ?? 0, title: fixture.context.chapterTitle ?? "" } };
  }
}

export const hunkJudged: Variant = {
  name: "hunk-judged",
  description: "E2 (d): today's edit split into hunks; one acceptance call (medium effort) judges every hunk pass/regression/needs_review; only passing hunks are applied.",
  purposes: ["edit-chapter"],
  async run(context) {
    const { fixture } = context;
    const base = baseEdit(context);
    if (!base.guardsPassed) return { output: "", finalText: base.draftFinal, calls: [], extra: { hunks: [], skipped: "guards", edit: base.edit, acceptance: null, total: base.edit } };
    const diff = diffChapter(base.draftFinal, base.editFinal);
    const reports = hunkReports(fixture, diff);
    const judged = diff.hunks.filter((hunk) => !hunk.touchesBlock);
    if (judged.length === 0) return { output: "", finalText: base.draftFinal, calls: [], extra: { hunks: reports, edit: base.edit, acceptance: null, total: base.edit } };
    const system = fixture.messages.find((message) => message.role === "system")?.content ?? "";
    const facts = Array.isArray(fixture.payload?.establishedFacts) ? (fixture.payload.establishedFacts as unknown[]).map(String) : [];
    const composition = compositionFromEditorSystem(system);
    const payload = hunkAcceptancePayload(diff, {
      ...planContext(fixture),
      ...(composition ? { composition } : {}),
      establishedFacts: facts,
      allowExtension: /develop the existing sections/.test(system),
      wordBudget: fixture.payload?.wordBudget
    });
    const messages: ChatMessage[] = [
      { role: "system", content: hunkAcceptanceSystem({ establishedFacts: facts.length > 0, caveatOnceRule: core.CAVEAT_ONCE_ACCEPTANCE_RULE, establishedFactsRule: core.ESTABLISHED_FACTS_ACCEPTANCE_RULE }) },
      { role: "user", content: JSON.stringify(payload) }
    ];
    const record = await context.call({ purpose: "review-chapter-edit-acceptance", json: true, temperature: 0.1, maxTokens: Math.min(16_000, 10_000 + 150 * judged.length), messages, route: { thinkingEffort: "medium" } });
    const { verdicts, accepted, malformed } = readHunkVerdicts(record.data, judged.map((hunk) => hunk.id));
    for (const report of reports) {
      const verdict = verdicts.get(report.id);
      if (verdict) Object.assign(report, { meaning: verdict.meaning, intent: verdict.intent, reason: verdict.reason.slice(0, 300) });
      report.accepted = accepted.has(report.id) && !report.touchesBlock;
    }
    const settled = settle(fixture, base.draftFinal, diff, accepted);
    for (const report of reports) report.accepted = settled.accepted.has(report.id);
    const acceptance: Cost = { usage: record.usage, latencyMs: record.latencyMs, costUsd: record.costUsd };
    return {
      output: record.text,
      data: record.data,
      finalText: settled.text,
      calls: [record],
      extra: { hunks: reports, malformed, payloadChars: messages[1]!.content.length, mergeGuards: settled.mergeGuards, edit: base.edit, acceptance, total: sum(base.edit, acceptance) }
    };
  }
};

export const hunkProtected: Variant = {
  name: "hunk-protected",
  description: "E2 (d′): today's edit with every hunk that changes a number, a named entity or a negation reverted (unless the fact ledger licenses it). No call.",
  purposes: ["edit-chapter"],
  async run(context) {
    const { fixture } = context;
    const base = baseEdit(context);
    if (!base.guardsPassed) return { output: "", finalText: base.draftFinal, calls: [], extra: { hunks: [], skipped: "guards", edit: base.edit, total: base.edit } };
    const diff = diffChapter(base.draftFinal, base.editFinal);
    const reports = hunkReports(fixture, diff);
    const settled = settle(fixture, base.draftFinal, diff, new Set(reports.filter((report) => !report.protected && !report.touchesBlock).map((report) => report.id)));
    for (const report of reports) report.accepted = settled.accepted.has(report.id);
    return { output: "", finalText: settled.text, calls: [], extra: { hunks: reports, mergeGuards: settled.mergeGuards, edit: base.edit, total: base.edit } };
  }
};

/** (d) with move-linking and the duplicate guard applied to the verdicts `hunk-judged` already stored: no call. */
export const hunkJudgedLinked: Variant = {
  name: "hunk-judged-linked",
  description: "E2 (d), final merge rules: hunk-judged's stored per-hunk verdicts, closed over moves, with the near-duplicate guard. No call; cost is hunk-judged's.",
  purposes: ["edit-chapter"],
  async run(context) {
    const { fixture } = context;
    const base = baseEdit(context);
    const judged = context.peer?.("hunk-judged");
    if (!judged?.extra) throw new Error("run `hunk-judged` for this sample first");
    const stored = judged.extra as { hunks: HunkReport[]; acceptance: Cost | null; total: Cost; skipped?: string };
    if (!base.guardsPassed) return { output: "", finalText: base.draftFinal, calls: [], extra: { ...stored } };
    const diff = diffChapter(base.draftFinal, base.editFinal);
    const passing = new Set(stored.hunks.filter((hunk) => hunk.meaning === "pass" && hunk.intent === "pass" && !hunk.touchesBlock).map((hunk) => hunk.id));
    const settled = settle(fixture, base.draftFinal, diff, passing);
    const hunks = stored.hunks.map((hunk) => ({ ...hunk, accepted: settled.accepted.has(hunk.id) }));
    return { output: "", finalText: settled.text, calls: [], extra: { ...stored, hunks, mergeGuards: settled.mergeGuards } };
  }
};
