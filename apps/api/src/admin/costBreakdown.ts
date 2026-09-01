/**
 * Where the provider money went — by operation, and by the model that spent it.
 *
 * The overview answers "how much did we spend"; this answers "on what". Both
 * read the same column, and the invariant in `metrics.ts` is why neither
 * replays a rate card: `ProviderCallLog.costHint` is null for every
 * provisional, in-flight and failed call and set only once a call settles with
 * real token counts, so `SUM("costHint")` is money actually spent.
 *
 * Four things shape how a row here should be read.
 *
 * **Usage is summed over priced calls only**, so tokens and dollars always
 * describe the same set of calls. A call the rate card could not price
 * contributes to `unratedCalls` and to nothing else — otherwise a missing rate
 * card would silently improve every tokens-per-dollar figure on the page.
 *
 * **`calls` partitions exactly** into priced + failed + in-flight + estimated +
 * unrated. The overview's single `unpricedCalls` number folds all four
 * cost-less shapes together, which makes "40 calls, none priced" unreadable and
 * unactionable. They are different problems: `unratedCalls` means the rate card
 * does not know the model and the page is *understating* real spend, while
 * `estimatedCalls` means the provider never returned usage
 * (`settleLiveTextUsageEstimate`) so nothing could have priced it. An
 * `estimatedCalls` row still carries token counts, and those are a guess with a
 * stated error bar — see the field's own comment before reading tokens off one.
 *
 * **Image and audio calls can only ever appear priced.** `recordProviderImageCost`
 * and `recordProviderAudioCost` return early rather than writing a row they
 * cannot price, so an unrated image model is invisible here by construction and
 * `unratedCalls` is a text-only signal.
 *
 * **`purpose` is left verbatim.** It is the key the run logs under
 * `<BOOK_STORAGE_DIR>/<projectId>/runs/` are written with, and prettifying
 * "book.final_qa.chapter_transitions" into title case makes it ungreppable.
 */

import { prisma } from "@book-maker/db";
import type { AdminWindow } from "./metrics.js";

/** Which unit "how much we used" is measured in for a given call. */
export type CostKind = "text" | "image" | "audio";

export type CostUsage = {
  /** priced + failed + inFlight + estimated + unrated. */
  calls: number;
  pricedCalls: number;
  failedCalls: number;
  inFlightCalls: number;
  /**
   * Settled on estimated token counts, which are never priced.
   *
   * These rows are the only ones on this page whose tokens are a guess, which
   * is why their dollars are absent rather than approximate — nothing here
   * replays a rate card over an estimate. The guess itself is
   * `estimateTokenCountFromText` (`apps/worker/src/providers/usageAccounting.ts`):
   * a two-class character rule, four Latin characters per token and one token
   * per character in every other script. Read it as right to within roughly a
   * factor of two, in either direction, and never better than that — it is a
   * character count standing in for a tokenizer nobody ran.
   */
  estimatedCalls: number;
  /** Settled with real tokens, but no rate card knew the model. Text only. */
  unratedCalls: number;
  usd: number;
  promptTokens: number;
  /** The discounted subset of `promptTokens` that hit the provider's cache. */
  cachedPromptTokens: number;
  outputTokens: number;
  images: number;
  audioSeconds: number;
};

export type ModelCost = CostUsage & {
  key: string;
  provider: string;
  model: string;
  kind: CostKind;
};

export type OperationCost = CostUsage & {
  key: string;
  label: string;
  /** The kind that accounts for most of this operation's spend. */
  kind: CostKind;
  models: ModelCost[];
};

export type KindCost = CostUsage & { kind: CostKind };

export type AdminCostBreakdown = {
  window: { days: number; since: string; until: string };
  totals: CostUsage;
  byKind: KindCost[];
  operations: OperationCost[];
  models: ModelCost[];
};

/** One `(kind, purpose, provider, model)` group, straight off the query below. */
export type ProviderCostRow = {
  kind: string | null;
  purpose: string | null;
  /** Present on project detail rows where one raw purpose can belong to different gates. */
  generation_job_type?: string | null;
  provider: string | null;
  model: string | null;
  calls: number | null;
  priced_calls: number | null;
  failed_calls: number | null;
  in_flight_calls: number | null;
  estimated_calls: number | null;
  usd: number | null;
  prompt_tokens: number | null;
  cached_prompt_tokens: number | null;
  output_tokens: number | null;
  audio_ms: number | null;
};

