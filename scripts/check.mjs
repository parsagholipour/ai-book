#!/usr/bin/env node
/**
 * The repo gate. Runs every check unconditionally — no `&&` chain, no
 * `pnpm -r` bail — so one run reports the complete state of the tree.
 *
 * Both defects this replaces produced false green for an automated reader:
 * `pnpm -r test` stops at the first failing workspace, so a worker typecheck
 * error hid all 881 API tests, and the `&&` chain meant one failure suppressed
 * lint, the size budget and the tests entirely. Here every gate runs, every
 * failure is named in the summary, and the exit code is 1 if any of them failed.
 *
 * Read the last ten lines: that is the whole point of this script.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Derived from this file, so the gates run against the repo from any cwd. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * `requires` names a file that must exist for the gate to mean anything. A gate
 * whose file is missing is SKIPPED, not failed — `check-gotcha-index.mjs` is
 * landing separately and an absent script must not turn the whole gate red.
 *
 * That is a landing-order concession, not the default. `sizes`, `subpaths` and
 * `subpath-tests` declare no `requires` on purpose: they enforce invariants that
 * were previously enforced by nothing, so a deleted script must not read as a
 * pass — `--only subpaths` going green on an empty `scripts/` directory is the
 * exact false green this runner exists to remove. Drop the `requires` from
 * `gotchas` too once nothing is mid-landing.
 *
 * The cost of that choice is that a missing script and a real violation both
 * exit 1, which `missingScript` below is what separates: a node-run gate whose
 * script is absent fails with `script missing: <path>` in the summary instead of
 * a bare `exit 1` over Node's MODULE_NOT_FOUND stack. Loud, red, and not
 * mistakable for a regression in the thing being gated.
 */
const GATES = [
  {
    name: "typecheck",
    description: "tsc --noEmit across all workspaces",
    command: "pnpm",
    args: ["-r", "--no-bail", "typecheck"]
  },
  {
    name: "lint",
    description: "oxlint",
    command: "pnpm",
    args: ["lint"]
  },
  {
    name: "sizes",
    description: "file-size budget",
    command: "node",
    args: ["scripts/check-file-sizes.mjs"]
  },
  {
    name: "gotchas",
    description: "CLAUDE.md gotcha index",
    command: "node",
    args: ["scripts/check-gotcha-index.mjs"],
    requires: "scripts/check-gotcha-index.mjs"
  },
  {
    name: "subpaths",
    description: "packages/core subpath exports stay runtime-empty, and consumers stay on them",
    command: "node",
    args: ["scripts/check-core-subpaths.mjs"]
  },
  {
    name: "subpath-tests",
    description: "node:test coverage for the packages/core subpath checker",
    command: "node",
    args: ["--test", "scripts/check-core-subpaths.test.mjs"]
  },
  {
    name: "test",
    description: "vitest across all workspaces",
    command: "pnpm",
    args: ["-r", "--no-bail", "test"]
  }
];

const STATUS_LABEL = {
  passed: "PASS",
  failed: "FAIL",
  skipped: "SKIP"
};

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function parseArgs(argv) {
  const only = [];
  let list = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") {
      list = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true, list: false, only: [] };
    }
    if (arg === "--only") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--only needs a gate name");
      }
      only.push(...value.split(","));
      i += 1;
      continue;
    }
    if (arg.startsWith("--only=")) {
      only.push(...arg.slice("--only=".length).split(","));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { help: false, list, only: only.map((name) => name.trim()).filter(Boolean) };
}

function printUsage() {
  console.log("Usage: node scripts/check.mjs [--only <gate>[,<gate>]] [--list]");
  console.log("");
  console.log("Gates:");
  for (const gate of GATES) {
    console.log(`  ${gate.name.padEnd(10)} ${gate.description}`);
  }
}

function isMissing(gate) {
  return Boolean(gate.requires) && !existsSync(join(ROOT, gate.requires));
}

/**
 * The script a node-run gate would execute, when it is not there. Spawning it
 * anyway exits 1 on a MODULE_NOT_FOUND stack that the summary flattens to
 * `exit 1` — the same line a real violation prints. This turns that into its own
 * sentence without letting the gate pass, which is the whole trade-off in the
 * comment above GATES.
 */
