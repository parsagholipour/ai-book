/**
 * Which deterministic checks run for which purpose. Generic gates first (non-empty, truncation,
 * runaway, JSON validity, the recorded reply's shape), then the purpose's own. Product-code checks
 * (`chapterDegeneracy`, patch application) are imported read-only from core.
 */
import {
  changeStats,
  deletionOnly,
  fencesSurvive,
  figuresSurvive,
  jsonValid,
  lengthRatio,
  lengthVsBudget,
  noLeaks,
  noNewProtectedTokens,
  nonEmpty,
  quotations,
  quotesVerified,
  runaway,
  shapeMatches,
  tablesSurvive,
  truncation,
  verifyQuote,
  wordsKept,
  type CheckResult,
  type WordBudget
} from "../lib/checks.ts";
import type { Fixture } from "../lib/fixtures.ts";
import { parseJsonReply, withoutFences, wordCount } from "../lib/text.ts";
import type { VariantOutput } from "../variants/types.ts";
import { core } from "./runtime.ts";

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Every string leaf of a value (dossier excerpts, research notes, episodes) — the haystack a quotation must come from. */
export function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) stringLeaves(item, out);
  return out;
}

function degeneracy(text: string, budget: WordBudget | undefined, language: string): CheckResult {
  if (!budget?.max) return { id: "not_degenerate", pass: null };
  const verdict = core.chapterDegeneracy(text, { maxWords: budget.max, language });
  return { id: "not_degenerate", pass: !verdict.degenerate, ...(verdict.degenerate ? { detail: verdict.reasons.join("; ") } : {}) };
}

function acceptanceVerdict(data: unknown): string | undefined {
  const record = asRecord(data);
  if (typeof record.verdict === "string") return record.verdict;
  if (typeof record.meaning === "string") return record.meaning === "pass" && (record.intent === undefined || record.intent === "pass") ? "pass" : "reject";
  return undefined;
}

