/**
 * H8 judging and statistics, on the host (pre-registered in `.scratch/eval-data/h8/preregistration.md`).
 *
 *   pnpm exec tsx scripts/eval/h8-judge.ts contra-items --sample 0 [--batch 3]   reader items + dispatch prompts
 *   pnpm exec tsx scripts/eval/h8-judge.ts contra-ingest --sample 0 [--judge opus] verify quotes, count per arm
 *   pnpm exec tsx scripts/eval/h8-judge.ts seam-pairs --sample 0 --arm P1          toolkit pair set h8-seam-<arm>-s<n>
 *   pnpm exec tsx scripts/eval/h8-judge.ts stats --samples 0,1                      every pre-registered number
 *   pnpm exec tsx scripts/eval/h8-judge.ts timing                                  modelled loop times from the run logs
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./lib/args.ts";
import { dataDir, ensureDir, readJson, writeJson } from "./lib/fixtures.ts";
import { buildPairSet, pairOutcomes, asWinTieLoss, type PairInput } from "./lib/pairs.ts";
import { formatShare, mean, tallyPairs } from "./lib/stats.ts";
import { foldForMatch, paragraphs, shingles, withoutFences, words } from "./lib/text.ts";
import type { BookRecord, H8Pair, H8Result } from "./variants/h8/types.ts";

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const root = dataDir(args.get("data"));
/** `--dir h8b` points every command at another eval's pairs, results and judging folders. */
const h8 = join(root, args.get("dir") ?? "h8");
const pairs = readJson<H8Pair[]>(join(h8, "pairs.json"));
const ARMS = ["S", "P0", "P1", "PR"] as const;
type Arm = (typeof ARMS)[number];

const resultOf = (arm: Arm, pairId: string, sample: number): H8Result | undefined => {
  const path = join(h8, "results", arm, `${pairId}__s${sample}.json`);
  if (!existsSync(path)) return undefined;
  const result = readJson<H8Result>(path);
  return result.error ? undefined : result;
};

/** Deterministic shuffle per item, so a rebuild gives the same letters. */
function seeded(seedText: string) {
  let seed = 0;
  for (const char of seedText) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) | 0;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONTRA_INSTRUCTIONS = `# Continuity check — instructions

You are a continuity editor checking one chapter of a book against the chapter before it. Your folder holds:

- \`brief.txt\` — what the book is;
- \`ledger.md\` — facts that chapters before the previous one already established (may say "none");
- \`previous-chapter.md\` — the previous chapter, as printed;
- \`version-A.md\`, \`version-B.md\`, … — alternative versions of the chapter that follows it. Each was produced
  independently; judge each one on its own against \`previous-chapter.md\` and \`ledger.md\`.

Read only these files. Do not open any other file or directory, do not search the repository, and do not use the web.
You are not told how the versions were produced; their letters mean nothing.

For **each version**, list every **contradiction**: a statement in the version about a person, place, thing, event or
example person that cannot be true together with what \`previous-chapter.md\` or \`ledger.md\` states about the same one.
These count: a different name or spelling for the same person or thing; a different role, job, title or rank; a
different relation (mother vs sister); a different pronoun or gender; a different age; dead vs alive, or present vs
absent at the same moment; a different date, day, year, season or order of the same events; a different place for the
same event; a document held by someone else, dated or saying something else; a different mark, seal or sign; a
different figure (amount, count, rate, total, time) for the same thing; an event the previous chapter told happening
differently.

These do **not** count: a change the version itself narrates (a promotion, a move, a balance that grew, time passing);
information the earlier text does not give (new facts are fine); the same fact in other words; a difference of
interpretation, emphasis or opinion; style. If you are not sure two mentions are the same referent, do not count it.

List each contradiction once, however often the version repeats it. Quote verbatim and short (at most 25 words):
\`earlier_quote\` copied exactly from \`previous-chapter.md\` or \`ledger.md\` (name which in \`earlier_source\`), and
\`version_quote\` copied exactly from the version. Copy characters exactly; do not paraphrase, and do not shorten a
quote with an ellipsis.

Separately, list \`internal\` contradictions: places where the version disagrees with itself (a fact or figure given two
incompatible ways inside the version, a sum or calculation that does not add up).

Write JSON only, to the verdict path named in your prompt, with every version letter in the folder present (empty
lists when there is nothing):

{
  "versions": {
    "A": {
      "contradictions": [
        { "subject": "…", "kind": "name|role|relation|pronoun|age|alive|date|order|place|document|mark|figure|event|other",
          "earlier_source": "previous-chapter|ledger", "earlier_quote": "…", "version_quote": "…", "explanation": "one sentence" }
      ],
      "internal": [ { "quote_1": "…", "quote_2": "…", "explanation": "one sentence" } ]
    },
    "B": { "contradictions": [], "internal": [] }
  }
}
`;