function missingScript(gate) {
  if (gate.command !== "node" || gate.requires) return null;
  const script = gate.args.find((arg) => !arg.startsWith("-"));
  if (!script || existsSync(join(ROOT, script))) return null;
  return script;
}

function runGate(gate) {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    if (isMissing(gate)) {
      console.log(`\n=== ${gate.name} — skipped (${gate.requires} not present) ===`);
      resolve({ name: gate.name, status: "skipped", durationMs: 0, note: `${gate.requires} not present` });
      return;
    }

    const absent = missingScript(gate);
    if (absent) {
      console.error(`\n=== ${gate.name} — FAILED: ${absent} is not present ===`);
      console.error(
        `This gate did not run, so nothing it gates was checked — ${gate.description}. That is a ` +
          "failure rather than a skip on purpose: a deleted enforcement script must not read as a " +
          "pass. Restore the script, or remove the gate from scripts/check.mjs deliberately."
      );
      resolve({ name: gate.name, status: "failed", durationMs: 0, note: `script missing: ${absent}` });
      return;
    }

    const printable = [gate.command, ...gate.args].join(" ");
    console.log(`\n=== ${gate.name} — ${printable} ===`);

    const child = spawn(gate.command, gate.args, { cwd: ROOT, stdio: "inherit" });

    child.on("error", (error) => {
      resolve({
        name: gate.name,
        status: "failed",
        durationMs: Date.now() - startedAt,
        note: `could not run: ${error.message}`
      });
    });

    child.on("close", (code, signal) => {
      const durationMs = Date.now() - startedAt;
      if (signal) {
        resolve({ name: gate.name, status: "failed", durationMs, note: `killed by ${signal}` });
        return;
      }
      resolve({
        name: gate.name,
        status: code === 0 ? "passed" : "failed",
        durationMs,
        ...(code === 0 ? {} : { note: `exit ${code}` })
      });
    });
  });
}

function printSummary(results, totalMs) {
  const failed = results.filter((result) => result.status === "failed");
  const skipped = results.filter((result) => result.status === "skipped");
  const width = Math.max(...results.map((result) => result.name.length));

  console.log("");
  console.log("=".repeat(60));
  console.log("check summary");
  console.log("=".repeat(60));
  for (const result of results) {
    const label = STATUS_LABEL[result.status];
    const duration = result.status === "skipped" ? "-" : formatDuration(result.durationMs);
    const note = result.note ? `  (${result.note})` : "";
    console.log(`  ${label}  ${result.name.padEnd(width)}  ${duration.padStart(7)}${note}`);
  }
  console.log("-".repeat(60));

  if (failed.length === 0) {
    const passed = results.length - skipped.length;
    const suffix = skipped.length > 0 ? `, ${skipped.length} skipped` : "";
    console.log(`PASS — ${passed} ${passed === 1 ? "gate" : "gates"} passed${suffix} in ${formatDuration(totalMs)}`);
    return true;
  }

  const names = failed.map((result) => result.name).join(", ");
  console.log(`FAIL — ${failed.length} of ${results.length} gates failed in ${formatDuration(totalMs)}: ${names}`);
  return false;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  if (options.list) {
    for (const gate of GATES) {
      const absent = missingScript(gate);
      const state = isMissing(gate)
        ? " (skipped: script not present)"
        : absent
          ? ` (FAILS: ${absent} not present)`
          : "";
      console.log(`${gate.name.padEnd(10)} ${[gate.command, ...gate.args].join(" ")}${state}`);
    }
    return;
  }

  let selected = GATES;
  if (options.only.length > 0) {
    const known = new Set(GATES.map((gate) => gate.name));
    const unknown = options.only.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      console.error(`unknown gate(s): ${unknown.join(", ")}`);
      printUsage();
      process.exitCode = 1;
      return;
    }
    selected = GATES.filter((gate) => options.only.includes(gate.name));
  }

  const startedAt = Date.now();
  const results = [];
  for (const gate of selected) {
    results.push(await runGate(gate));
  }

  const ok = printSummary(results, Date.now() - startedAt);
  process.exitCode = ok ? 0 : 1;
}

await main();
