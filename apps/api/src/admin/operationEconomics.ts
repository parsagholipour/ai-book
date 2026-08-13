/**
 * What each billed operation earns and what it costs to serve.
 *
 * The Costs tab groups provider spend by `ProviderCallLog.purpose` — the call
 * site, which is an engineering axis. This one groups it by `CreditOperation`,
 * the thing a reader is actually charged for, and puts credits charged next to
 * provider spend so a margin can be read per operation rather than only in
 * aggregate on the overview.
 *
 * ## Attributing a provider call to a charge
 *
 * There is no column joining the two, because the charge is reserved before the
 * work fans out. Three paths are tried in order, and none of them invents an
 * operation the project was not actually billed for:
 *
 * 1. **The job's own charge.** A charged job carries `billingLedgerEntryId` in
 *    its payload (`GENERATE_BOOK`, `REVISE_PLAN`, `APPLY_BOOK_EDIT`,
 *    `REPLAN_BOOK`, `GENERATE_AUDIOBOOK`). Exact. Note this is the *payload*
 *    link, not `CreditLedgerEntry.generationJobId` — the latter is only set on
 *    a minority of entries, so joining on it alone loses most of the spend.
 *    Reserve-then-commit settles the same row in place, so the id in a payload
 *    resolves to the SETTLED SPEND entry.
 * 2. **The plan the job belongs to.** Fan-out children (`GENERATE_PAGE`,
 *    `GENERATE_IMAGE`, `COMPILE_EXPORT`) carry the `planId` of the run that
 *    charged for them. A plan whose charged jobs disagree on the operation is
 *    skipped rather than guessed at.
 * 3. **The job type, gated on the project's own charges.** `JOB_OPERATION_SQL`
 *    maps each `JobType` to the one `CreditOperation` it exists to serve, but
 *    the map is only allowed to pick an operation the project was *actually*
 *    charged for. That gating is what keeps it from inventing revenue: a
 *    console-generated book has no charge, so its jobs stay unbilled.
 *
 * Everything left over is reported, never dropped, split by why it could not be
 * attributed — see `UNBILLED_REASONS`. On real data most of it is the operator
 * console, which generates books without charging anyone; reading that as
 * "unattributed spend" rather than "free books we paid for" would be wrong.
 *
 * ## Refunds count as cost, never as revenue
 *
 * A refunded charge keeps its `SPEND`/`SETTLED` row — the reversal is a second,
 * positive entry — so `credits` and `runs` count only what `CHARGE_KEPT` leaves,
 * and what was handed back rides alongside as `refundedCredits`/`refundedRuns`
 * rather than disappearing. The two add up to the gross figure an operator gets
 * from the ledger by hand, which is the point of showing both.
 *
 * The provider calls of a refunded run stay attributed to the operation that
 * spent them. They are real money that left, and dropping them would shunt the
 * spend into `UNBILLED_*` and break the reconciliation with the Costs tab. So an
 * operation whose charges were mostly refunded reports a **negative** margin.
 * That is the honest reading: we paid to do work and then gave the money back.
 *
 * ## Two caveats a reader needs
 *
 * Credits are counted from ledger entries created in the window and spend from
 * provider calls made in the window, so a run that straddles a boundary lands
 * its halves in different windows. Over any window wider than a job this is
 * noise; over a one-day window it is not.
 *
 * And a margin here is only as complete as the spend we can see: `VOICE_CALL_MINUTE`
 * has no provider calls at all, because the app holds its own socket to Gemini
 * (see `OPERATION_NOTES`).
 */

import { CREDIT_USD_VALUE } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import {
  costBreakdownFromRows,
  type CostUsage,
  type ModelCost,
  type ProviderCostRow
} from "./costBreakdown.js";
import { CHARGE_KEPT, CHARGE_REVERSED, round2, type AdminWindow } from "./metrics.js";

