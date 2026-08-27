import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

let migrationSql = "";

beforeAll(async () => {
  migrationSql = await readFile(
    new URL("../prisma/migrations/000061_tiered_plan_generation_pricing/migration.sql", import.meta.url),
    "utf8"
  );
});

describe("tiered plan generation pricing migration", () => {
  it("appends no revision to an empty pricing table", () => {
    expect(migrationSql).toContain('FROM "CreditPricingRevision"');
    expect(migrationSql).toContain("FROM migrated;");
    expect(migrationSql).not.toContain('INSERT INTO "CreditPricingRevision" DEFAULT VALUES');
  });

  it("raises only a legacy zero Balanced rate and preserves a nonzero override", () => {
    expect(migrationSql).toContain("AND (\"values\" ->> 'planGeneration')::numeric <> 0");
    expect(migrationSql).toContain("THEN \"values\" -> 'planGeneration'");
    expect(migrationSql).toContain("ELSE to_jsonb(40)");
  });

  it("seeds every new effort tier in the appended revision", () => {
    expect(migrationSql).toContain("'planGenerationFast', 20");
    expect(migrationSql).toContain("'planGenerationPremium', 80");
    expect(migrationSql).toContain("'planGenerationUltra', 120");
    expect(migrationSql).toContain('"version" + 1 AS next_version');
  });
});
