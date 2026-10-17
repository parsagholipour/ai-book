/**
 * A variant is one arm of an eval: a function from a frozen fixture to an output. It may change the
 * prompt or payload (transform the logged messages, or build new ones with product builders imported
 * read-only), the model route, the reasoning effort, or make several calls (edit + acceptance); it
 * may also make none (`recorded`, `no-edit`). The runner times it, sums its calls' tokens and $, and
 * runs the purpose's deterministic checks on what it returns.
 */
import type { CallOptions, CallRecord, Route, SearchRecord } from "../container/runtime.ts";
import type { Fixture, ReplayResult } from "../lib/fixtures.ts";

export type VariantContext = {
  fixture: Fixture;
  /** The route the variant spec's modifiers asked for (`+effort=none`, `+model=openai:gpt-6-sol`, `+tier=fast`, `+temp=0.3`). */
  route: Route;
  /** One model call on the fixture's tier, with `route` applied (a per-call `route` overrides it field by field). */
  call(options: CallOptions): Promise<CallRecord>;
  /** One grounded search (research purposes). */
  search(query: { query: string; purpose: string }): Promise<SearchRecord>;
  /** Which sample (0-based) this run is. */
  sample?: number;
  /** Another variant's stored result for the same fixture and sample in this eval (an arm built on another arm's output). */
  peer?(variantLabel: string): ReplayResult | undefined;
};

export type VariantOutput = {
  /** The raw reply of the variant's main call (or the stand-in a no-call arm returns). */
  output: string;
  /** What the product would keep after its own post-processing, for text purposes (the chapter as staged). */
  finalText?: string;
  data?: unknown;
  calls: CallRecord[];
  /** For arms that make no call: the latency and usage to report (e.g. the recorded call's). */
  reported?: Pick<CallRecord, "latencyMs" | "usage" | "costUsd" | "model">;
  extra?: Record<string, unknown>;
};

export type Variant = {
  name: string;
  description: string;
  /** Purposes the arm applies to; absent means any. */
  purposes?: readonly string[];
  run(context: VariantContext): Promise<VariantOutput>;
};
