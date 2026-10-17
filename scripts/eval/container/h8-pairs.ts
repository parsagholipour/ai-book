/**
 * H8 — the frozen neighbour pairs. Runs INSIDE the worker container (it imports core's normaliser and
 * fact-line renderer read-only):
 *
 *   docker exec -w /app/apps/worker ai-book-maker-worker-1 pnpm exec tsx /app/scripts/eval/container/h8-pairs.ts
 *
 * Reads `h8/books/*.json` (h8-extract.ts) and `h8/selection.json` ({ projectId, pairs: [[N, N+1], …] }[]),
 * and writes `h8/pairs.json`: per pair, chapter N's draft (the compose reply chapter N+1 was written
 * against, found by its tail in N+1's logged request), chapter N+1's first logged compose request, the
 * ledger before N (facts and the lines N's own compose request carried), N's facts, and N's planned
 * composition (sections, owns, landing). Read-only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "../../../packages/core/src/index.ts";
import { parseArgs } from "../lib/args.ts";
import { dataDir, readJson, writeJson, type ChatMessage } from "../lib/fixtures.ts";
import { foldForMatch, parseJsonReply, unwrapWholeFence, words } from "../lib/text.ts";
import type { BookRecord, H8Pair, LoggedRecordCall } from "../variants/h8/types.ts";

process.umask(0);
const root = dataDir();
/** `--dir h8b`: the eval's own folder for selection.json and pairs.json; book records are shared under h8/books. */
const evalDir = parseArgs(process.argv.slice(2)).get("dir") ?? "h8";
const selection = readJson<Array<{ projectId: string; pairs: Array<[number, number]> }>>(join(root, evalDir, "selection.json"));

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const payloadOf = (messages: ChatMessage[]) => asRecord(parseJsonReply([...messages].reverse().find((message) => message.role === "user")?.content ?? ""));
const systemOf = (messages: ChatMessage[]) => messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");

function factsOf(raw: unknown): core.ChapterFact[] {
  return Array.isArray(raw) ? raw.map((fact) => core.storedChapterFact(fact)).filter((fact): fact is core.ChapterFact => Boolean(fact)) : [];
}

const tailKey = (text: string) => words(foldForMatch(text)).slice(-25).join(" ");

