import { prisma } from "../packages/db/src/index.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import {
  applySearchGroundingAllowance,
  calculateSearchGroundingFee,
  searchGroundingClaim,
  searchGroundingMetadata,
  type SearchGroundingFee
} from "../packages/core/src/searchGroundingCost.ts";

/**
 * Re-price recorded grounded searches by their place in Google's free allowance,
 * and seed the allowance counters to match.
 *
 * For a while every grounded prompt was recorded at Google's list price
 * ($0.035), whatever the day's count: on 2026-09-30 (Pacific) the dev stack
 * logged 790 research calls against 1,500 free and recorded $12.78 of fees that
 * Google never charged. The recorders now claim each prompt's ordinal from
 * `SearchGroundingAllowanceCounter` as they write it (searchGroundingCost.ts);
 * this applies the same rule to the rows already written, in `createdAt` order:
 *
 * - every research row that recorded grounding gets the ordinal, the free
 *   units, and a `groundingFeeUsd` of nothing inside the allowance and list
 *   price past it; its `costHint` moves by exactly the fee's change;
 * - a research row from before grounding was recorded is not changed, but it
 *   still drew on Google's pool, so it is counted as one grounded prompt of its
 *   model's pool (every replayed search returned sources) — `--no-legacy` stops
 *   that;
 * - each pool-period's counter is then *set* to the count, so the next call
 *   recorded today continues from it.
 *
 * It re-derives everything from the rows, so a second run changes nothing, and
 * a row the new recorders wrote before this ran is renumbered with the rest. It
 * holds a lock on the counter table for the whole run, which makes every
 * recorder wait rather than claim an ordinal from a count about to be reset.
 * Dry run by default, like every other ops script here; the allowance is read
 * from the same `SEARCH_GROUNDING_FREE_*` settings the recorders use.
 *
 *   pnpm exec tsx scripts/reprice-search-grounding.ts [--apply] [--no-legacy]
 */

type ResearchRow = {
  id: string;
  createdAt: Date;
  provider: string;
  model: string;
  costHint: number | null;
  metadata: unknown;
};

type PeriodReport = {
  rows: number;
  legacyUnits: number;
  units: number;
  freeUnits: number;
  feeBeforeUsd: number;
  feeAfterUsd: number;
};

