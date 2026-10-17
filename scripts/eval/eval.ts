/**
 * Stage-replay and blind-pair eval toolkit — the host entry point. See scripts/eval/README.md.
 *
 *   pnpm exec tsx scripts/eval/eval.ts <command> [options]
 *
 * Container commands (run in the worker container through `docker exec`, because run logs, the
 * database and provider keys live there): extract, replay, judge-api, variants.
 * Host commands: fixtures, pairs, manifest, ingest, aggregate, report, calibrate.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "./lib/args.ts";
import { calibrationPairs, scoreCalibration } from "./lib/calibration.ts";
import { dataDir, ensureDir, loadFixtures, loadResults, readJson, REPO_ROOT, type ReplayResult } from "./lib/fixtures.ts";
import { ARTIFACTS, buildPairSet, keyPath, pairOutcomes, readVerdicts, setDir, verdictPath, type Artifact, type PairInput } from "./lib/pairs.ts";
import { buildReport, tallyFor, type JudgedSet } from "./lib/report.ts";
import { formatShare } from "./lib/stats.ts";

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const root = dataDir(args.get("data"));
const CONTAINER = process.env.EVAL_WORKER_CONTAINER ?? "ai-book-maker-worker-1";

function inContainer(script: string): never {
  // The repo is bind-mounted at /app; translate a host data dir so both sides read the same files.
  const forwarded = [...rest.filter((arg, index) => !(arg === "--data" || rest[index - 1] === "--data") && !arg.startsWith("--data=")), "--data", `/app/${relative(REPO_ROOT, root)}`];
  ensureDir(root);
  const result = spawnSync("docker", ["exec", "-w", "/app/apps/worker", CONTAINER, "pnpm", "exec", "tsx", `/app/scripts/eval/container/${script}.ts`, ...forwarded], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

function requireArg(name: string): string {
  const value = args.get(name);
  if (!value) {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return value;
}

/** `set:judgeA+judgeB` pairs for report/aggregate. */
function judgedSets(spec: string | undefined): JudgedSet[] {
  if (!spec) return [];
  return spec.split(",").map((item) => {
    const [set, judges] = item.split(":");
    return { set: set!, judges: (judges ?? "sol").split("+") };
  });
}

function dispatchPrompt(folders: Array<{ folder: string; path: string }>, set: string, judge: string): string {
  const lines = folders.map(({ folder, path }) => `- folder ${path}\n  write your verdict to ${verdictPath(root, set, judge, folder)}`);
  return [
    "You are a blind reader in a book-quality evaluation. For each folder below, read ONLY the files inside it: instructions.md first, then rubric.md, brief.txt, context.md, A.md and B.md.",
    "Follow instructions.md exactly. Judge each folder on its own; never compare across folders, and never open any other file or directory (no keys, no other verdicts, no repository search, no web).",
    "Write each verdict as JSON only, in the shape rubric.md gives, to the path named under its folder (create the directory if needed). To check a verdict, read back only the file you wrote — never list or glob the verdict directory, which holds other readers' answers. Reply with one line per folder: its name and your preferred letter.",
    "",
    ...lines
  ].join("\n");
}

