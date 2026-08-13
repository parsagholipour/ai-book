#!/usr/bin/env node
/**
 * PostToolUse hook: check the file that was just edited, not the whole repo.
 *
 * Two things that are cheap now and expensive later:
 *
 *   1. The 900-line budget. `pnpm check` catches it, but only at the end of a
 *      session — by which point the file has grown for twenty more edits and
 *      splitting it is a bigger job than it would have been. Six of the eight
 *      grandfathered files sit within fifty lines of their ceiling, so this
 *      fires on real work rather than hypothetically.
 *   2. oxlint on the single edited file, which is sub-100ms and catches the
 *      correctness rules the config marks as errors.
 *
 * Exit 2 tells Claude about it. The edit has already been applied — this is
 * feedback, not a veto.
 *
 * A hook that throws is worse than no hook, so everything here is wrapped and
 * anything unexpected exits 0.
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return 0;
  }

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) return 0;

  const abs = isAbsolute(filePath) ? filePath : join(payload?.cwd ?? REPO, filePath);
  const rel = relative(REPO, abs);
  if (rel.startsWith("..") || !existsSync(abs)) return 0;

  const notes = [];

  // --- the size budget, asked of the script that owns the numbers ------------
  try {
    const { budgetForFile } = await import(join(REPO, "scripts/check-file-sizes.mjs"));
    const budget = budgetForFile(rel);
    if (budget) {
      const lines = readFileSync(abs, "utf8").split("\n").length;
      if (lines > budget.limit) {
        notes.push(
          budget.grandfathered
            ? `${budget.key} is ${lines} lines and has grown past its recorded ceiling of ${budget.limit}.\n` +
              `That ceiling in scripts/check-file-sizes.mjs is a debt, not a permission — split the file ` +
              `along a real seam rather than raising the number.`
            : `${budget.key} is ${lines} lines, over the ${budget.limit}-line budget.\n` +
              `Split it along a real seam (a job handler, a route group, a widget cluster).`
        );
      } else if (budget.grandfathered && lines <= budget.defaultLimit) {
        notes.push(
          `${budget.key} is now ${lines} lines, under the default ${budget.defaultLimit}. ` +
            `Drop its GRANDFATHERED entry in scripts/check-file-sizes.mjs.`
        );
      }
    }
  } catch {
    // the budget script moved or failed to load; not this hook's problem
  }

  // --- oxlint, on this file only --------------------------------------------
  if (/\.(ts|tsx)$/.test(rel)) {
    try {
      // Call the binary directly rather than through npx, which prints npm
      // config warnings onto stderr and would land them in the feedback.
      const oxlint = join(REPO, "node_modules/.bin/oxlint");
      if (!existsSync(oxlint)) return notes.length ? emit(notes) : 0;
      execFileSync(oxlint, [rel], {
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000
      });
    } catch (error) {
      const out = `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim();
      // Only speak up when oxlint actually failed; a missing binary exits
      // differently and should stay silent.
      if (error?.status === 1 && out) notes.push(`oxlint on ${rel}:\n${clamp(out)}`);
    }
  }

  return emit(notes);
};

/**
 * One bad edit can produce thousands of diagnostics, and every line of this
 * lands in the model's context. The first handful say what is wrong; the rest
 * is the same thing repeated. Keep the signal, drop the volume.
 */
const MAX_LINES = 25;
const clamp = (text) => {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES) return text;
  const hidden = lines.length - MAX_LINES;
  return `${lines.slice(0, MAX_LINES).join("\n")}\n…and ${hidden} more line${hidden === 1 ? "" : "s"} — run \`pnpm lint\` for the rest.`;
};

const emit = (notes) => {
  if (notes.length === 0) return 0;
  process.stderr.write(`${notes.join("\n\n")}\n`);
  return 2;
};

main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(0));
