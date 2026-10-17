/**
 * The frozen-input format every eval reads, and the data-directory layout. Shared by the host CLI and
 * the container scripts (the repo is bind-mounted at /app, so one relative path works on both sides).
 *
 * A stored fixture keeps the logged messages verbatim and nothing twice: `payload` (the parsed last
 * user message) and a JSON reply's `data` are derived on load, so a 120 KB manuscript read is stored
 * once, not three times.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonReply } from "./text.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEFAULT_DATA_DIR = join(REPO_ROOT, ".scratch", "eval-data");

export function dataDir(explicit?: string): string {
  return resolve(explicit ?? process.env.EVAL_DATA_DIR ?? DEFAULT_DATA_DIR);
}

export const SUPPORTED_PURPOSES = [
  "compose-chapter",
  "edit-chapter",
  "review-chapter-edit-acceptance",
  "read-manuscript",
  "cut-chapter",
  "extract-chapter-facts",
  "final-book-qa",
  "patch-page",
  "chapter-research",
  "case-source-search",
  "extract-excerpts"
] as const;
export type Purpose = (typeof SUPPORTED_PURPOSES)[number];

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type FixtureUsage = { promptTokens: number; outputTokens: number; reasoningTokens: number; cacheHitTokens: number };

export type FixtureContext = {
  bookTitle: string;
  brief: string;
  chapterTitle?: string;
  ofChapters?: number;
  /** Last paragraph of the chapter before, as the book printed it at this point in the run. */
  prevTail?: string;
  /** First paragraph of the chapter after, from its compose output. */
  nextHead?: string;
};

export type StoredFixture = {
  fixtureId: string;
  projectId: string;
  tier: string;
  category: string;
  writingMode: string;
  lane?: string;
  targetPages: number;
  lengthBucket: "short" | "medium" | "long";
  language: string;
  purpose: Purpose;
  jobName: string;
  op: "generateText" | "generateJson" | "search";
  callId: string;
  loggedAt: string;
  chapterIndex?: number;
  model: { provider: string; model: string };
  request: { temperature?: number; maxTokens?: number };
  /** Verbatim, including the content-safety prefix the logger had already added. Empty for a search. */
  messages: ChatMessage[];
  /** A grounded search's query (search fixtures only). */
  query?: { query: string; purpose: string };
  response: { text: string; data?: unknown; sources?: Array<{ title?: string; url?: string; summary?: string }>; grounding?: unknown; truncated?: boolean };
  usage: FixtureUsage;
  durationMs: number;
  attempts: number;
  /** Purpose-specific facts: edit kind, the logged acceptance verdict of an edit, read kind, cut constraints … */
  meta: Record<string, unknown>;
  context: FixtureContext;
};

export type Fixture = StoredFixture & {
  /** The parsed last user message, when it is JSON (most purposes); otherwise undefined. */
  payload: Record<string, unknown> | undefined;
  /** The recorded reply parsed as JSON (JSON purposes), else undefined. */
  recordedData: unknown;
};

export function lengthBucket(targetPages: number): StoredFixture["lengthBucket"] {
  return targetPages <= 30 ? "short" : targetPages <= 80 ? "medium" : "long";
}

export function stratumOf(fixture: Pick<StoredFixture, "tier" | "writingMode" | "lengthBucket">): string {
  return `${fixture.tier}|${fixture.writingMode}|${fixture.lengthBucket}`;
}