export async function loadAdminCostBreakdown(window: AdminWindow): Promise<AdminCostBreakdown> {
  const rows = await loadProviderCostRows(window);
  return {
    window: { days: window.days, since: window.since.toISOString(), until: window.until.toISOString() },
    ...costBreakdownFromRows(rows)
  };
}

/**
 * Every counter the page needs in one pass.
 *
 * `kind` mirrors `isImageProviderLog`/`isAudioProviderLog` in
 * `packages/core/src/costs.ts`: both the column and `metadata.operation` are
 * checked, because a row written before `purpose` carried the operation name
 * only has the metadata copy. Counts and sums are cast to `double precision` so
 * Prisma hands back numbers rather than a mix of `BigInt` and `number`.
 */
async function loadProviderCostRows(window: AdminWindow): Promise<ProviderCostRow[]> {
  return prisma.$queryRaw<ProviderCostRow[]>`
    SELECT
      CASE
        WHEN l.purpose LIKE 'tts.%' OR COALESCE(l.metadata ->> 'operation', '') LIKE 'tts.%' THEN 'audio'
        WHEN l.purpose = 'image.generate' OR l.metadata ->> 'operation' = 'image.generate' THEN 'image'
        ELSE 'text'
      END AS kind,
      l.purpose AS purpose,
      l.provider AS provider,
      l.model AS model,
      COUNT(*)::double precision AS calls,
      COUNT(*) FILTER (WHERE l."costHint" IS NOT NULL)::double precision AS priced_calls,
      COUNT(*) FILTER (
        WHERE l."costHint" IS NULL AND l.metadata ->> 'liveStatus' = 'failed'
      )::double precision AS failed_calls,
      COUNT(*) FILTER (
        WHERE l."costHint" IS NULL AND l.metadata ->> 'liveStatus' = 'in_progress'
      )::double precision AS in_flight_calls,
      COUNT(*) FILTER (
        WHERE l."costHint" IS NULL
          AND COALESCE(l.metadata ->> 'liveStatus', '') NOT IN ('failed', 'in_progress')
          AND l.metadata ->> 'provisional' = 'true'
      )::double precision AS estimated_calls,
      COALESCE(SUM(l."costHint"), 0)::double precision AS usd,
      COALESCE(SUM(l."promptTokens") FILTER (WHERE l."costHint" IS NOT NULL), 0)::double precision AS prompt_tokens,
      COALESCE(SUM(l."cacheHitTokens") FILTER (WHERE l."costHint" IS NOT NULL), 0)::double precision AS cached_prompt_tokens,
      COALESCE(SUM(l."outputTokens") FILTER (WHERE l."costHint" IS NOT NULL), 0)::double precision AS output_tokens,
      COALESCE(
        SUM(
          CASE WHEN jsonb_typeof(l.metadata -> 'audioMs') = 'number'
            THEN (l.metadata ->> 'audioMs')::double precision
          END
        ) FILTER (WHERE l."costHint" IS NOT NULL),
        0
      )::double precision AS audio_ms
    FROM "ProviderCallLog" l
    WHERE l."createdAt" >= ${window.since}::timestamptz AND l."createdAt" <= ${window.until}::timestamptz
    GROUP BY 1, 2, 3, 4
  `;
}

type OperationAccumulator = CostUsage & {
  key: string;
  firstKind: CostKind;
  spendByKind: Map<CostKind, number>;
  models: Map<string, ModelCost>;
};

export function costBreakdownFromRows(rows: ProviderCostRow[]): Omit<AdminCostBreakdown, "window"> {
  const totals = emptyUsage();
  const byKind = new Map<CostKind, KindCost>();
  const byOperation = new Map<string, OperationAccumulator>();
  const byModel = new Map<string, ModelCost>();

  for (const row of rows) {
    const kind = readKind(row.kind);
    const usage = usageFromRow(row, kind);
    if (usage.calls <= 0) {
      continue;
    }
    const purpose = trimmed(row.purpose) ?? "unknown";
    const provider = trimmed(row.provider) ?? "unknown";
    const model = trimmed(row.model) ?? "unknown";
    // Keyed by kind too: one model that both writes text and draws images is two
    // cost lines, because "how much we used" is counted in different units.
    const modelKey = `${kind}:${provider}:${model}`;
    const newModel = (): ModelCost => ({ key: modelKey, provider, model, kind, ...emptyUsage() });

    addUsage(totals, usage);
    addUsage(upsert(byKind, kind, () => ({ kind, ...emptyUsage() })), usage);
    addUsage(upsert(byModel, modelKey, newModel), usage);

    const operation = upsert(byOperation, purpose, () => ({
      key: purpose,
      firstKind: kind,
      spendByKind: new Map<CostKind, number>(),
      models: new Map<string, ModelCost>(),
      ...emptyUsage()
    }));
    addUsage(operation, usage);
    operation.spendByKind.set(kind, (operation.spendByKind.get(kind) ?? 0) + usage.usd);
    addUsage(upsert(operation.models, modelKey, newModel), usage);
  }

  return {
    totals: roundUsage(totals),
    byKind: [...byKind.values()].map(roundUsage).sort(bySpend),
    operations: [...byOperation.values()].map(serializeOperation).sort(bySpend),
    models: [...byModel.values()].map(roundUsage).sort(bySpend)
  };
}