export type OperationEconomics = CostUsage & {
  key: string;
  label: string;
  /** Settled charges for this operation in the window that were not reversed. */
  runs: number;
  credits: number;
  /** Charges a refund reversed. Their provider spend is still in `providerUsd`. */
  refundedRuns: number;
  refundedCredits: number;
  revenueUsd: number;
  providerUsd: number;
  marginUsd: number;
  marginPercent: number | null;
  costPerRunUsd: number | null;
  creditsPerRun: number | null;
  /** Why this row's margin cannot be read at face value, when it cannot. */
  note: string | null;
  models: ModelCost[];
};

export type UnbilledSpend = CostUsage & {
  key: string;
  label: string;
  description: string;
  models: ModelCost[];
};

export type AdminOperationEconomics = {
  window: { days: number; since: string; until: string };
  creditUsdValue: number;
  totals: {
    runs: number;
    credits: number;
    refundedRuns: number;
    refundedCredits: number;
    revenueUsd: number;
    providerUsd: number;
    marginUsd: number;
    marginPercent: number | null;
    /** Provider spend no charge accounts for. Not part of any margin above. */
    unbilledUsd: number;
  };
  operations: OperationEconomics[];
  unbilled: UnbilledSpend[];
};

/**
 * Operations whose margin is not what it looks like, and why. These are facts
 * about where the money is recorded, not disclaimers — a reader comparing
 * `VOICE_CALL_MINUTE` against `AUDIOBOOK_GENERATION` without this would
 * conclude voice is the better business.
 */
const OPERATION_NOTES: Record<string, string> = {
  VOICE_CALL_MINUTE:
    "The app holds its own socket to Gemini, so realtime audio never reaches our server and none of its cost is in these logs. Real margin is lower.",
  EXPORT_UNLOCK: "Compiled from text that was already generated and paid for, so it makes no provider calls of its own.",
  PREMIUM_REVIEW: "Charged as part of a book generation; its calls are attributed to that generation rather than counted here.",
  IMAGE_GENERATION:
    "Chat-added images charge here in their own right — the job payload names the ledger entry, so their calls land under this row. Images bundled into a book generation, and every charge from before standalone image edits existed, are still attributed to that generation instead."
};

const UNBILLED_REASONS: Record<string, { label: string; description: string }> = {
  UNBILLED_NO_CHARGE: {
    label: "Never charged",
    description:
      "Work on projects with no settled charge at all — the operator console generates books without billing anyone. Real spend, no revenue behind it."
  },
  UNBILLED_INLINE: {
    label: "Inline API calls",
    description:
      "Calls the API makes outside the queue — creation chat, the book advisor, page-count preflight. They belong to no job and so to no charge."
  },
  UNBILLED_UNLINKED: {
    label: "Unlinked jobs",
    description:
      "Jobs on projects that were charged, but which none of the three attribution paths could tie to a specific operation. Mostly voice-character preparation, which nothing bills for."
  }
};

const LABELS: Record<string, string> = {
  PLAN_GENERATION: "Plan generation",
  PREVIEW_GENERATION: "Preview generation",
  FULL_BOOK_GENERATION: "Full book generation",
  IMAGE_GENERATION: "Extra images",
  COVER_REGENERATION: "Cover regeneration",
  PREMIUM_REVIEW: "Premium review",
  EXPORT_UNLOCK: "Export unlock",
  PLAN_REVISION: "Plan revision",
  BOOK_TEXT_EDIT: "Book text edit",
  PAGE_REGENERATION: "Page regeneration",
  BOOK_REPLAN: "Book replan",
  VOICE_CALL_MINUTE: "Voice calls",
  AUDIOBOOK_GENERATION: "Audiobook",
  CHARACTER_PORTRAIT_GENERATION: "Character portraits"
};

