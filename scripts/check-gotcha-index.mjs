#!/usr/bin/env node
/**
 * Holds the invariant index in the root CLAUDE.md together with the bodies in
 * the directory-scoped CLAUDE.md files.
 *
 * The root file lists every invariant as one line — its headline verbatim, then
 * an arrow and the file(s) holding the reasoning. Those bodies used to live in
 * root; they were moved out so an agent loads only the ones for the area it is
 * editing. That split is only safe while the two halves agree, and nothing else
 * checks it: fifteen files instead of one is an obvious drift source.
 *
 * Three assertions:
 *   1. every headline in the index appears verbatim in a file it points at (line
 *      wrapping folded away, words compared exactly)
 *   2. every pointed-at file exists
 *   3. every nested CLAUDE.md is reachable from the index, unless it declares
 *      itself pointer-only with the marker below
 *
 * A file that carries no invariants of its own opts out with a line containing
 *   <!-- gotcha-index: pointer-only -->
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT_DOC = join(REPO, "CLAUDE.md");
const POINTER_ONLY = "<!-- gotcha-index: pointer-only -->";
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".dart_tool", "generated", "storage", "output"]);

const problems = [];
const fail = (msg) => problems.push(msg);

// ---- read the index ---------------------------------------------------------

if (!existsSync(ROOT_DOC)) {
  console.error("check-gotcha-index: no CLAUDE.md at the repo root");
  process.exit(1);
}

const rootText = readFileSync(ROOT_DOC, "utf8");
const rootLines = rootText.split("\n");
const gotchasAt = rootLines.findIndex((l) => l.trim() === "## Gotchas");

if (gotchasAt < 0) {
  console.error("check-gotcha-index: root CLAUDE.md has no '## Gotchas' section");
  process.exit(1);
}

/** @type {{ headline: string, dests: string[], line: number }[]} */
const entries = [];
for (let i = gotchasAt + 1; i < rootLines.length; i++) {
  const line = rootLines[i];
  if (!line.startsWith("- ")) continue;
  const arrow = line.indexOf(" → ");
  if (arrow < 0) {
    fail(`CLAUDE.md:${i + 1} index entry has no "→ <destination>":\n    ${line.slice(0, 100)}`);
    continue;
  }
  const headline = line.slice(2, arrow).trim();
  const tail = line.slice(arrow + 3);
  const dests = tail.match(/[\w./-]+CLAUDE\.md/g) ?? [];
  if (dests.length === 0 && !tail.includes("## Commands")) {
    fail(`CLAUDE.md:${i + 1} index entry names no destination file:\n    ${line.slice(0, 100)}`);
    continue;
  }
  entries.push({ headline, dests, line: i + 1 });
}

if (entries.length === 0) {
  console.error("check-gotcha-index: the ## Gotchas section lists no invariants");
  process.exit(1);
}

// ---- 1 + 2: every headline lands somewhere real -----------------------------

const referenced = new Set();
const docCache = new Map();
/**
 * A headline is one sentence in the index but is hard-wrapped at 100 columns in
 * the body, so it routinely spans a line break plus the two-space continuation
 * indent. Compare both sides with that folded away — the words must match, the
 * wrapping is the formatter's business.
 */
const flatten = (s) => s.replace(/\n\s+/g, " ");
const readDoc = (rel) => {
  if (!docCache.has(rel)) {
    const abs = join(REPO, rel);
    docCache.set(rel, existsSync(abs) ? flatten(readFileSync(abs, "utf8")) : null);
  }
  return docCache.get(rel);
};

for (const entry of entries) {
  if (entry.dests.length === 0) {
    // "kept in full under ## Commands above" — the body stayed in root
    if (!flatten(rootText).includes(entry.headline)) {
      fail(`CLAUDE.md:${entry.line} says the body is kept in root, but the headline is not there:\n    ${entry.headline.slice(0, 90)}`);
    }
    continue;
  }
  const found = [];
  for (const dest of entry.dests) {
    referenced.add(dest);
    const body = readDoc(dest);
    if (body === null) {
      fail(`CLAUDE.md:${entry.line} points at a file that does not exist: ${dest}`);
      continue;
    }
    if (body.includes(entry.headline)) found.push(dest);
  }
  if (found.length === 0) {
    fail(
      `CLAUDE.md:${entry.line} headline appears in none of its destinations ` +
        `(${entry.dests.join(", ")}) — the index and the body have drifted apart:\n    ${entry.headline.slice(0, 90)}`
    );
  }
}

// ---- 3: no orphaned nested CLAUDE.md ----------------------------------------

const nested = [];
const walk = (dir) => {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.name.startsWith(".") || SKIP_DIRS.has(dirent.name)) continue;
    const abs = join(dir, dirent.name);
    if (dirent.isDirectory()) walk(abs);
    else if (dirent.name === "CLAUDE.md" && abs !== ROOT_DOC) nested.push(relative(REPO, abs));
  }
};
walk(REPO);

for (const rel of nested) {
  if (referenced.has(rel)) continue;
  const body = readFileSync(join(REPO, rel), "utf8");
  if (body.includes(POINTER_ONLY)) continue;
  fail(
    `${rel} is not reachable from the index in CLAUDE.md. Add a line for each invariant it ` +
      `carries, or mark the file "${POINTER_ONLY}" if it only points elsewhere.`
  );
}

// ---- report -----------------------------------------------------------------

if (problems.length > 0) {
  console.error("The invariant index and the directory-scoped CLAUDE.md files disagree:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\n${problems.length} problem${problems.length === 1 ? "" : "s"}. The headline in the index and ` +
      `the one above the body must match word for word — edit both, or neither.`
  );
  process.exit(1);
}

console.log(
  `check-gotcha-index: ${entries.length} invariants indexed across ${referenced.size} files, ` +
    `${nested.length} nested CLAUDE.md total — all reachable.`
);