function serializeOperation(operation: OperationAccumulator): OperationCost {
  const { key, firstKind, spendByKind, models, ...usage } = operation;
  return {
    ...roundUsage(usage),
    key,
    label: key,
    kind: dominantKind(spendByKind, firstKind),
    models: [...models.values()].map(roundUsage).sort(bySpend)
  };
}

function upsert<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const created = create();
  map.set(key, created);
  return created;
}

function usageFromRow(row: ProviderCostRow, kind: CostKind): CostUsage {
  const calls = whole(row.calls);
  const pricedCalls = Math.min(calls, whole(row.priced_calls));
  const failedCalls = whole(row.failed_calls);
  const inFlightCalls = whole(row.in_flight_calls);
  const estimatedCalls = whole(row.estimated_calls);
  return {
    calls,
    pricedCalls,
    failedCalls,
    inFlightCalls,
    estimatedCalls,
    unratedCalls: Math.max(0, calls - pricedCalls - failedCalls - inFlightCalls - estimatedCalls),
    usd: finite(row.usd),
    promptTokens: whole(row.prompt_tokens),
    cachedPromptTokens: whole(row.cached_prompt_tokens),
    outputTokens: whole(row.output_tokens),
    // One priced row is one image; the count has no column of its own.
    images: kind === "image" ? pricedCalls : 0,
    audioSeconds: Math.round(finite(row.audio_ms) / 1000)
  };
}

function addUsage(target: CostUsage, source: CostUsage): void {
  target.calls += source.calls;
  target.pricedCalls += source.pricedCalls;
  target.failedCalls += source.failedCalls;
  target.inFlightCalls += source.inFlightCalls;
  target.estimatedCalls += source.estimatedCalls;
  target.unratedCalls += source.unratedCalls;
  target.usd += source.usd;
  target.promptTokens += source.promptTokens;
  target.cachedPromptTokens += source.cachedPromptTokens;
  target.outputTokens += source.outputTokens;
  target.images += source.images;
  target.audioSeconds += source.audioSeconds;
}

/**
 * Six decimals, not two: a single page costs fractions of a cent, and rounding
 * a per-model row to the nearest cent would print `$0.00` next to a real
 * hundred-thousand-token bill. It matches `COST_PRECISION` in
 * `packages/core/src/costs.ts`, which is the precision the numbers were priced
 * at in the first place.
 */
function roundUsage<T extends CostUsage>(usage: T): T {
  return { ...usage, usd: Math.round(usage.usd * 1_000_000) / 1_000_000 };
}

function dominantKind(spendByKind: Map<CostKind, number>, fallback: CostKind): CostKind {
  let winner: CostKind | null = null;
  let best = -1;
  for (const [kind, usd] of spendByKind) {
    if (usd > best) {
      winner = kind;
      best = usd;
    }
  }
  return winner ?? fallback;
}

function bySpend(left: CostUsage, right: CostUsage): number {
  return right.usd - left.usd || right.calls - left.calls;
}

function emptyUsage(): CostUsage {
  return {
    calls: 0,
    pricedCalls: 0,
    failedCalls: 0,
    inFlightCalls: 0,
    estimatedCalls: 0,
    unratedCalls: 0,
    usd: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    outputTokens: 0,
    images: 0,
    audioSeconds: 0
  };
}

function readKind(value: string | null): CostKind {
  return value === "image" || value === "audio" ? value : "text";
}

function trimmed(value: string | null): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function finite(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function whole(value: number | null): number {
  return Math.max(0, Math.round(finite(value)));
}
