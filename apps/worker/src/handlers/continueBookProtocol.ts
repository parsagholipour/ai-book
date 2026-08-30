import {
  ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL,
  continuationPublicationProtocolState
} from "@book-maker/core";

type ContinuationOperationForProtocol = {
  projectId: string;
  kind: string;
  generationJobId: string | null;
  classifier: unknown;
};

/**
 * The operation classifier is the authority; the payload marker is only an
 * agreement check. Legacy rows may lack both markers and the durable relation,
 * but a present wrong relation or any one-sided/malformed marker is refused.
 */
export function continuationDeliveryProtocol(
  operation: ContinuationOperationForProtocol,
  payload: {
    projectId: string;
    generationJobId: string;
    operationId: string;
    continuationPublicationProtocol?: string | undefined;
  }
): "atomic" | "legacy" {
  if (operation.projectId !== payload.projectId || operation.kind !== "CONTINUE_BOOK") {
    throw new Error("Continuation job is not linked to its durable operation");
  }
  if (operation.generationJobId !== null && operation.generationJobId !== payload.generationJobId) {
    throw new Error("Continuation job is not linked to its durable operation");
  }
  const durableProtocol = continuationPublicationProtocolState(operation.classifier);
  const payloadProtocol = continuationPublicationProtocolState(payload);
  if (durableProtocol === "invalid" || payloadProtocol === "invalid") {
    throw new Error("Continuation publication protocol marker is invalid");
  }
  if (durableProtocol === ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL) {
    if (
      payloadProtocol !== ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL ||
      operation.generationJobId !== payload.generationJobId
    ) {
      throw new Error("Continuation publication protocol marker or durable link does not match");
    }
    return "atomic";
  }
  if (payloadProtocol !== "absent") {
    throw new Error("Continuation publication protocol marker or durable link does not match");
  }
  return "legacy";
}
