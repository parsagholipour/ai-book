/**
 * The replay runtime, inside the worker container. It imports product code read-only (core by path,
 * the worker's config and routing loader) and builds every call from the tier's LIVE route — the
 * stored quality revision decides model and reasoning effort per purpose, exactly as a book would —
 * then applies the variant's route override (provider, model, effort) on top.
 *
 * Calls go straight to a provider adapter: no run log, no ProviderCallLog row, no fallback to
 * another family (a fallback would confound the arm), up to three attempts on a recoverable error.
 */
import { createRequire } from "node:module";
import * as core from "../../../packages/core/src/index.ts";
import { config } from "../../../apps/worker/src/runtime/config.ts";
import { loadLiveGenerationTextRouting } from "../../../apps/worker/src/providers/generationTextRouting.ts";
import type { ChatMessage, FixtureUsage } from "../lib/fixtures.ts";

const coreRequire = createRequire(new URL("../../../packages/core/package.json", import.meta.url));
export const { z } = coreRequire("zod") as typeof import("../../../packages/core/node_modules/zod/index.js");
export { core, config };
/** Accepts any parsed reply. Typed loosely on purpose: zod's inference over the adapter generic is too deep for tsc. */
export const anyJsonSchema = z.unknown() as never;

export type Route = {
  tier?: string;
  provider?: string;
  model?: string;
  /** none | minimal | low | medium | high | xhigh, as the stage table spells them. */
  thinkingEffort?: string;
  temperature?: number;
};

export type CallOptions = {
  purpose: string;
  messages: ChatMessage[];
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  route?: Route;
  timeoutMs?: number;
};

export type CallRecord = {
  text: string;
  data?: unknown;
  usage: FixtureUsage;
  latencyMs: number;
  model: { provider: string; model: string; thinkingEffort?: string };
  costUsd: number | null;
};

type Selection = { provider: string; model: string; thinkingEffort?: string; thinkingEnabled?: boolean; thinkingBudget?: number };
type Bindable = { bindForCall(purpose: string): Promise<{ selection: Selection }> };

const routingLoader = loadLiveGenerationTextRouting({ filePath: "", append: async () => "" } as never);
const liveModels = new Map<string, Bindable>();

function liveModel(tier: string): Bindable {
  let model = liveModels.get(tier);
  if (!model) {
    model = core.createLiveGenerationTextModel(config, { tier: tier as never, loadRouting: routingLoader }) as unknown as Bindable;
    liveModels.set(tier, model);
  }
  return model;
}

/** The selection a book on `tier` would use for `purpose` today, with the override applied. */
export async function resolveSelection(tier: string, purpose: string, route: Route = {}): Promise<Selection> {
  const bound = await liveModel(route.tier ?? tier).bindForCall(purpose);
  const selection: Selection = { ...bound.selection };
  if (route.provider) selection.provider = route.provider;
  if (route.model) selection.model = route.model;
  if (route.thinkingEffort) {
    selection.thinkingEffort = route.thinkingEffort;
    selection.thinkingEnabled = route.thinkingEffort !== "none";
  }
  return selection;
}

const adapters = new Map<string, core.TextModelAdapter>();
function adapterFor(selection: Selection): core.TextModelAdapter {
  const key = JSON.stringify(selection);
  let adapter = adapters.get(key);
  if (!adapter) {
    adapter = core.createTextModelAdapter(config, selection as never, { maxRetries: 0 });
    adapters.set(key, adapter);
  }
  return adapter;
}

export function costOf(model: { provider: string; model: string }, usage: FixtureUsage & { cacheWriteTokens?: number }): number | null {
  return core.calculateTextGenerationCost({
    provider: model.provider,
    model: model.model,
    promptTokens: usage.promptTokens,
    outputTokens: usage.outputTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    billedAt: new Date()
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function callModel(tier: string, options: CallOptions): Promise<CallRecord> {
  const selection = await resolveSelection(tier, options.purpose, options.route);
  const adapter = adapterFor(selection);
  const temperature = options.route?.temperature ?? options.temperature;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const started = performance.now();
    try {
      const request = {
        purpose: options.purpose,
        messages: options.messages,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 300_000)
      };
      const result = options.json
        ? await adapter.generateJson({ ...request, schema: anyJsonSchema })
        : await adapter.generateText(request);
      const latencyMs = Math.round(performance.now() - started);
      const raw = (result.usage ?? {}) as Record<string, number | undefined>;
      const usage = {
        promptTokens: raw.promptTokens ?? 0,
        outputTokens: raw.outputTokens ?? 0,
        reasoningTokens: raw.reasoningTokens ?? 0,
        cacheHitTokens: raw.cacheHitTokens ?? 0
      };
      const model = { provider: selection.provider, model: result.model ?? selection.model, ...(selection.thinkingEffort ? { thinkingEffort: selection.thinkingEffort } : {}) };
      return {
        text: result.text ?? "",
        ...("data" in result ? { data: (result as { data: unknown }).data } : {}),
        usage,
        latencyMs,
        model,
        costUsd: costOf(model, { ...usage, cacheWriteTokens: raw.cacheWriteTokens ?? 0 })
      };
    } catch (error) {
      lastError = error;
      if (attempt === 3 || !core.isRecoverableNetworkError(error)) break;
      await sleep(attempt * 4_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export type SearchRecord = CallRecord & { sources: Array<{ title?: string | undefined; url?: string | undefined; summary?: string | undefined }>; grounding?: unknown };

/** A grounded search on the research adapter the worker uses. Draws on Google's shared free allowance. */
export async function callSearch(query: { query: string; purpose: string }): Promise<SearchRecord> {
  const adapter = core.createResearchAdapter(config);
  const started = performance.now();
  const result = await adapter.search({ query: query.query, purpose: query.purpose });
  const usage = { promptTokens: result.usage?.promptTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0, reasoningTokens: 0, cacheHitTokens: 0 };
  const model = { provider: result.provider ?? "gemini", model: result.model ?? config.GEMINI_TEXT_MODEL };
  return {
    text: result.summary ?? "",
    usage,
    latencyMs: Math.round(performance.now() - started),
    model,
    // Token cost only: the grounding fee is $0 inside Google's daily allowance and is not decided here.
    costUsd: costOf(model, usage),
    sources: result.sources ?? [],
    grounding: result.grounding
  };
}