export async function loadOperationEconomics(window: AdminWindow): Promise<AdminOperationEconomics> {
  const inWindow = { gte: window.since, lte: window.until };
  const [costRows, charges, refunds] = await Promise.all([
    loadAttributedCostRows(window),
    prisma.creditLedgerEntry.groupBy({
      by: ["operation"],
      _sum: { amountCredits: true },
      _count: { _all: true },
      where: { ...CHARGE_KEPT, createdAt: inWindow }
    }),
    prisma.creditLedgerEntry.groupBy({
      by: ["operation"],
      _sum: { amountCredits: true },
      _count: { _all: true },
      where: { ...CHARGE_REVERSED, createdAt: inWindow }
    })
  ]);

  const breakdown = costBreakdownFromRows(costRows);
  const spendByOperation = new Map(breakdown.operations.map((operation) => [operation.key, operation]));

  const operationKeys = new Set<string>([
    ...charges.map((charge) => charge.operation as string),
    ...refunds.map((refund) => refund.operation as string),
    ...breakdown.operations.map((operation) => operation.key).filter((key) => !UNBILLED_REASONS[key])
  ]);

  const operations = [...operationKeys]
    .map((key) => {
      const charge = charges.find((entry) => (entry.operation as string) === key);
      const refund = refunds.find((entry) => (entry.operation as string) === key);
      const spend = spendByOperation.get(key);
      // SPEND entries are stored negative; the magnitude is what was charged.
      const credits = Math.abs(charge?._sum.amountCredits ?? 0);
      const runs = charge?._count._all ?? 0;
      const refundedCredits = Math.abs(refund?._sum.amountCredits ?? 0);
      const refundedRuns = refund?._count._all ?? 0;
      const revenueUsd = round2(credits * CREDIT_USD_VALUE);
      const providerUsd = spend?.usd ?? 0;
      // Every attempt we paid a provider for, refunded ones included — they are
      // in the numerator, so leaving them out of the denominator would report a
      // cost per run nothing ever cost.
      const attempts = runs + refundedRuns;
      return {
        ...(spend ?? emptyUsage()),
        key,
        label: LABELS[key] ?? sentenceCase(key),
        runs,
        credits,
        refundedRuns,
        refundedCredits,
        revenueUsd,
        providerUsd,
        marginUsd: round2(revenueUsd - providerUsd),
        marginPercent: revenueUsd > 0 ? Math.round(((revenueUsd - providerUsd) / revenueUsd) * 1000) / 10 : null,
        costPerRunUsd: attempts > 0 ? Math.round((providerUsd / attempts) * 1_000_000) / 1_000_000 : null,
        creditsPerRun: runs > 0 ? Math.round(credits / runs) : null,
        note: OPERATION_NOTES[key] ?? null,
        models: spend?.models ?? []
      } satisfies OperationEconomics;
    })
    .filter((operation) => operation.runs > 0 || operation.refundedRuns > 0 || operation.calls > 0)
    .sort((left, right) => right.revenueUsd - left.revenueUsd || right.providerUsd - left.providerUsd);

  const unbilled = breakdown.operations
    .filter((operation) => UNBILLED_REASONS[operation.key])
    .map((operation) => {
      const { key, label: _label, kind: _kind, ...usage } = operation;
      const reason = UNBILLED_REASONS[key]!;
      return { ...usage, key, label: reason.label, description: reason.description } satisfies UnbilledSpend;
    })
    .sort((left, right) => right.usd - left.usd);

  const totals = operations.reduce(
    (accumulator, operation) => ({
      runs: accumulator.runs + operation.runs,
      credits: accumulator.credits + operation.credits,
      refundedRuns: accumulator.refundedRuns + operation.refundedRuns,
      refundedCredits: accumulator.refundedCredits + operation.refundedCredits,
      revenueUsd: accumulator.revenueUsd + operation.revenueUsd,
      providerUsd: accumulator.providerUsd + operation.providerUsd
    }),
    { runs: 0, credits: 0, refundedRuns: 0, refundedCredits: 0, revenueUsd: 0, providerUsd: 0 }
  );
  const revenueUsd = round2(totals.revenueUsd);
  const providerUsd = round2(totals.providerUsd);

  return {
    window: { days: window.days, since: window.since.toISOString(), until: window.until.toISOString() },
    creditUsdValue: CREDIT_USD_VALUE,
    totals: {
      runs: totals.runs,
      credits: totals.credits,
      refundedRuns: totals.refundedRuns,
      refundedCredits: totals.refundedCredits,
      revenueUsd,
      providerUsd,
      marginUsd: round2(revenueUsd - providerUsd),
      marginPercent: revenueUsd > 0 ? Math.round(((revenueUsd - providerUsd) / revenueUsd) * 1000) / 10 : null,
      unbilledUsd: round2(unbilled.reduce((sum, entry) => sum + entry.usd, 0))
    },
    operations,
    unbilled
  };
}

