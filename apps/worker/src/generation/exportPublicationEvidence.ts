const EXPORT_PUBLICATION_COMMITTED_AT = "exportPublicationCommittedAt";

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>) }
    : {};
}

/** Stamps the durable compile row in the same transaction that installs its artifacts. */
export function payloadWithExportPublicationEvidence(payload: unknown, committedAt: Date): Record<string, unknown> {
  return {
    ...payloadRecord(payload),
    [EXPORT_PUBLICATION_COMMITTED_AT]: committedAt.toISOString()
  };
}

/** Returns the actual publication boundary, never a generic job completion time. */
export function exportPublicationCommittedAt(payload: unknown): Date | null {
  const value = payloadRecord(payload)[EXPORT_PUBLICATION_COMMITTED_AT];
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}
