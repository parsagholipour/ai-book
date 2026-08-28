import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * `ImageAsset` had no index at all — a primary key on `id`, and Postgres does
 * not index a foreign key column on its own — so every read of a project's
 * pictures was a sequential scan. The one that made it worth a migration is the
 * character reference sheet set: a book's illustrated pages fan out
 * `MAX_PARALLEL_IMAGE_JOBS` image jobs plus a cover job, and any of them that
 * loses the render claim re-reads that set every two seconds for up to fifteen
 * minutes while the winner draws the cast.
 *
 * A schema declaration and a migration are two separate statements of one fact,
 * and only the migration reaches a running database. Held together here by the
 * index name Prisma derives from the declaration, which is the one string both
 * halves have to agree on.
 */

let schema = "";
let migrationSql = "";

beforeAll(async () => {
  schema = await readFile(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  migrationSql = await readFile(
    new URL("../prisma/migrations/000065_image_asset_project_type_index/migration.sql", import.meta.url),
    "utf8"
  );
});

describe("the ImageAsset (projectId, type) index", () => {
  it("is declared on the model rather than on some other one", () => {
    const model = /model ImageAsset \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(model).toContain("@@index([projectId, type])");
  });

  it("is created by a migration under the name that declaration derives", () => {
    // `<Table>_<col>_<col>_idx` is Prisma's own naming, so a hand-written
    // migration that spells it differently leaves `migrate diff` reporting
    // drift on every deploy.
    expect(migrationSql).toContain('"ImageAsset_projectId_type_idx" ON "ImageAsset"("projectId", "type")');
  });

  it("builds concurrently, because the worker is writing this table while it builds", () => {
    // A plain `CREATE INDEX` takes `SHARE`, which conflicts with the
    // `ROW EXCLUSIVE` every INSERT holds — so for the whole build every
    // `imageAsset.create` blocks, including the one inside
    // `commitCharacterReferenceSheets`, which holds the character-reference
    // advisory lock and a pooled connection while it waits. The image jobs
    // behind it exhaust `CHARACTER_REFERENCE_POOL_WAIT_MS` and raise `P2024`,
    // which throws away a cast already rendered and paid for, and which in
    // `generateCover.ts` fails and refunds the whole book. And the build really
    // does overlap a live worker: `scripts/start-production.sh` runs
    // `pnpm db:deploy` at container start while Railway keeps the previous
    // deployment — same database, same queue — serving until this one is
    // healthy.
    expect(migrationSql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS "ImageAsset_projectId_type_idx"/);
  });

  it("is the only statement in its migration", () => {
    // A concurrent build that fails leaves an INVALID index behind and marks
    // the migration failed. Alone in its file, recovery is one idempotent
    // statement to re-run rather than a partially applied script — and this
    // repo's Prisma applies a migration file without wrapping it in a
    // transaction, so a second statement really would stay applied.
    const statements = migrationSql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements).toHaveLength(1);
  });
});