const pairs: H8Pair[] = [];
let serial = 0;
for (const entry of selection) {
  const book = JSON.parse(readFileSync(join(root, "h8", "books", `${entry.projectId}.json`), "utf8")) as BookRecord;
  const toolkit = book.writingMode === "instructional";
  const calls = book.runs.flatMap((run) => run.calls);
  const composes = calls.filter((call) => call.purpose === "compose-chapter" && call.ok).sort((a, b) => Date.parse(a.startedAt ?? "") - Date.parse(b.startedAt ?? ""));
  for (const [n, n1] of entry.pairs) {
    serial += 1;
    const pairId = `p${String(serial).padStart(2, "0")}`;
    // N+1's request: the first attempt (no length-retry shortfall, no second variant).
    const n1Calls = composes.filter((call) => call.chapterIndex === n1);
    const n1Call = n1Calls[0] as LoggedRecordCall | undefined;
    if (!n1Call) throw new Error(`${pairId} ${entry.projectId}: no compose call for chapter ${n1}`);
    if (/This is the second of two drafts/.test(systemOf(n1Call.messages))) throw new Error(`${pairId}: first N+1 call is a second variant`);
    const n1Payload = payloadOf(n1Call.messages);
    const tail = String(n1Payload.previousChapterTail ?? "");
    if (!tail) throw new Error(`${pairId}: N+1 request carries no previousChapterTail`);
    // N's draft: the compose reply whose end is that tail.
    const nCalls = composes.filter((call) => call.chapterIndex === n);
    const nTitle = book.chapters.find((chapter) => chapter.index === n)?.title ?? "";
    const n1Title = book.chapters.find((chapter) => chapter.index === n1)?.title ?? "";
    const normalize = (text: string, title: string) => core.normalizeChapterMarkdown(unwrapWholeFence(text), { chapterTitle: title, ...(toolkit ? { keepSubheadings: true } : {}) });
    const nCall = nCalls.find((call) => tailKey(normalize(call.text, nTitle)) === tailKey(tail)) ?? nCalls.find((call) => foldForMatch(call.text).includes(foldForMatch(tail).slice(-200)));
    if (!nCall) throw new Error(`${pairId}: no chapter ${n} compose reply ends with N+1's previousChapterTail`);
    const nPayload = payloadOf(nCall.messages);
    const nChapter = book.chapters.find((chapter) => chapter.index === n);
    const ledgerBeforeN = book.chapters.filter((chapter) => chapter.index < n).flatMap((chapter) => factsOf(chapter.facts));
    const factsN = factsOf(nChapter?.facts);
    const composition = asRecord(nChapter?.composition);
    const sections = Array.isArray(composition.sections) ? composition.sections.map((section) => asRecord(section)) : [];
    // The plan-derived digest the pass gives N+1 for N before N's pages are described.
    const earlier = Array.isArray(n1Payload.earlierChapters) ? n1Payload.earlierChapters.map((item) => asRecord(item)) : [];
    const nDigest = earlier.find((item) => item.index === n);
    // The pass clips each earlier digest to sixty words (`earlierChapterContext`).
    const plannedDigest = core.chapterDigest(sections.map((section) => String(section.subject ?? ""))).split(/\s+/).slice(0, 60).join(" ");
    pairs.push({
      pairId,
      projectId: book.projectId,
      tier: book.tier,
      writingMode: book.writingMode,
      language: book.language,
      lane: book.lane,
      bookTitle: book.title,
      brief: [`Title: ${book.title}`, book.audience ? `Audience: ${String(book.audience)}` : "", book.premise ? `Premise: ${String(book.premise)}` : ""].filter(Boolean).join("\n"),
      n,
      n1,
      ofChapters: book.chapters.length,
      nTitle,
      n1Title,
      nText: normalize(nCall.text, nTitle),
      nCallId: nCall.callId,
      nRequest: {
        establishedFacts: Array.isArray(nPayload.establishedFacts) ? nPayload.establishedFacts.map(String) : [],
        continuityNotes: Array.isArray(nPayload.continuityNotes) ? nPayload.continuityNotes.map(String) : [],
        ...(Array.isArray(nPayload.storyState) ? { storyState: nPayload.storyState.map(String) } : {})
      },
      n1Request: { callId: n1Call.callId, messages: n1Call.messages, ...(n1Call.temperature !== undefined ? { temperature: n1Call.temperature } : {}), ...(n1Call.maxTokens !== undefined ? { maxTokens: n1Call.maxTokens } : {}) },
      n1Recorded: { text: normalize(n1Call.text, n1Title), durationMs: n1Call.durationMs, usage: n1Call.usage },
      n1Attempts: n1Calls.length,
      ledgerBeforeN,
      factsN,
      nComposition: {
        sections: sections.map((section) => ({ form: String(section.form ?? ""), subject: String(section.subject ?? ""), owns: Array.isArray(section.owns) ? section.owns.map(String) : [] })),
        landing: String(composition.landing ?? "")
      },
      checks: {
        nDigestIsPlanned: Boolean(nDigest) && String(nDigest?.digest ?? "") === plannedDigest,
        ledgerLinesMatch: JSON.stringify(core.chapterFactLines(ledgerBeforeN)) === JSON.stringify((Array.isArray(nPayload.establishedFacts) ? nPayload.establishedFacts : []).map(String)),
        n1HasFacts: Array.isArray(n1Payload.establishedFacts) && n1Payload.establishedFacts.length > 0
      }
    });
  }
}
writeJson(join(root, evalDir, "pairs.json"), pairs);
for (const pair of pairs) {
  console.log(`${pair.pairId} ${pair.projectId.slice(0, 10)} ${pair.tier.padEnd(8)} ${pair.writingMode.padEnd(13)} ${pair.n}->${pair.n1}/${pair.ofChapters} nWords=${words(pair.nText).length} ledger=${pair.ledgerBeforeN.length} factsN=${pair.factsN.length} landing=${pair.nComposition.landing ? "y" : "n"} ${JSON.stringify(pair.checks)}`);
}
