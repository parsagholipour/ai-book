import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { DEFAULT_CREDIT_COSTS, type CreditPricingKey } from "@book-maker/core";

/**
 * Migration 000110 raises the welcome grant's per-address caps and its amount
 * (1,150 → 1,250, so every free picture book up to the free page cap fits) in
 * an installation that already has a price list, as one appended head revision.
 * A database with no price list reads core's compiled defaults instead, so the
 * two halves have to name the same numbers — held together here, because only
 * the migration reaches a running database and nothing else would notice them
 * drift.
 */

let sql = "";

beforeAll(async () => {
  sql = await readFile(new URL("../prisma/migrations/000110_welcome_ip_caps/migration.sql", import.meta.url), "utf8");
});

function statementsOf(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Keys a later migration has since moved again, with the default they read now:
 * the welcome grant went to 1,500 when a picture went to 70 (000116).
 */
const SUPERSEDED: Partial<Record<CreditPricingKey, number>> = {
  welcomeCredits: 1500,
  welcomeCreditsHighIncome: 1500,
  welcomeCreditsLowMiddleIncome: 1500
};

/** Every key the migration moves, with the default it moves from and the one it moves to. */
const MOVED: Array<[CreditPricingKey, number, number]> = [
  ["welcomeCreditsAccountsPerIpHighIncome", 2, 3],
  ["welcomeCreditsAccountsPerIpLowMiddleIncome", 1, 2],
  ["welcomeCredits", 1150, 1250],
  ["welcomeCreditsHighIncome", 1150, 1250],
  ["welcomeCreditsLowMiddleIncome", 1150, 1250]
];

describe("migration 000110_welcome_ip_caps", () => {
  it("is one guarded insert of a head revision, and touches no stored revision", () => {
    const statements = statementsOf(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/INSERT INTO "CreditPricingRevision"/);
    expect(statements[0]).toMatch(/ORDER BY "version" DESC\s+LIMIT 1/);
    // Nothing is written on an empty table or when every key is the operator's own.
    expect(statements[0]).toMatch(
      /FROM decided\s+WHERE move_high OR move_low OR move_welcome OR move_welcome_high OR move_welcome_low$/
    );
    expect(sql).not.toMatch(/\b(UPDATE|DELETE)\b/);
  });

  it.each(MOVED)("moves %s from its old default %i to core's compiled default %i, and only from it", (key, from, to) => {
    expect(DEFAULT_CREDIT_COSTS[key]).toBe(SUPERSEDED[key] ?? to);
    expect(sql).toContain(`COALESCE(("values" ->> '${key}')::numeric, ${from}) = ${from}`);
    expect(sql).toContain(`jsonb_build_object('${key}', ${to})`);
    expect(sql).toContain(`'${key}', CASE WHEN`);
    expect(sql).toContain(`jsonb_build_object('from', ${from}, 'to', ${to})`);
  });

  it("leaves the export unlock's price alone: retiring it is code, not data", () => {
    // A stored 150 reads back as 0 through the key's ceiling (core `creditPricing.ts`).
    expect(sql).not.toMatch(/'exportUnlock'/);
    expect(DEFAULT_CREDIT_COSTS.exportUnlock).toBe(0);
  });
});
