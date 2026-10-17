import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { DEFAULT_CREDIT_COSTS, type CreditPricingKey } from "@book-maker/core";

/**
 * Migration 000116 moves a book's price off its text base and onto its
 * pictures (and the welcome grant up with them) in an installation that already
 * has a price list, as one appended head revision. A database with no price
 * list reads core's compiled defaults instead, so the two halves have to name
 * the same numbers — held together here, because only the migration reaches a
 * running database and nothing else would notice them drift.
 */

let sql = "";

beforeAll(async () => {
  sql = await readFile(new URL("../prisma/migrations/000116_rebalance_picture_pricing/migration.sql", import.meta.url), "utf8");
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

/** Every key the migration moves, with the default it moves from and the one it moves to. */
const MOVED: Array<[CreditPricingKey, number, number]> = [
  ["fullBookBase", 350, 250],
  ["fullBookBaseFast", 220, 150],
  ["imageGeneration", 45, 70],
  ["imageGenerationFast", 45, 70],
  ["imageGenerationPremium", 85, 130],
  ["imageGenerationUltra", 85, 130],
  ["welcomeCredits", 1250, 1500],
  ["welcomeCreditsHighIncome", 1250, 1500],
  ["welcomeCreditsLowMiddleIncome", 1250, 1500]
];

describe("migration 000116_rebalance_picture_pricing", () => {
  it("is one guarded insert of a head revision, and touches no stored revision", () => {
    const statements = statementsOf(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/INSERT INTO "CreditPricingRevision"/);
    expect(statements[0]).toMatch(/ORDER BY "version" DESC\s+LIMIT 1/);
    // Nothing is written on an empty table or when every key is the operator's own.
    expect(statements[0]).toMatch(
      /FROM decided\s+WHERE move_base OR move_base_fast OR move_image OR move_image_fast OR move_image_premium OR move_image_ultra\s+OR move_welcome OR move_welcome_high OR move_welcome_low$/
    );
    expect(sql).not.toMatch(/\b(UPDATE|DELETE)\b/);
  });

  it.each(MOVED)("moves %s from its old default %i to core's compiled default %i, and only from it", (key, from, to) => {
    expect(DEFAULT_CREDIT_COSTS[key]).toBe(to);
    const guard =
      key === "imageGenerationUltra"
        ? `COALESCE(("values" ->> '${key}')::numeric, ("values" ->> 'imageGenerationPremium')::numeric, ${from}) = ${from}`
        : `COALESCE(("values" ->> '${key}')::numeric, ${from}) = ${from}`;
    expect(sql).toContain(guard);
    expect(sql).toContain(`jsonb_build_object('${key}', ${to})`);
    expect(sql).toContain(`'${key}', CASE WHEN`);
    expect(sql).toContain(`jsonb_build_object('from', ${from}, 'to', ${to})`);
  });

  it("reads a stored list's missing Ultra picture rate as its premium twin, as the read normalizer does", () => {
    // A list naming premium 100 and no Ultra rate charges Ultra 100: the operator's, so it stays.
    expect(sql).toMatch(/COALESCE\(\("values" ->> 'imageGenerationUltra'\)::numeric, \("values" ->> 'imageGenerationPremium'\)::numeric, 85\)/);
  });
});