export function hydrate(stored: StoredFixture): Fixture {
  const last = [...stored.messages].reverse().find((message) => message.role === "user");
  const parsed = last ? parseJsonReply(last.content) : undefined;
  const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  const recordedData = stored.response.data ?? (stored.op === "generateJson" ? parseJsonReply(stored.response.text) : undefined);
  return { ...stored, payload, recordedData };
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

export function writeJsonl(path: string, rows: readonly unknown[]): void {
  ensureDir(dirname(path));
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

export function appendJsonl(path: string, row: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function fixturesPath(root: string, purpose: string): string {
  return join(root, "fixtures", `${purpose}.jsonl`);
}

export type FixtureFilter = {
  tier?: string;
  writingMode?: string;
  lengthBucket?: string;
  jobName?: string;
  ids?: readonly string[];
  /** `key=value` pairs matched against `meta` (string comparison). */
  meta?: Record<string, string>;
  limit?: number;
};

/** Load and filter one purpose's fixtures; `limit` takes a stratified round-robin so a small run still spans tiers and modes. */
export function loadFixtures(root: string, purpose: string, filter: FixtureFilter = {}): Fixture[] {
  let rows = readJsonl<StoredFixture>(fixturesPath(root, purpose)).map(hydrate);
  if (filter.ids?.length) {
    const wanted = new Set(filter.ids);
    rows = rows.filter((row) => wanted.has(row.fixtureId));
  }
  // tier, writingMode and lengthBucket take a comma list ("fast,balanced").
  const oneOf = (value: string, list: string | undefined) => !list || list.split(",").includes(value);
  rows = rows.filter((row) => oneOf(row.tier, filter.tier) && oneOf(row.writingMode, filter.writingMode) && oneOf(row.lengthBucket, filter.lengthBucket));
  if (filter.jobName) rows = rows.filter((row) => row.jobName === filter.jobName);
  for (const [key, value] of Object.entries(filter.meta ?? {})) rows = rows.filter((row) => String(row.meta[key]) === value);
  return filter.limit ? stratifiedTake(rows, filter.limit) : rows;
}

/** Round-robin across strata (tier|mode|length), preserving each stratum's order. */
export function stratifiedTake<T extends Pick<StoredFixture, "tier" | "writingMode" | "lengthBucket">>(rows: readonly T[], limit: number): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = stratumOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  // Interleave tiers first (fast, balanced, …), then modes and lengths, so a small limit spans both tiers.
  const byTier = new Map<string, string[]>();
  for (const key of [...groups.keys()].sort()) {
    const tier = key.split("|")[0]!;
    byTier.set(tier, [...(byTier.get(tier) ?? []), key]);
  }
  const tierLists = [...byTier.values()];
  const keys: string[] = [];
  for (let i = 0; keys.length < groups.size; i += 1) for (const list of tierLists) if (list[i]) keys.push(list[i]!);
  const out: T[] = [];
  for (let round = 0; out.length < limit; round += 1) {
    let took = false;
    for (const key of keys) {
      const row = groups.get(key)![round];
      if (row && out.length < limit) {
        out.push(row);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}

export function listPurposeFiles(root: string): string[] {
  const dir = join(root, "fixtures");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => name.replace(/\.jsonl$/, ""));
}

/** A replay result as `replay` writes it: one file per fixture × variant × sample. */
export type ReplayResult = {
  evalName: string;
  fixtureId: string;
  purpose: string;
  variant: string;
  sample: number;
  startedAt: string;
  latencyMs: number;
  model: { provider: string; model: string; thinkingEffort?: string };
  usage: FixtureUsage;
  /** Provider $ at the recorded rate card (core `calculateTextGenerationCost`), all calls of the variant summed. */
  costUsd: number | null;
  calls: number;
  /** The raw reply. */
  output: string;
  /** What the product would keep after its own post-processing, when the variant computes it (e.g. the edited chapter). */
  finalText?: string;
  data?: unknown;
  checks: Array<{ id: string; pass: boolean | null; value?: number; detail?: string }>;
  error?: string;
  extra?: Record<string, unknown>;
};

export function resultPath(root: string, evalName: string, variant: string, fixtureId: string, sample: number): string {
  return join(root, "results", evalName, variant, `${fixtureId}__s${sample}.json`);
}

export function loadResults(root: string, evalName: string): ReplayResult[] {
  const dir = join(root, "results", evalName);
  if (!existsSync(dir)) return [];
  const out: ReplayResult[] = [];
  for (const variant of readdirSync(dir, { withFileTypes: true })) {
    if (!variant.isDirectory()) continue;
    for (const file of readdirSync(join(dir, variant.name))) {
      if (file.endsWith(".json")) out.push(readJson<ReplayResult>(join(dir, variant.name, file)));
    }
  }
  return out;
}
