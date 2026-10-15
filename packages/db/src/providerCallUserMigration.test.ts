import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * `ProviderCallLog.userId` and its two indexes are declared once in the schema
 * and created by three migrations, and only the migrations reach a running
 * database. Held together here by the names Prisma derives from the
 * declarations — the strings both halves must agree on, or `migrate diff`
 * reports drift on every deploy.
 */

let schema = "";
const migrations: Record<string, string> = {};
const MIGRATIONS = {
  column: "000098_provider_call_user",
  userIndex: "000099_provider_call_user_created_index",
  createdIndex: "000100_provider_call_created_index"
} as const;

beforeAll(async () => {
  schema = await readFile(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  for (const [key, name] of Object.entries(MIGRATIONS)) {
    migrations[key] = await readFile(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), "utf8");
  }
});

function statementsOf(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

describe("ProviderCallLog.userId", () => {
  it("is declared on the model with a SetNull relation and both spend indexes", () => {
    const model = /model ProviderCallLog \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(model).toMatch(/\n\s+userId\s+String\?\n/);
    expect(model).toContain("@relation(fields: [userId], references: [id], onDelete: SetNull)");
    expect(model).toContain("@@index([userId, createdAt])");
    expect(model).toContain("@@index([createdAt])");
  });

  it("is added nullable with the foreign key Prisma names, validated without blocking inserts", () => {
    const sql = migrations.column!;
    expect(sql).toContain('ALTER TABLE "ProviderCallLog" ADD COLUMN "userId" TEXT;');
    expect(sql).toContain(
      'ADD CONSTRAINT "ProviderCallLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID'
    );
    expect(sql).toContain('VALIDATE CONSTRAINT "ProviderCallLog_userId_fkey"');
    // Every worker is inserting into this table while the migration runs.
    expect(sql).not.toMatch(/CREATE INDEX|UPDATE "ProviderCallLog"/);
  });

  it.each([
    ["userIndex", '"ProviderCallLog_userId_createdAt_idx" ON "ProviderCallLog"("userId", "createdAt")'],
    ["createdIndex", '"ProviderCallLog_createdAt_idx" ON "ProviderCallLog"("createdAt")']
  ] as const)("builds the %s concurrently, alone in its migration", (key, index) => {
    const sql = migrations[key]!;
    // A plain CREATE INDEX takes SHARE and blocks every provider call's insert
    // for the build; CONCURRENTLY must be alone in its file (see 000065).
    expect(sql).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index}`);
    expect(statementsOf(sql)).toHaveLength(1);
  });
});
