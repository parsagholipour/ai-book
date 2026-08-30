/**
 * Durable protocol stamped onto a continuation operation before its job is
 * enqueued. The value is versioned because Stop may only restore an ACTIVE
 * continuation when it knows that worker version keeps every candidate in
 * memory until one atomic publication transaction.
 */
export const CONTINUATION_PUBLICATION_PROTOCOL_FIELD = "continuationPublicationProtocol";
export const ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL = "atomic-candidates-v1";

export type ContinuationPublicationProtocolState =
  | typeof ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL
  | "absent"
  | "invalid";

/** Distinguishes a legacy missing marker from a present marker we do not trust. */
export function continuationPublicationProtocolState(value: unknown): ContinuationPublicationProtocolState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "absent";
  }
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, CONTINUATION_PUBLICATION_PROTOCOL_FIELD)) {
    return "absent";
  }
  return record[CONTINUATION_PUBLICATION_PROTOCOL_FIELD] === ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL
    ? ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL
    : "invalid";
}

/**
 * Publication writes this key in the manuscript transaction. Any presence is
 * evidence Stop must hand off rather than cancel/refund, including a malformed
 * legacy value: ambiguity after a possible manuscript commit fails closed.
 */
export const CONTINUATION_FOLLOW_UP_CLASSIFIER_KEY = "continuationFollowUp";

export function hasContinuationPublicationEvidence(classifier: unknown): boolean {
  return Boolean(
    classifier &&
      typeof classifier === "object" &&
      !Array.isArray(classifier) &&
      Object.hasOwn(classifier, CONTINUATION_FOLLOW_UP_CLASSIFIER_KEY)
  );
}
