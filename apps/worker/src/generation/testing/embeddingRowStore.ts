import type { Mock } from "vitest";

/**
 * A stand-in for the `Embedding` table, shared by the suites that drive writes
 * into it: `embeddingWrites.test.ts` and `embeddingRepair.test.ts`. Both need
 * the same rows, because the question they disagree about — whose summary is
 * under `page:12` when two writers claim it — is the same question from the two
 * ends of one statement.
 */

export type EmbeddingRowState = {
  scope: string;
  /** Nullable exactly as the column is: a row no page claims. */
  sourceId: string | null;
  text: string;
  vector: string | null;
  metadata: unknown;
};

/**
 * Whether a statement carries the `"same-page"` predicate. Read off the one
 * fragment only that predicate contains — the `SET` list writes a bare
 * `"sourceId" = EXCLUDED."sourceId"`, with no table qualifier — because the
 * clause is a `WHERE` on the vector upsert and an `AND` on the placeholder.
 */
export const guardsSourceId = (sql: string) => sql.includes('"Embedding"."sourceId" = EXCLUDED."sourceId"');

/**
 * The Embedding table as a map keyed the way its unique index keys it, with the
 * `ON CONFLICT` predicates `embeddingWrites.ts` issues actually **enforced**
 * rather than merely asserted on. A "which SQL ran" assertion cannot answer the
 * question these rows exist for — whose summary is under `page:12` when two
 * writers disagree about who owns it — and that is the whole failure.
 */
export function installEmbeddingRowStore(executeRawUnsafe: Mock, seed: EmbeddingRowState[]) {
  const rows = new Map(seed.map((row) => [row.scope, row]));
  // Parameters run `id, projectId, scope, sourceId, text[, vector], metadata`.
  executeRawUnsafe.mockImplementation(async (sql: string, ...params: unknown[]) => {
    const scope = String(params[2]);
    const sourceId = String(params[3]);
    const text = String(params[4]);
    const existing = rows.get(scope);
    // `"same-page"` adds
    // `"Embedding"."sourceId" = EXCLUDED."sourceId" OR ... IS NULL`, so the
    // update matches no row once the scope belongs to another page. The default
    // has no such clause and takes the row whatever it holds.
    const wrongPage =
      !!existing && guardsSourceId(sql) && existing.sourceId !== null && existing.sourceId !== sourceId;
    if (sql.includes("::vector")) {
      if (wrongPage) {
        return 0;
      }
      rows.set(scope, { scope, sourceId, text, vector: String(params[5]), metadata: JSON.parse(String(params[6])) });
      return 1;
    }
    if (existing?.vector) {
      // `DO UPDATE ... WHERE "Embedding"."vector" IS NULL`.
      return 0;
    }
    if (wrongPage) {
      return 0;
    }
    rows.set(scope, { scope, sourceId, text, vector: null, metadata: JSON.parse(String(params[5])) });
    return 1;
  });
  return rows;
}