/**
 * The same per-model counters `costBreakdown.ts` collects, but keyed by the
 * charge that paid for the call instead of by the call site — which is why it
 * borrows that module's row shape and its tested roll-up rather than growing a
 * second one. `purpose` carries the `CreditOperation`, or an `UNBILLED_*`
 * reason when nothing claims the call.
 */
async function loadAttributedCostRows(window: AdminWindow): Promise<ProviderCostRow[]> {
  return prisma.$queryRaw<ProviderCostRow[]>`
    WITH billed AS (
      SELECT j.id AS job_id, e.operation::text AS operation, j.payload ->> 'planId' AS plan_id
      FROM "GenerationJob" j
      JOIN "CreditLedgerEntry" e ON e.id = j.payload ->> 'billingLedgerEntryId'
      WHERE e."entryType" = 'SPEND' AND e.status = 'SETTLED'
    ),
    plan_operation AS (
      SELECT plan_id, MIN(operation) AS operation
      FROM billed
      WHERE plan_id IS NOT NULL
      GROUP BY plan_id
      HAVING COUNT(DISTINCT operation) = 1
    ),
    project_operation AS (
      SELECT "projectId" AS project_id, operation::text AS operation
      FROM "CreditLedgerEntry"
      WHERE "entryType" = 'SPEND' AND status = 'SETTLED' AND "projectId" IS NOT NULL
      GROUP BY 1, 2
    ),
    call AS (
      SELECT
        l.id,
        l.purpose,
        l.provider,
        l.model,
        l.metadata,
        l."costHint",
        l."promptTokens",
        l."cacheHitTokens",
        l."outputTokens",
        l."generationJobId",
        COALESCE(j."projectId", l."projectId") AS project_id,
        j.payload ->> 'planId' AS plan_id,
        -- Each JobType serves exactly one billed operation. Kept in step with
        -- enum JobType in schema.prisma; an unmapped type simply falls through
        -- to the unbilled buckets rather than being attributed by guess.
        CASE j.type::text
          WHEN 'PLAN_BOOK' THEN 'PLAN_GENERATION'
          WHEN 'REVISE_PLAN' THEN 'PLAN_REVISION'
          WHEN 'GENERATE_BOOK' THEN 'FULL_BOOK_GENERATION'
          WHEN 'GENERATE_PAGE' THEN 'FULL_BOOK_GENERATION'
          WHEN 'GENERATE_IMAGE' THEN 'FULL_BOOK_GENERATION'
          WHEN 'COMPILE_EXPORT' THEN 'FULL_BOOK_GENERATION'
          WHEN 'RESEARCH' THEN 'FULL_BOOK_GENERATION'
          WHEN 'IMPORT_BOOK' THEN 'FULL_BOOK_GENERATION'
          WHEN 'APPLY_BOOK_EDIT' THEN 'BOOK_TEXT_EDIT'
          WHEN 'REPLAN_BOOK' THEN 'BOOK_REPLAN'
          WHEN 'CONTINUE_BOOK' THEN 'PAGE_REGENERATION'
          WHEN 'GENERATE_AUDIOBOOK' THEN 'AUDIOBOOK_GENERATION'
          WHEN 'GENERATE_CHARACTER_PORTRAIT' THEN 'CHARACTER_PORTRAIT_GENERATION'
        END AS job_operation
      FROM "ProviderCallLog" l
      LEFT JOIN "GenerationJob" j ON j.id = l."generationJobId"
      WHERE l."createdAt" >= ${window.since}::timestamptz AND l."createdAt" <= ${window.until}::timestamptz
    ),
    attributed AS (
      SELECT
        c.*,
        COALESCE(
          billed.operation,
          plan_operation.operation,
          project_operation.operation,
          CASE
            WHEN c."generationJobId" IS NULL THEN 'UNBILLED_INLINE'
            WHEN NOT EXISTS (
              SELECT 1 FROM project_operation any_charge WHERE any_charge.project_id = c.project_id
            ) THEN 'UNBILLED_NO_CHARGE'
            ELSE 'UNBILLED_UNLINKED'
          END
        ) AS operation
      FROM call c
      LEFT JOIN billed ON billed.job_id = c."generationJobId"
      LEFT JOIN plan_operation ON plan_operation.plan_id = c.plan_id
      LEFT JOIN project_operation
        ON project_operation.project_id = c.project_id
       AND project_operation.operation = c.job_operation
    )
    SELECT
      CASE
        WHEN a.purpose LIKE 'tts.%' OR COALESCE(a.metadata ->> 'operation', '') LIKE 'tts.%' THEN 'audio'
        WHEN a.purpose = 'image.generate' OR a.metadata ->> 'operation' = 'image.generate' THEN 'image'
        ELSE 'text'
      END AS kind,
      a.operation AS purpose,
      a.provider AS provider,
      a.model AS model,
      COUNT(*)::double precision AS calls,
      COUNT(*) FILTER (WHERE a."costHint" IS NOT NULL)::double precision AS priced_calls,
      COUNT(*) FILTER (
        WHERE a."costHint" IS NULL AND a.metadata ->> 'liveStatus' = 'failed'
      )::double precision AS failed_calls,
      COUNT(*) FILTER (
        WHERE a."costHint" IS NULL AND a.metadata ->> 'liveStatus' = 'in_progress'
      )::double precision AS in_flight_calls,
      COUNT(*) FILTER (
        WHERE a."costHint" IS NULL
          AND COALESCE(a.metadata ->> 'liveStatus', '') NOT IN ('failed', 'in_progress')
          AND a.metadata ->> 'provisional' = 'true'
      )::double precision AS estimated_calls,
      COALESCE(SUM(a."costHint"), 0)::double precision AS usd,
      COALESCE(SUM(a."promptTokens") FILTER (WHERE a."costHint" IS NOT NULL), 0)::double precision AS prompt_tokens,
      COALESCE(SUM(a."cacheHitTokens") FILTER (WHERE a."costHint" IS NOT NULL), 0)::double precision AS cached_prompt_tokens,
      COALESCE(SUM(a."outputTokens") FILTER (WHERE a."costHint" IS NOT NULL), 0)::double precision AS output_tokens,
      COALESCE(
        SUM(
          CASE WHEN jsonb_typeof(a.metadata -> 'audioMs') = 'number'
            THEN (a.metadata ->> 'audioMs')::double precision
          END
        ) FILTER (WHERE a."costHint" IS NOT NULL),
        0
      )::double precision AS audio_ms
    FROM attributed a
    GROUP BY 1, 2, 3, 4
  `;
}

function emptyUsage(): CostUsage & { models: ModelCost[] } {
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
    audioSeconds: 0,
    models: []
  };
}

function sentenceCase(value: string): string {
  const words = value.toLowerCase().split("_").join(" ");
  return words.length > 0 ? words[0]!.toUpperCase() + words.slice(1) : words;
}
