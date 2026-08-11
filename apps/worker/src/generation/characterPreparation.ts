/**
 * Attempt-scoped identity for the optional voice-character discovery pass.
 *
 * A paid retry is a new attempt and may legitimately discover candidates after
 * the preceding attempt failed before export. Redelivery within one attempt is
 * the same work and must collapse onto its durable row. Legacy jobs without an
 * attempt keep the original project/plan key — and an edit's recompile passes
 * null deliberately: its attempt paid for the edit, not for re-discovery, so
 * repeated edits collapse onto the one spent key instead of paying a discovery
 * call each.
 */
export function characterPreparationDedupeKey(
  projectId: string,
  planId: string,
  attemptId: string | null
): string {
  const base = `prepare-characters:${projectId}:${planId}`;
  return attemptId ? `${base}:attempt:${attemptId}` : base;
}