const apply = process.argv.includes("--apply");
const countLegacy = !process.argv.includes("--no-legacy");
const config = loadConfig();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function main() {
  const summary = await prisma.$transaction(async (tx) => {
    // SHARE ROW EXCLUSIVE conflicts with the row-exclusive lock every claim's upsert takes.
    await tx.$executeRaw`LOCK TABLE "SearchGroundingAllowanceCounter" IN SHARE ROW EXCLUSIVE MODE`;
    const rows: ResearchRow[] = await tx.providerCallLog.findMany({
      where: {
        OR: [
          { metadata: { path: ["operation"], equals: "research.search" } },
          { metadata: { path: ["textOperation"], equals: "research.search" } }
        ]
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, createdAt: true, provider: true, model: true, costHint: true, metadata: true }
    });

    const counts = new Map<string, number>();
    const periods = new Map<string, PeriodReport>();
    const updates: Array<{ id: string; costHint: number | null; metadata: Record<string, unknown> }> = [];
    let legacyRows = 0;
    let ungroundedRows = 0;

    for (const row of rows) {
      const metadata = record(row.metadata);
      const recorded = "groundingFeeUsd" in metadata;
      // A row from before grounding was recorded: assume the grounded prompt every replayed search was.
      const fee: SearchGroundingFee = recorded
        ? {
            usd: numberOrNull(metadata.groundingListFeeUsd) ?? numberOrNull(metadata.groundingFeeUsd),
            listUsd: numberOrNull(metadata.groundingListFeeUsd) ?? numberOrNull(metadata.groundingFeeUsd),
            units: numberOrNull(metadata.groundingUnits) ?? 0,
            groundedPrompt: metadata.groundedPrompt === true,
            pool: typeof metadata.groundingPool === "string" ? metadata.groundingPool : null
          }
        : calculateSearchGroundingFee({ provider: row.provider, model: row.model, grounding: { searchQueries: 1, webSources: 1 } });
      const claim = recorded || countLegacy ? searchGroundingClaim(fee, { at: row.createdAt, allowances: config }) : null;
      if (!claim) {
        if (recorded) ungroundedRows += 1;
        continue;
      }
      const key = `${claim.pool}\u0000${claim.period}`;
      const countAfter = (counts.get(key) ?? 0) + claim.units;
      counts.set(key, countAfter);
      const report = periods.get(key) ?? { rows: 0, legacyUnits: 0, units: 0, freeUnits: 0, feeBeforeUsd: 0, feeAfterUsd: 0 };
      periods.set(key, report);
      report.rows += 1;
      report.units += claim.units;
      if (!recorded) {
        legacyRows += 1;
        report.legacyUnits += claim.units;
        continue;
      }

      const settled = applySearchGroundingAllowance(fee, claim, countAfter);
      const before = numberOrNull(metadata.groundingFeeUsd) ?? 0;
      const after = settled.usd ?? 0;
      report.freeUnits += settled.allowance?.freeUnits ?? 0;
      report.feeBeforeUsd += before;
      report.feeAfterUsd += after;
      const nextMetadata = {
        ...metadata,
        ...searchGroundingMetadata(
          { searchQueries: numberOrNull(metadata.webSearchQueries) ?? 0, webSources: numberOrNull(metadata.groundingSources) ?? 0 },
          settled
        )
      };
      const nextCostHint = row.costHint === null ? null : roundUsd(row.costHint - before + after);
      if (nextCostHint !== row.costHint || JSON.stringify(nextMetadata) !== JSON.stringify(metadata)) {
        updates.push({ id: row.id, costHint: nextCostHint, metadata: nextMetadata });
      }
    }

    if (apply) {
      for (const update of updates) {
        await tx.providerCallLog.update({ where: { id: update.id }, data: { costHint: update.costHint, metadata: update.metadata as never } });
      }
      for (const [key, units] of counts) {
        const [pool, period] = key.split("\u0000") as [string, string];
        await tx.$executeRaw`
          INSERT INTO "SearchGroundingAllowanceCounter" ("pool", "period", "units", "updatedAt")
          VALUES (${pool}, ${period}, ${units}, now())
          ON CONFLICT ("pool", "period") DO UPDATE SET "units" = EXCLUDED."units", "updatedAt" = now()
        `;
      }
    }
    return { rows: rows.length, legacyRows, ungroundedRows, updates: updates.length, periods };
  }, { timeout: 300_000, maxWait: 30_000 });

  console.log(`${apply ? "APPLIED" : "DRY RUN"} — ${summary.rows} research rows; ${summary.legacyRows} from before grounding was recorded ` +
    `${countLegacy ? "(counted toward the allowance, unchanged)" : "(ignored)"}; ${summary.ungroundedRows} that billed nothing; ${summary.updates} rows ${apply ? "updated" : "to update"}.`);
  let before = 0;
  let after = 0;
  const lines = [...summary.periods].sort(([left], [right]) => left.localeCompare(right)).map(([key, report]) => {
    before += report.feeBeforeUsd;
    after += report.feeAfterUsd;
    const [pool, period] = key.split("\u0000");
    return `  ${pool} ${period}: ${report.units} units (${report.legacyUnits} legacy) · ${report.freeUnits} free of the recorded · ` +
      `fee $${roundUsd(report.feeBeforeUsd).toFixed(4)} → $${roundUsd(report.feeAfterUsd).toFixed(4)} · counter → ${report.units}`;
  });
  console.log(lines.join("\n"));
  console.log(`Recorded grounding fee: $${roundUsd(before).toFixed(4)} before → $${roundUsd(after).toFixed(4)} after.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