export function runChecks(fixture: Fixture, run: VariantOutput, maxTokens: number | undefined): CheckResult[] {
  const out: CheckResult[] = [];
  const payload = fixture.payload ?? {};
  const outputTokens = run.calls.reduce((sum, call) => sum + call.usage.outputTokens, 0) || undefined;
  const text = run.finalText ?? run.output;

  if (fixture.op === "search") {
    const sources = asArray(run.extra?.sources).length || Number(run.extra?.sources ?? 0);
    const grounding = asRecord(run.extra?.grounding);
    out.push({ id: "has_sources", pass: sources > 0, value: sources });
    out.push({ id: "grounded", pass: Number(grounding.searchQueries ?? 0) > 0, value: Number(grounding.searchQueries ?? 0) });
    out.push({ id: "brief_chars", pass: null, value: run.output.length });
    return out;
  }

  if (fixture.op === "generateJson") {
    const data = run.data ?? parseJsonReply(run.output);
    out.push(run.data !== undefined ? { id: "json_valid", pass: true } : jsonValid(run.output));
    out.push(shapeMatches(data, fixture.recordedData));
    const hitBudget = Boolean(maxTokens && outputTokens && outputTokens >= maxTokens * 0.98);
    out.push({ id: "not_truncated", pass: !hitBudget, value: hitBudget ? 1 : 0 });
    const record = asRecord(data);
    switch (fixture.purpose) {
      case "review-chapter-edit-acceptance": {
        const verdict = acceptanceVerdict(record);
        const logged = acceptanceVerdict(fixture.recordedData);
        out.push({ id: "verdict_pass", pass: null, value: verdict === "pass" ? 1 : 0, ...(verdict ? { detail: verdict } : {}) });
        if (logged && verdict) out.push({ id: "agrees_with_recorded", pass: verdict === logged, detail: `${verdict} vs recorded ${logged}` });
        break;
      }
      case "read-manuscript": {
        const chapters = asArray(payload.chapters).map((chapter) => String(asRecord(chapter).text ?? asRecord(chapter).markdown ?? ""));
        const notes = asArray(record.chapters).flatMap((chapter) => asArray(asRecord(chapter).notes).map(String));
        out.push({ id: "notes", pass: null, value: notes.length });
        out.push({ id: "chapters_flagged", pass: null, value: asArray(record.chapters).filter((chapter) => asRecord(chapter).edit === true).length });
        if (chapters.length > 0) {
          const quoted = notes.flatMap((note) => [...note.matchAll(/[“"]([^”"]{12,400})[”"]/g)].map((match) => match[1]!.replace(/\.\.\.$|…$/, "")));
          const verified = quoted.filter((quote) => verifyQuote(quote, chapters.join("\n"))).length;
          out.push({ id: "note_quotes_verified", pass: quoted.length ? verified === quoted.length : null, value: quoted.length ? verified / quoted.length : 1, detail: `${verified}/${quoted.length}` });
        }
        break;
      }
      case "extract-chapter-facts": {
        const subjects = asArray(record.subjects);
        out.push({ id: "subjects", pass: subjects.length > 0, value: subjects.length });
        out.push({ id: "facts", pass: null, value: subjects.reduce<number>((sum, subject) => sum + asArray(asRecord(subject).facts).length, 0) });
        break;
      }
      case "final-book-qa": {
        out.push({ id: "issues", pass: null, value: asArray(record.issues).length });
        out.push({ id: "approved", pass: null, value: record.approved === true ? 1 : 0 });
        break;
      }
      case "patch-page": {
        const pages = new Map(asArray(payload.originalPages).map((page) => [Number(asRecord(page).index), String(asRecord(page).markdown ?? "")]));
        let total = 0;
        let ok = 0;
        for (const page of asArray(record.pages)) {
          const markdown = pages.get(Number(asRecord(page).pageIndex));
          for (const patch of asArray(asRecord(page).patches)) {
            total += 1;
            const find = String(asRecord(patch).find ?? "");
            if (markdown !== undefined && core.applyPagePatches(markdown, [{ find, replace: String(asRecord(patch).replace ?? "") }]).failures.length === 0) ok += 1;
          }
        }
        out.push({ id: "patches_apply", pass: total ? ok === total : null, value: total ? ok / total : 1, detail: `${ok}/${total}` });
        break;
      }
      case "extract-excerpts": {
        const windows = new Map(asArray(payload.windows).map((window) => [String(asRecord(window).id), String(asRecord(window).text ?? "")]));
        const excerpts = asArray(record.excerpts);
        const anchored = excerpts.filter((excerpt) => {
          const window = windows.get(String(asRecord(excerpt).windowId));
          return window !== undefined && verifyQuote(String(asRecord(excerpt).firstWords ?? ""), window) && verifyQuote(String(asRecord(excerpt).lastWords ?? ""), window);
        }).length;
        out.push({ id: "excerpts", pass: null, value: excerpts.length });
        out.push({ id: "excerpts_anchored", pass: excerpts.length ? anchored === excerpts.length : null, value: excerpts.length ? anchored / excerpts.length : 1 });
        break;
      }
    }
    return out;
  }

  // Text purposes.
  out.push(nonEmpty(text));
  out.push(truncation(run.output, outputTokens, maxTokens));
  out.push(runaway(run.output));
  out.push(noLeaks(text));
  const budget = asRecord(payload.wordBudget) as WordBudget;
  const sources = stringLeaves([payload.dossier, payload.episodes, payload.researchNotes, payload.reservedCases]);
  switch (fixture.purpose) {
    case "compose-chapter": {
      out.push(lengthVsBudget(text, budget));
      out.push(degeneracy(text, budget, fixture.language));
      out.push(quotesVerified(text, sources));
      break;
    }
    case "edit-chapter": {
      const draft = String(payload.draft ?? "");
      out.push(lengthVsBudget(text, budget));
      out.push(lengthRatio(draft, text));
      out.push(degeneracy(text, budget, fixture.language));
      out.push(noNewProtectedTokens(draft, text));
      out.push(fencesSurvive(draft, text));
      out.push(tablesSurvive(draft, text));
      out.push(figuresSurvive(draft, text));
      out.push(wordsKept(draft, text));
      const newQuotes = quotations(text).filter((quote) => !verifyQuote(quote, draft));
      out.push({ id: "no_new_unsourced_quotes", pass: newQuotes.every((quote) => verifyQuote(quote, sources.join("\n"))), value: newQuotes.length });
      // What editChapter itself would throw away (refusal/truncation line); the acceptance review is not replayed here.
      const stats = changeStats(draft, text);
      out.push({ id: "product_keeps_edit", pass: wordCount(withoutFences(text)) >= wordCount(withoutFences(draft)) * 0.62 && out.find((check) => check.id === "not_degenerate")?.pass !== false, value: stats.changedSentences });
      break;
    }
    case "cut-chapter": {
      const draft = String(payload.draft ?? "");
      const constraints = asRecord(payload.cutConstraints);
      const words = wordCount(withoutFences(text));
      out.push(deletionOnly(draft, text));
      out.push(lengthRatio(draft, text, 0));
      if (typeof constraints.minimumWords === "number") out.push({ id: "above_floor", pass: words >= constraints.minimumWords, value: words - constraints.minimumWords });
      out.push({ id: "words_removed", pass: null, value: wordCount(withoutFences(draft)) - words });
      break;
    }
  }
  return out;
}