type ContraKey = { itemId: string; pairId: string; sample: number; letters: Record<string, Arm[]> };
type ContraVerdict = { versions: Record<string, { contradictions?: Array<Record<string, string>>; internal?: Array<Record<string, string>> }> };

const contraDir = (sample: number) => join(h8, "judging", `contra-s${sample}`);
const contraKeyPath = (sample: number) => join(h8, "judging", "_keys", `contra-s${sample}.json`);
const contraVerdictPath = (sample: number, judge: string, itemId: string) => join(h8, "judging", `contra-s${sample}-verdicts`, judge, `${itemId}.json`);

function textOfArm(arm: Arm, pair: H8Pair, sample: number): string | undefined {
  const result = resultOf(arm, pair.pairId, sample);
  return result?.text;
}

/** Strip Markdown emphasis and fold, for quote matching. */
const matchFold = (text: string) => foldForMatch(text.replace(/[*_`#>|]/g, " ")).replace(/\s+/g, " ");
export function quoteFound(quote: string | undefined, haystack: string): boolean {
  if (!quote || !quote.trim()) return false;
  const hay = matchFold(haystack);
  const segments = matchFold(quote).replace(/^["'\s]+|["'\s]+$/g, "").split(/\.\.\.|\[…\]|\[\.\.\.\]/)
    .map((segment) => segment.trim().replace(/^[,.;:!?'"\s-]+|[,.;:!?'"\s-]+$/g, "")).filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  let from = 0;
  for (const segment of segments) {
    const at = hay.indexOf(segment, from);
    if (at < 0) return false;
    from = at + segment.length;
  }
  return true;
}

function seamText(pair: H8Pair, n1Text: string): string {
  const nBlocks = paragraphs(withoutFences(pair.nText)).filter((block) => !block.startsWith("#"));
  const end = nBlocks.slice(-2);
  const start: string[] = [];
  let prose = 0;
  for (const block of paragraphs(withoutFences(n1Text))) {
    start.push(block);
    if (!block.startsWith("#")) prose += 1;
    if (prose >= 3) break;
  }
  return [`## End of chapter ${pair.n}: ${pair.nTitle}`, "", end.join("\n\n"), "", `## Start of chapter ${pair.n1}: ${pair.n1Title}`, "", start.join("\n\n")].join("\n");
}

const shared8 = (earlier: string, later: string) => {
  const a = new Set(shingles(words(foldForMatch(withoutFences(earlier))), 8));
  return new Set(shingles(words(foldForMatch(withoutFences(later))), 8).filter((gram) => a.has(gram))).size;
};

function verifiedCounts(sample: number, judge: string) {
  const keys = existsSync(contraKeyPath(sample)) ? readJson<ContraKey[]>(contraKeyPath(sample)) : [];
  const perArm: Record<Arm, { n: number; contra: number; ledger: number; internal: number; unverified: number; perPair: number[]; details: unknown[] }> =
    Object.fromEntries(ARMS.map((arm) => [arm, { n: 0, contra: 0, ledger: 0, internal: 0, unverified: 0, perPair: [], details: [] }])) as never;
  const missing: string[] = [];
  for (const key of keys) {
    const path = contraVerdictPath(sample, judge, key.itemId);
    if (!existsSync(path)) {
      missing.push(key.itemId);
      continue;
    }
    const verdict = readJson<ContraVerdict>(path);
    const pair = pairs.find((candidate) => candidate.pairId === key.pairId)!;
    const ledgerText = pair.nRequest.establishedFacts.join("\n");
    for (const [letter, arms] of Object.entries(key.letters)) {
      const text = textOfArm(arms[0]!, pair, sample) ?? "";
      const version = verdict.versions?.[letter] ?? { contradictions: [], internal: [] };
      let contra = 0;
      let ledger = 0;
      let unverified = 0;
      const kept: unknown[] = [];
      for (const item of version.contradictions ?? []) {
        const inVersion = quoteFound(item.version_quote, text);
        const inPrevious = quoteFound(item.earlier_quote, pair.nText);
        const inLedger = quoteFound(item.earlier_quote, ledgerText);
        if (!inVersion || (!inPrevious && !inLedger)) {
          unverified += 1;
          continue;
        }
        if (inPrevious) contra += 1;
        else ledger += 1;
        kept.push({ ...item, against: inPrevious ? "N" : "ledger" });
      }
      let internal = 0;
      for (const item of version.internal ?? []) if (quoteFound(item.quote_1, text) && quoteFound(item.quote_2, text)) internal += 1;
      for (const arm of arms) {
        const entry = perArm[arm];
        entry.n += 1;
        entry.contra += contra;
        entry.ledger += ledger;
        entry.internal += internal;
        entry.unverified += unverified;
        entry.perPair.push(contra);
        entry.details.push({ pairId: key.pairId, sample, letter, contradictions: kept });
      }
    }
  }
  return { perArm, missing, items: keys.length };
}

/** The pre-registered bounds on d = (c_X − c_S)/n. */
function rateDifference(cx: number, cs: number, n: number) {
  const d = (cx - cs) / n;
  const se = Math.sqrt(Math.max(cx + cs, 1)) / n;
  return { d, upper95one: d + 1.645 * se, lower95two: d - 1.96 * se, upper95two: d + 1.96 * se };
}

const fmt = (value: number, digits = 3) => (Number.isFinite(value) ? value.toFixed(digits) : "–");

switch (command) {
  case "contra-items": {
    const sample = args.num("sample", 0);
    const batch = args.num("batch", 3);
    const judge = args.get("judge") ?? "opus";
    const dir = ensureDir(contraDir(sample));
    const keys: ContraKey[] = [];
    for (const pair of pairs) {
      const texts = new Map<string, Arm[]>();
      for (const arm of ARMS) {
        const text = textOfArm(arm, pair, sample);
        if (!text) continue;
        const norm = text.replace(/\s+/g, " ").trim();
        const found = [...texts.entries()].find(([existing]) => existing === norm);
        if (found) found[1].push(arm);
        else texts.set(norm, [arm]);
      }
      if (!texts.size || ![...texts.values()].some((arms) => arms.includes("S"))) continue;
      const groups = [...texts.values()];
      const random = seeded(`${pair.pairId}-s${sample}-h8`);
      for (let i = groups.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [groups[i], groups[j]] = [groups[j]!, groups[i]!];
      }
      const itemId = `${pair.pairId}-s${sample}`;
      const folder = ensureDir(join(dir, itemId));
      const letters: Record<string, Arm[]> = {};
      groups.forEach((arms, index) => {
        const letter = String.fromCharCode(65 + index);
        letters[letter] = arms;
        writeFileSync(join(folder, `version-${letter}.md`), `# Chapter ${pair.n1}: ${pair.n1Title}\n\n${textOfArm(arms[0]!, pair, sample)!.trim()}\n`);
      });
      writeFileSync(join(folder, "instructions.md"), CONTRA_INSTRUCTIONS);
      writeFileSync(join(folder, "brief.txt"), `${pair.brief}\n\nThe previous chapter is chapter ${pair.n} of ${pair.ofChapters}; the versions are chapter ${pair.n1}.\n`);
      writeFileSync(join(folder, "ledger.md"), pair.nRequest.establishedFacts.length ? `# Established before chapter ${pair.n}\n\n${pair.nRequest.establishedFacts.map((line) => `- ${line}`).join("\n")}\n` : "none\n");
      writeFileSync(join(folder, "previous-chapter.md"), `# Chapter ${pair.n}: ${pair.nTitle}\n\n${pair.nText.trim()}\n`);
      keys.push({ itemId, pairId: pair.pairId, sample, letters });
    }
    writeJson(contraKeyPath(sample), keys);
    const pending = keys.filter((key) => !existsSync(contraVerdictPath(sample, judge, key.itemId)));
    const prompts: string[] = [];
    for (let i = 0; i < pending.length; i += batch) {
      const group = pending.slice(i, i + batch);
      prompts.push([
        "You are a blind continuity reader in a book-quality evaluation. For each folder below, read ONLY the files inside it: instructions.md first, then brief.txt, ledger.md, previous-chapter.md and every version-*.md file.",
        "Follow instructions.md exactly. Judge each folder on its own; never compare across folders, and never open any other file or directory (no keys, no results, no other verdicts, no repository search, no web).",
        "Write each verdict as JSON only, in the shape instructions.md gives, to the path named under its folder (create the directory if needed). To check a verdict, read back only the file you wrote. Reply with one line per folder: its name and the number of contradictions you listed per version letter.",
        "",
        ...group.map((key) => `- folder ${join(contraDir(sample), key.itemId)}\n  write your verdict to ${contraVerdictPath(sample, judge, key.itemId)}`)
      ].join("\n"));
    }
    writeJson(join(h8, "judging", `dispatch-contra-s${sample}-${judge}.json`), { sample, judge, pending: pending.length, prompts });
    console.log(`${keys.length} items (${keys.reduce((sum, key) => sum + Object.keys(key.letters).length, 0)} versions), ${pending.length} pending, ${prompts.length} reader prompts`);
    break;
  }

  case "contra-ingest": {
    const sample = args.num("sample", 0);
    const judge = args.get("judge") ?? "opus";
    const { perArm, missing, items } = verifiedCounts(sample, judge);
    console.log(`sample ${sample}: ${items - missing.length}/${items} items judged; missing ${missing.join(", ") || "none"}`);
    for (const arm of ARMS) {
      const entry = perArm[arm];
      console.log(`${arm}: n=${entry.n} N↔N+1 verified ${entry.contra} (${fmt(entry.contra / Math.max(entry.n, 1))}/pair) ledger ${entry.ledger} internal ${entry.internal} unverified ${entry.unverified}`);
    }
    break;
  }

  case "seam-pairs": {
    const sample = args.num("sample", 0);
    const arm = (args.get("arm") ?? "P1") as Arm;
    const only = args.flag("differs-from-p1");
    const set = args.get("set") ?? `h8-seam-${arm}-s${sample}`;
    const inputs: PairInput[] = [];
    for (const pair of pairs) {
      const serial = textOfArm("S", pair, sample);
      const candidate = textOfArm(arm, pair, sample);
      if (!serial || !candidate) continue;
      if (only) {
        const p1 = textOfArm("P1", pair, sample);
        if (p1 && seamText(pair, p1) === seamText(pair, candidate)) continue;
      }
      inputs.push({
        pairId: `${pair.pairId}s${sample}`,
        textA: seamText(pair, serial),
        textB: seamText(pair, candidate),
        labelA: "S",
        labelB: arm,
        brief: `${pair.brief}\n\nThis excerpt is the turn from chapter ${pair.n} to chapter ${pair.n1} of ${pair.ofChapters}.`,
        context: "",
        fixtureId: pair.pairId,
        sample
      });
    }
    const key = buildPairSet(root, set, "seam", inputs, { evalName: args.get("dir") ?? "h8", reference: "S", candidate: arm });
    console.log(`${set}: ${key.pairs.length} pairs, ${key.pairs.filter((pair) => pair.identical).length} identical`);
    break;
  }

  case "stats": {
    const samples = args.list("samples").map(Number);
    const judge = args.get("judge") ?? "opus";
    const totals: Record<Arm, { n: number; contra: number; ledger: number; internal: number; unverified: number }> =
      Object.fromEntries(ARMS.map((arm) => [arm, { n: 0, contra: 0, ledger: 0, internal: 0, unverified: 0 }])) as never;
    for (const sample of samples) {
      const { perArm, missing } = verifiedCounts(sample, judge);
      if (missing.length) console.log(`sample ${sample}: missing verdicts ${missing.join(", ")}`);
      for (const arm of ARMS) for (const field of ["n", "contra", "ledger", "internal", "unverified"] as const) totals[arm][field] += perArm[arm][field];
    }
    console.log("\n## Contradictions (reader, quote-verified)");
    for (const arm of ARMS) {
      const entry = totals[arm];
      const versus = arm === "S" ? "" : (() => {
        const n = Math.min(entry.n, totals.S.n);
        const diff = rateDifference(entry.contra, totals.S.contra, n);
        return ` d=${fmt(diff.d)} one-sided95 upper=${fmt(diff.upper95one)} two-sided95 [${fmt(diff.lower95two)}, ${fmt(diff.upper95two)}]`;
      })();
      console.log(`${arm}: n=${entry.n} N↔N+1=${entry.contra} (${fmt(entry.contra / Math.max(entry.n, 1))}/pair) ledger=${entry.ledger} internal=${entry.internal} (${fmt(entry.internal / Math.max(entry.n, 1))}/pair) unverified=${entry.unverified}${versus}`);
    }
    console.log("\n## Code key-conflicts, repetition, length, calls");
    for (const arm of ARMS) {
      const results = samples.flatMap((sample) => pairs.map((pair) => ({ pair, result: resultOf(arm, pair.pairId, sample) }))).filter((entry) => entry.result);
      const conflicts = results.map(({ result }) => result!.conflicts?.length ?? 0);
      const grams = results.map(({ pair, result }) => shared8(pair.nText, result!.text));
      const lengths = results.map(({ result }) => words(result!.text).length);
      const composeMs = results.flatMap(({ result }) => result!.calls.filter((call) => call.purpose === "compose-chapter").map((call) => call.latencyMs));
      const fired = results.filter(({ result }) => result!.repair?.fired);
      const changed = results.filter(({ result }) => result!.repair?.changed);
      const usd = results.reduce((sum, { result }) => sum + result!.calls.reduce((inner, call) => inner + (call.costUsd ?? 0), 0), 0);
      console.log(`${arm}: n=${results.length} keyConflicts=${conflicts.reduce((a, b) => a + b, 0)} (${fmt(mean(conflicts))}/pair, pairs with ≥1: ${conflicts.filter((c) => c > 0).length}) shared8=${fmt(mean(grams), 2)} (max ${Math.max(...grams, 0)}) words=${Math.round(mean(lengths))} composeMs=${Math.round(mean(composeMs))}${arm === "PR" ? ` repairFired=${fired.length} changed=${changed.length} repairMs=${Math.round(mean(fired.map(({ result }) => result!.repair?.latencyMs ?? 0)))}` : ""} usd=${usd.toFixed(4)}`);
    }
    break;
  }

  case "timing": {
    const booksDir = join(root, "h8", "books");
    const books = readdirSync(booksDir).filter((file) => file.endsWith(".json")).map((file) => readJson<BookRecord>(join(booksDir, file)));
    const penalty = args.num("penalty", 1.25);
    const fireRate = args.num("fire-rate", 0);
    const repairMs = args.num("repair-ms", 0);
    const serialHead = args.num("serial-head", 0);
    const rows: Array<Record<string, number | string>> = [];
    for (const book of books) {
      const run = [...book.runs].sort((a, b) => b.calls.length - a.calls.length)[0]!;
      const compose = new Map<number, number>();
      const facts = new Map<number, number>();
      let first = Number.POSITIVE_INFINITY;
      let last = 0;
      for (const call of run.calls) {
        if (call.chapterIndex === null || !call.startedAt || !call.endedAt) continue;
        if (call.purpose === "compose-chapter") {
          compose.set(call.chapterIndex, (compose.get(call.chapterIndex) ?? 0) + call.durationMs);
          first = Math.min(first, Date.parse(call.startedAt));
          last = Math.max(last, Date.parse(call.endedAt));
        }
        if (call.purpose === "extract-chapter-facts") facts.set(call.chapterIndex, call.durationMs);
      }
      const chapters = [...compose.keys()].sort((a, b) => a - b);
      if (chapters.length < 2) continue;
      const lastChapter = chapters.at(-1)!;
      const c = (index: number) => compose.get(index) ?? 0;
      const f = (index: number) => (index === lastChapter ? 0 : facts.get(index) ?? 0);
      const meanFacts = mean([...facts.values()]);
      const serial = chapters.reduce((sum, index) => sum + c(index) + f(index), 0);
      const parallel = (inflation: number, reconcile: boolean) => {
        let total = 0;
        // `--serial-head 2` (H8b): the first chapters stay serial, lanes start after them.
        for (const index of chapters.slice(0, serialHead)) total += c(index) + f(index);
        for (let i = serialHead; i < chapters.length; i += 2) {
          const a = chapters[i]!;
          const b = chapters[i + 1];
          if (b === undefined) {
            total += c(a) + f(a);
            continue;
          }
          // The even chapter's facts are read in every case (the next pair reads them); the last chapter's only for the reconciliation.
          const fb = b === lastChapter ? (reconcile ? meanFacts : 0) : f(b);
          total += Math.max(c(a), c(b)) * inflation + Math.max(f(a), fb) + (reconcile ? fireRate * repairMs : 0);
        }
        return total;
      };
      rows.push({
        book: book.projectId.slice(0, 10), tier: book.tier, mode: book.writingMode.slice(0, 12), pages: book.targetPages, chapters: chapters.length,
        measured: Math.round((last - first) / 1000), serial: Math.round(serial / 1000),
        p1: Math.round(parallel(1, false) / 1000), p1pen: Math.round(parallel(penalty, false) / 1000),
        pr: Math.round(parallel(1, true) / 1000), prpen: Math.round(parallel(penalty, true) / 1000)
      });
    }
    rows.sort((a, b) => Number(a.pages) - Number(b.pages));
    console.log("book       tier     mode         pages ch measured serial | P1 (save) P1+pen | PR (save) PR+pen");
    for (const row of rows) {
      const save = (value: number) => `${Math.round((1 - value / Number(row.serial)) * 100)}%`;
      console.log(`${row.book} ${String(row.tier).padEnd(8)} ${String(row.mode).padEnd(12)} ${String(row.pages).padStart(5)} ${String(row.chapters).padStart(2)} ${String(row.measured).padStart(8)} ${String(row.serial).padStart(6)} | ${row.p1} (${save(Number(row.p1))}) ${row.p1pen} (${save(Number(row.p1pen))}) | ${row.pr} (${save(Number(row.pr))}) ${row.prpen} (${save(Number(row.prpen))})`);
    }
    writeJson(join(h8, "timing.json"), rows);
    break;
  }

  case "dump": {
    // Every verified contradiction with its arm, pair and sample, for the report's breakdowns.
    const samples = args.list("samples").map(Number);
    const judge = args.get("judge") ?? "opus";
    const rows: unknown[] = [];
    for (const sample of samples) {
      const { perArm } = verifiedCounts(sample, judge);
      for (const arm of ARMS) for (const detail of perArm[arm].details as Array<{ pairId: string; contradictions: unknown[] }>) {
        const pair = pairs.find((candidate) => candidate.pairId === detail.pairId)!;
        rows.push({ arm, sample, pairId: detail.pairId, n: pair.n, tier: pair.tier, mode: pair.writingMode, contradictions: detail.contradictions,
          conflicts: resultOf(arm, pair.pairId, sample)?.conflicts ?? [] });
      }
    }
    writeJson(join(h8, "verified-contradictions.json"), rows);
    console.log(`${rows.length} arm-pair-sample rows → ${join(h8, "verified-contradictions.json")}`);
    break;
  }

  case "futility": {
    // The pre-registered conditional pass probability: the remaining items drawn as independent Poisson counts at the
    // observed per-item rates of S and the candidate, rule (a) read at --final.
    const samples = args.list("samples").map(Number);
    const judge = args.get("judge") ?? "opus";
    const candidate = (args.get("arm") ?? "P1") as Arm;
    const finalN = args.num("final", 90);
    let cs = 0;
    let cx = 0;
    let n = 0;
    for (const sample of samples) {
      const { perArm } = verifiedCounts(sample, judge);
      cs += perArm.S.contra;
      cx += perArm[candidate].contra;
      n += Math.min(perArm.S.n, perArm[candidate].n);
    }
    const remaining = Math.max(0, finalN - n);
    const poisson = (lambda: number) => {
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      for (;;) {
        p *= Math.random();
        if (p < limit) return k;
        k += 1;
      }
    };
    const passes = (x: number, s: number) => (x - s) / finalN + 1.645 * Math.sqrt(Math.max(x + s, 1)) / finalN <= 0.1;
    const trials = 100_000;
    let ok = 0;
    for (let trial = 0; trial < trials; trial += 1) {
      if (passes(cx + poisson((cx / n) * remaining), cs + poisson((cs / n) * remaining))) ok += 1;
    }
    // Deterministic: the best case for the candidate is no further contradictions of its own and as many of S's as
    // the remaining items could plausibly hold; report the S count it would need.
    let needed: number | undefined;
    for (let more = 0; more <= remaining * 3; more += 1) if (passes(cx, cs + more)) { needed = more; break; }
    const now = rateDifference(cx, cs, n);
    console.log(`n=${n} S=${cs} ${candidate}=${cx} d=${fmt(now.d)} upper=${fmt(now.upper95one)}; final n=${finalN}, remaining ${remaining}; conditional pass probability ${(ok / trials * 100).toFixed(1)}%; best case needs S +${needed ?? ">" + remaining * 3} more with ${candidate} +0`);
    break;
  }

  case "seam-tally": {
    const set = args.get("set")!;
    const judges = (args.get("judges") ?? "opus").split("+");
    const { outcomes, problems } = pairOutcomes(root, set, judges);
    const candidate = outcomes[0]?.labelB ?? "";
    const tally = tallyPairs(asWinTieLoss(outcomes, candidate));
    console.log(`${set}: ${candidate} vs S W/T/L ${tally.wins}/${tally.ties}/${tally.losses} missing ${outcomes.filter((outcome) => outcome.winner === "missing").length}; decided ${formatShare(tally.winShare)}; win+tie ${formatShare(tally.winOrTie)}; problems ${problems.length}`);
    break;
  }

  default:
    console.log("commands: contra-items, contra-ingest, seam-pairs, seam-tally, stats, timing");
}
