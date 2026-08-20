/**
 * The metadata shapes the degraded-placeholder rule is judged on, stated once
 * for both of the languages that express it.
 *
 * `embeddingIsDegraded` tests a JS value and `degradedEmbeddingSql` builds a
 * predicate over a `jsonb` column, so the rule cannot have one implementation —
 * only one *set of answers*. This is that set: `embeddingRepairTargets.test.ts`
 * runs it through the function with no database at all, and the opt-in
 * `embeddingRepairTargets.integration.test.ts` seeds every shape into Postgres
 * and compares the query's verdict against the function's, shape by shape. A
 * change to either expression that the other does not follow fails there.
 *
 * The string `"false"` is the case worth the table on its own: it is what a
 * hand-written `metadata->>'vectorStored' = 'false'` would call degraded and
 * the function never does, so the two would disagree about a row while both
 * looked right.
 *
 * This module imports nothing, so a suite may take the table without building a
 * `PrismaClient` (see `vitest.config.ts` for why that matters here).
 */
export type DegradedEmbeddingShape = {
  /** What the case is, for the assertion message. */
  label: string;
  /** The `Embedding.metadata` document, as JSON. */
  metadata: unknown;
  /** Whether the rule calls this row a vectorless placeholder. */
  degraded: boolean;
};

export const DEGRADED_EMBEDDING_SHAPES: readonly DegradedEmbeddingShape[] = [
  { label: "the marker alone", metadata: { vectorStored: false }, degraded: true },
  {
    label: "the marker with the repair stamp beside it",
    metadata: { vectorStored: false, error: "content filter", repairAttempts: 2, repairRetryFromIndex: 9 },
    degraded: true
  },
  { label: "the string \"false\", which is not the boolean", metadata: { vectorStored: "false" }, degraded: false },
  { label: "the marker set true", metadata: { vectorStored: true }, degraded: false },
  { label: "the marker present but null", metadata: { vectorStored: null }, degraded: false },
  { label: "the marker nested a level down", metadata: { vectorStored: { value: false } }, degraded: false },
  { label: "a healthy row, which carries no marker at all", metadata: { provider: "gemini" }, degraded: false },
  { label: "an empty object", metadata: {}, degraded: false },
  { label: "an array", metadata: [1, 2], degraded: false },
  { label: "an array holding the marker's parts", metadata: ["vectorStored", false], degraded: false },
  { label: "a JSON boolean scalar", metadata: false, degraded: false },
  { label: "a JSON string scalar", metadata: "vectorStored", degraded: false },
  { label: "a JSON number scalar", metadata: 0, degraded: false },
  { label: "a JSON null", metadata: null, degraded: false }
];
