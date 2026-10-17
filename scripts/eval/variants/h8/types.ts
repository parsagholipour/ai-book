/**
 * H8 (parallel chapter lanes, K = 2) — the record shapes the extraction, the pair builder, the arm runner
 * and the judging scripts share. Pure types; no imports at runtime.
 */
import type { ChatMessage, FixtureUsage } from "../../lib/fixtures.ts";

export type Fact = { subject: string; attribute: string; value: string };

export type LoggedRecordCall = {
  chapterIndex: number | null;
  callId: string;
  purpose: string;
  model: { provider: string; model: string };
  startedAt?: string;
  endedAt?: string;
  durationMs: number;
  temperature?: number;
  maxTokens?: number;
  messages: ChatMessage[];
  text: string;
  data?: unknown;
  usage: FixtureUsage;
  attempts: number;
  ok: boolean;
  errors: string[];
};

export type BookRecord = {
  projectId: string;
  title: string;
  prompt: string;
  category: string;
  targetPages: number;
  language: string;
  tier: string;
  lane: string;
  writingMode: string;
  premise?: unknown;
  audience?: unknown;
  exampleCast?: unknown;
  characters?: unknown;
  chapters: Array<{ index: number; title: string; summary: string; targetPages: number; composition: unknown; facts: unknown }>;
  runs: Array<{ log: string; startedAt?: string; endedAt?: string; calls: LoggedRecordCall[]; loopEvents: unknown[] }>;
};

export type PlannedComposition = { sections: Array<{ form: string; subject: string; owns: string[] }>; landing: string };

/** One frozen neighbour pair: chapter N (fixed, its stored draft) and chapter N+1 (recomposed per arm). */
export type H8Pair = {
  pairId: string;
  projectId: string;
  tier: string;
  writingMode: string;
  language: string;
  lane: string;
  bookTitle: string;
  brief: string;
  n: number;
  n1: number;
  ofChapters: number;
  nTitle: string;
  n1Title: string;
  /** Chapter N's draft as staged: the compose reply N+1 was written against, normalised. */
  nText: string;
  nCallId: string;
  /** What N's own compose request carried: the ledger before N as lines, and the memory that existed when N started. */
  nRequest: { establishedFacts: string[]; continuityNotes: string[]; storyState?: string[] };
  /** N+1's first logged compose request (the serial arm, replayed unchanged). */
  n1Request: { callId: string; messages: ChatMessage[]; temperature?: number; maxTokens?: number };
  n1Recorded: { text: string; durationMs: number; usage: FixtureUsage };
  n1Attempts: number;
  ledgerBeforeN: Fact[];
  factsN: Fact[];
  nComposition: PlannedComposition;
  checks: { nDigestIsPlanned: boolean; ledgerLinesMatch: boolean; n1HasFacts: boolean };
};

export type ArmCall = { purpose: string; latencyMs: number; usage: FixtureUsage; costUsd: number | null; model: { provider: string; model: string; thinkingEffort?: string } };

export type KeyConflict = { subject: string; attribute: string; earlierValue: string; laterValue: string; earlierSubject: string; laterSubject: string };

/** One arm's chapter N+1 for one pair and sample. */
export type H8Result = {
  pairId: string;
  arm: "S" | "P0" | "P1" | "PR";
  sample: number;
  text: string;
  error?: string;
  calls: ArmCall[];
  /** N+1's facts read against the ledger before N (the parallel design's extraction), and the code conflicts with N's facts. */
  factsN1?: Fact[];
  conflicts?: KeyConflict[];
  /** PR only: what the reconciliation did. */
  repair?: { fired: boolean; conflicts: number; patches: number; applied: number; failures: number; skipped: number; changed: boolean; latencyMs?: number };
};
