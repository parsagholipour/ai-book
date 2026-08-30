import { describe, expect, it } from "vitest";
import {
  ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL,
  CONTINUATION_FOLLOW_UP_CLASSIFIER_KEY,
  CONTINUATION_PUBLICATION_PROTOCOL_FIELD,
  continuationPublicationProtocolState,
  hasContinuationPublicationEvidence
} from "./continuationPublication.js";

describe("continuation publication protocol", () => {
  it("distinguishes the current durable marker from legacy absence and malformed values", () => {
    expect(
      continuationPublicationProtocolState({
        [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL
      })
    ).toBe(ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL);
    expect(continuationPublicationProtocolState({ intent: "continue" })).toBe("absent");
    expect(continuationPublicationProtocolState(null)).toBe("absent");
    expect(continuationPublicationProtocolState({ [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: "future-v2" }))
      .toBe("invalid");
    expect(continuationPublicationProtocolState({ [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: null }))
      .toBe("invalid");
  });

  it("treats any follow-up key as possible publication evidence", () => {
    expect(hasContinuationPublicationEvidence({ [CONTINUATION_FOLLOW_UP_CLASSIFIER_KEY]: {
      planVersionId: "plan-2",
      publicationRevision: 8
    } })).toBe(true);
    expect(hasContinuationPublicationEvidence({ [CONTINUATION_FOLLOW_UP_CLASSIFIER_KEY]: null })).toBe(true);
    expect(hasContinuationPublicationEvidence({})).toBe(false);
  });
});
