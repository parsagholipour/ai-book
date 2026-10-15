import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { DEFAULT_CREDIT_COSTS, type CreditPricingKey } from "@book-maker/core";

/**
 * Migration 000105 carries the 2026-10-13 launch defaults into an installation
 * that already has a price list, as one appended head revision. A database with
 * no price list reads core's compiled defaults instead, so the two halves have
 * to name the same numbers — held together here, because only the migration
 * reaches a running database and nothing else would notice them drift.
 */

let sql = "";

beforeAll(async () => {
  sql = await readFile(
    new URL("../prisma/migrations/000105_launch_pricing_defaults/migration.sql", import.meta.url),
    "utf8"
  );
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

/** Every key the migration moves, with the default it moves from. */
const MOVED: Array<[CreditPricingKey, number]> = [
  ["voiceCallPerMinute", 60],
  ["messageDailyLimitCreator", 150],
  ["messageDailyLimitPro", 300],
  ["messageDailyLimitMax", 600]
];

/** Every key it introduces, with what the product did before the key existed. */
const ADDED: Array<[CreditPricingKey, number]> = [
  ["addedPagesBase", 0],
  ["paidMaxBookPages", 600],
  ["ultraTierEnabled", 1]
];

describe("migration 000105_launch_pricing_defaults", () => {
  it("is one guarded insert of a head revision, and touches no stored revision", () => {
    const statements = statementsOf(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/INSERT INTO "CreditPricingRevision"/);
    expect(statements[0]).toMatch(/ORDER BY "version" DESC\s+LIMIT 1/);
    // Nothing is written on an empty table or when every key is the operator's own.
    expect(statements[0]).toMatch(/FROM decided\s+WHERE move_voice OR/);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE)\b/);
  });

  it.each(MOVED)("moves %s from its old default %i to core's compiled default, and only from it", (key, from) => {
    const to = DEFAULT_CREDIT_COSTS[key];
    expect(to).not.toBe(from);
    expect(sql).toContain(`COALESCE(("values" ->> '${key}')::numeric, ${from}) = ${from}`);
    expect(sql).toContain(`jsonb_build_object('${key}', ${to})`);
    expect(sql).toContain(`'${key}', CASE WHEN`);
    expect(sql).toContain(`jsonb_build_object('from', ${from}, 'to', ${to})`);
  });

  it.each(ADDED)("adds %s at core's compiled default only when the head does not name it", (key, before) => {
    const to = DEFAULT_CREDIT_COSTS[key];
    expect(sql).toContain(`NOT ("values" ? '${key}')`);
    expect(sql).toContain(`jsonb_build_object('${key}', ${to})`);
    expect(sql).toContain(`jsonb_build_object('from', ${before}, 'to', ${to})`);
  });
});
