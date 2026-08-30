import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

let migrationSql = "";

beforeAll(async () => {
  migrationSql = await readFile(
    new URL("../prisma/migrations/000068_edit_character_context/migration.sql", import.meta.url),
    "utf8"
  );
});

describe("edit character context migration", () => {
  it("adds a dedicated optional context column without rewriting approved instructions", () => {
    expect(migrationSql).toContain('ADD COLUMN "characterContext" TEXT');
    expect(migrationSql).not.toMatch(/UPDATE\s+"BookEditOperation"/i);
    expect(migrationSql).not.toMatch(/SET\s+"editInstruction"/i);
  });
});
