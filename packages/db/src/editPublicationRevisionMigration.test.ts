import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

let migrationSql = "";

beforeAll(async () => {
  migrationSql = await readFile(
    new URL("../prisma/migrations/000059_edit_publication_revision/migration.sql", import.meta.url),
    "utf8"
  );
});

describe("edit publication revision migration", () => {
  it("backfills only an APPLIED edit whose own apply job is still open", () => {
    expect(migrationSql).toContain('owner_job."type" = \'APPLY_BOOK_EDIT\'');
    expect(migrationSql).toContain('owner_job."status" IN (\'QUEUED\', \'ACTIVE\')');
    expect(migrationSql).toContain('operation."status" = \'APPLIED\'');
    expect(migrationSql).toContain('operation."generationJobId" = owner_job."id"');
  });

  it("does not adopt a row with a later operation, lifecycle, or terminal classifier", () => {
    expect(migrationSql).toContain('FROM "BookEditOperation" AS later_operation');
    expect(migrationSql).toContain('FROM "GenerationJob" AS later_job');
    expect(migrationSql).toContain('later_job."createdAt" >= operation."appliedAt"');
    for (const marker of [
      "undoneAt",
      "structuralRolledBackAt",
      "textExactSkipped",
      "layoutMissing",
      "structuralSkipped"
    ]) {
      expect(migrationSql).toContain(marker);
    }
  });
});