switch (command) {
  case "extract":
  case "replay":
  case "variants":
    inContainer(command === "variants" ? "replay" : command);
    break;
  case "judge-api":
    inContainer("judge-api");
    break;

  case "fixtures": {
    const indexPath = join(root, "fixtures", "index.json");
    if (!existsSync(indexPath)) {
      console.error(`No fixtures at ${indexPath}; run extract first.`);
      process.exit(1);
    }
    const index = readJson<{ extractedAt: string; since: string; counts: Record<string, number>; strata: Record<string, Record<string, number>>; manuscripts: number; plans: number }>(indexPath);
    console.log(`fixtures in ${join(root, "fixtures")} (extracted ${index.extractedAt}, books since ${index.since}; ${index.plans} plans, ${index.manuscripts} pre-read manuscripts)`);
    for (const [purpose, count] of Object.entries(index.counts)) {
      console.log(`  ${purpose.padEnd(32)} ${String(count).padStart(4)}   ${Object.entries(index.strata[purpose] ?? {}).map(([stratum, n]) => `${stratum}:${n}`).join("  ")}`);
    }
    break;
  }

  case "pairs": {
    const evalName = requireArg("eval");
    const reference = requireArg("reference");
    const candidate = requireArg("candidate");
    const set = args.get("set") ?? `${evalName}.${candidate}-vs-${reference}`;
    const artifact = (args.get("artifact") ?? "chapter") as Artifact;
    if (!(artifact in ARTIFACTS)) throw new Error(`--artifact must be one of ${Object.keys(ARTIFACTS).join(", ")}`);
    const sample = args.num("sample", 0);
    const results = loadResults(root, evalName).filter((result) => result.sample === sample && !result.error);
    const spec = readJson<{ purpose: string }>(join(root, "results", evalName, "eval.json"));
    const fixtures = new Map(loadFixtures(root, spec.purpose).map((fixture) => [fixture.fixtureId, fixture]));
    const byKey = new Map<string, ReplayResult>(results.map((result) => [`${result.variant}|${result.fixtureId}`, result]));
    // --tier / --mode / --ids narrow the pairs to fixtures of those tiers, writing modes or ids (comma lists).
    const tiers = args.list("tier");
    const modes = args.list("mode");
    const only = new Set(args.list("ids"));
    const ids = [...new Set(results.map((result) => result.fixtureId))]
      .filter((id) => byKey.has(`${reference}|${id}`) && byKey.has(`${candidate}|${id}`))
      .filter((id) => (tiers.length === 0 || tiers.includes(fixtures.get(id)?.tier ?? "")) && (modes.length === 0 || modes.includes(fixtures.get(id)?.writingMode ?? "")) && (only.size === 0 || only.has(id)));
    const limited = args.num("limit", 0) > 0 ? ids.slice(0, args.num("limit", 0)) : ids;
    const text = (result: ReplayResult) => result.finalText ?? result.output;
    const inputs: PairInput[] = limited.map((id, index) => {
      const fixture = fixtures.get(id);
      const context = fixture?.context;
      const position = fixture?.chapterIndex !== undefined ? `\n\nThis piece: chapter ${fixture.chapterIndex}${context?.ofChapters ? ` of ${context.ofChapters}` : ""}${context?.chapterTitle ? `, "${context.chapterTitle}"` : ""}.` : "";
      const query = fixture?.query ? `\n\nThe writer asked the researcher: ${fixture.query.query}` : "";
      const around = [context?.prevTail ? `## End of the previous chapter\n\n${context.prevTail}` : "", context?.nextHead ? `## Start of the next chapter\n\n${context.nextHead}` : ""].filter(Boolean).join("\n\n");
      return {
        pairId: `p${String(index + 1).padStart(3, "0")}`,
        textA: text(byKey.get(`${reference}|${id}`)!),
        textB: text(byKey.get(`${candidate}|${id}`)!),
        labelA: reference,
        labelB: candidate,
        brief: `${context?.brief ?? ""}${position}${query}`,
        context: around,
        fixtureId: id,
        sample
      };
    });
    const key = buildPairSet(root, set, artifact, inputs, { evalName, reference, candidate });
    const judged = key.pairs.filter((pair) => !pair.identical).length;
    console.log(`pair set ${set}: ${key.pairs.length} pairs (${judged} to judge in both orders = ${judged * 2} folders; ${key.pairs.length - judged} identical → tie)`);
    console.log(`folders: ${join(setDir(root, set), "folders")}\nkey (keep away from judges): ${keyPath(root, set)}`);
    break;
  }

  case "manifest": {
    const set = requireArg("set");
    const judge = args.get("judge") ?? "opus";
    const manifest = readJson<{ folders: Array<{ folder: string; path: string }> }>(join(setDir(root, set), "manifest.json"));
    const pending = manifest.folders.filter(({ folder }) => !existsSync(verdictPath(root, set, judge, folder)));
    const batch = args.num("batch", 4);
    // Never put both orders of one pair in the same batch: a reader must not see a pair twice.
    const groups: Array<typeof pending> = [];
    for (const entry of [...pending].sort((a, b) => a.folder.localeCompare(b.folder))) {
      const pair = entry.folder.replace(/-o\d+$/, "");
      const open = groups.find((group) => group.length < batch && !group.some((other) => other.folder.replace(/-o\d+$/, "") === pair));
      if (open) open.push(entry);
      else groups.push([entry]);
    }
    const batches = groups.map((group) => dispatchPrompt(group, set, judge));
    const out = join(setDir(root, set), `dispatch-${judge}.json`);
    writeFileSync(out, `${JSON.stringify({ set, judge, pending: pending.length, batches }, null, 2)}\n`);
    console.log(`${pending.length} folders without a ${judge} verdict, in ${batches.length} reader prompts → ${out}`);
    if (args.flag("print")) for (const prompt of batches) console.log(`\n---\n${prompt}`);
    break;
  }

  case "ingest": {
    const set = requireArg("set");
    const judge = args.get("judge") ?? "opus";
    const manifest = readJson<{ folders: Array<{ folder: string }> }>(join(setDir(root, set), "manifest.json"));
    const { verdicts, problems } = readVerdicts(root, set, judge);
    const missing = manifest.folders.filter(({ folder }) => !verdicts.has(folder)).map(({ folder }) => folder);
    console.log(`${judge}: ${verdicts.size}/${manifest.folders.length} verdicts valid; ${problems.length} malformed; ${missing.length} missing`);
    for (const problem of problems) console.log(`  malformed: ${problem}`);
    if (missing.length) console.log(`  missing: ${missing.join(", ")}`);
    process.exit(problems.length ? 1 : 0);
    break;
  }

  case "aggregate": {
    const sets = judgedSets(requireArg("sets"));
    for (const judged of sets) {
      const entry = tallyFor(root, judged);
      if (!entry) {
        console.log(`${judged.set}: no key`);
        continue;
      }
      const { key, tally, identical, missing } = entry;
      console.log(`${judged.set} [${judged.judges.join("+")}] ${key.candidate} vs ${key.reference}: W/T/L ${tally.wins}/${tally.ties}/${tally.losses} (identical ${identical}, missing ${missing}); decided win share ${formatShare(tally.winShare)}; win+tie ${formatShare(tally.winOrTie)}; sign p ${tally.signP.toFixed(3)}`);
    }
    break;
  }

  case "report": {
    const evalName = requireArg("eval");
    const markdown = buildReport(root, evalName, judgedSets(args.get("pairs")));
    const out = join(ensureDir(join(root, "reports")), `${evalName}.md`);
    writeFileSync(out, markdown);
    console.log(markdown);
    console.log(`written: ${out}`);
    break;
  }

  case "calibrate": {
    const action = args._[0];
    const set = args.get("set") ?? "calibration";
    if (action === "build") {
      const key = buildPairSet(root, set, "chapter", calibrationPairs());
      console.log(`calibration set ${set}: ${key.pairs.length} pairs → ${join(setDir(root, set), "folders")}`);
    } else if (action === "score") {
      const lines: string[] = [];
      for (const judges of args.list("judges").map((spec) => spec.split("+"))) {
        const { outcomes, problems } = pairOutcomes(root, set, judges);
        const score = scoreCalibration(judges.join("+"), outcomes);
        lines.push(`## ${score.judge}: ${score.accepted ? "ACCEPTED" : "NOT ACCEPTED"}`);
        for (const [cls, entry] of Object.entries(score.byClass)) {
          lines.push(cls === "tie"
            ? `- tie (historically order-dependent): ${entry.n} pairs — judged a tie ${entry.agree}, decided a side ${entry.wrong}${entry.missing ? `, missing ${entry.missing}` : ""}`
            : `- ${cls}: ${entry.n} pairs — agree ${entry.agree}, tie ${entry.tie}, wrong ${entry.wrong}${entry.missing ? `, missing ${entry.missing}` : ""}`);
        }
        lines.push(`- known loser preferred on a clear/synthetic pair: ${score.clearViolations.length ? score.clearViolations.join("; ") : "never"}`);
        if (problems.length) lines.push(`- verdict problems: ${problems.join("; ")}`);
        lines.push("", "| pair | class | known winner | outcome | o1 | o2 |", "|---|---|---|---|---|---|");
        for (const outcome of outcomes) lines.push(`| ${outcome.pairId} | ${outcome.known?.class ?? ""} | ${outcome.known?.winner ?? ""} | ${outcome.winner} | ${outcome.orders.o1 ?? ""} | ${outcome.orders.o2 ?? ""} |`);
        lines.push("");
      }
      const out = join(ensureDir(join(root, "reports")), `${set}-score.md`);
      writeFileSync(out, `${lines.join("\n")}\n`);
      console.log(lines.join("\n"));
      console.log(`written: ${out}`);
    } else {
      console.error("usage: eval.ts calibrate build|score [--set calibration] [--judges sol,opus]");
      process.exit(2);
    }
    break;
  }

  default:
    console.log(readFileSync(join(REPO_ROOT, "scripts", "eval", "README.md"), "utf8").split("\n## ")[0]);
    console.log("commands: extract, replay, variants, judge-api, fixtures, pairs, manifest, ingest, aggregate, report, calibrate build|score");
    process.exit(command ? 2 : 0);
}

