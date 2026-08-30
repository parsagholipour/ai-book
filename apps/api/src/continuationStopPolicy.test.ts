import { describe, expect, it } from "vitest";
import {
  ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL,
  CONTINUATION_FOLLOW_UP_CLASSIFIER_KEY,
  CONTINUATION_PUBLICATION_PROTOCOL_FIELD
} from "@book-maker/core";
import { continuationStopDisposition } from "./continuationStopPolicy.js";

const marker = {
  [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL
};

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    status: "ACTIVE",
    type: "CONTINUE_BOOK",
    payload: { operationId: "operation-1", ...marker },
    ...overrides
  };
}

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: "operation-1",
    projectId: "project-1",
    generationJobId: "job-1",
    kind: "CONTINUE_BOOK",
    status: "ACTIVE",
    classifier: marker,
    publicationRevision: null,
    ...overrides
  };
}

describe("continuation Stop policy", () => {
  it.each([
    ["marked", marker, { operationId: "operation-1", ...marker }],
    ["unmarked", {}, { operationId: "operation-1" }]
  ])("restores an exact QUEUED %s continuation", (_label, classifier, payload) => {
    expect(continuationStopDisposition(
      "project-1",
      job({ status: "QUEUED", payload }),
      operation({ status: "QUEUED", classifier })
    )).toBe("restore");
  });

  // The marker pair licenses restoring an ACTIVE row, and nothing else. A
  // QUEUED one was never claimed by the worker, so a disagreement about the
  // protocol says nothing about the book — while fail-closed there marks a
  // finished, paid book FAILED with no route back. The versioned marker's own
  // bump is the disagreement that reaches every row at once: on the deploy that
  // moves the constant on, every continuation still queued under the previous
  // value reads `invalid` on both sides and matches neither pair.
  it.each([
    ["a durable marker its payload does not carry", {}, { payload: { operationId: "operation-1" } }],
    ["a payload marker its operation does not carry", { classifier: {} }, {}],
    [
      "a protocol version this build does not know",
      { classifier: { [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: "future-v2" } },
      {
        payload: {
          operationId: "operation-1",
          [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: "future-v2"
        }
      }
    ]
  ])("restores a QUEUED continuation under %s", (_label, operationOverrides, jobOverrides) => {
    expect(continuationStopDisposition(
      "project-1",
      job({ status: "QUEUED", ...jobOverrides }),
      operation({ status: "QUEUED", ...operationOverrides })
    )).toBe("restore");
  });

  it("restores ACTIVE only for the exact current atomic-candidates protocol", () => {
    expect(continuationStopDisposition("project-1", job(), operation())).toBe("restore");
    expect(continuationStopDisposition(
      "project-1",
      job({ payload: { operationId: "operation-1" } }),
      operation({ classifier: {} })
    )).toBe("fail-closed");
  });

  it.each([
    ["missing relation", { generationJobId: null }, {}],
    ["wrong relation", { generationJobId: "job-other" }, {}],
    ["wrong project", { projectId: "project-other" }, {}],
    ["wrong kind", { kind: "PAGE_REWRITE" }, {}],
    ["missing payload link", {}, { payload: marker }],
    ["wrong payload link", {}, { payload: { operationId: "operation-other", ...marker } }],
    ["missing payload marker", {}, { payload: { operationId: "operation-1" } }],
    ["missing durable marker", { classifier: {} }, {}],
    ["unknown durable marker", {
      classifier: { [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: "future-v2" }
    }, {}],
    ["unknown payload marker", {}, {
      payload: { operationId: "operation-1", [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: "future-v2" }
    }]
  ])("fails closed for %s", (_label, operationOverrides, jobOverrides) => {
    expect(continuationStopDisposition(
      "project-1",
      job(jobOverrides),
      operation(operationOverrides)
    )).toBe("fail-closed");
  });

  it.each([
    ["APPLIED", { status: "APPLIED" }],
    ["publication revision", { publicationRevision: 8 }],
    ["follow-up identity", {
      classifier: { ...marker, [CONTINUATION_FOLLOW_UP_CLASSIFIER_KEY]: {
        planVersionId: "plan-2",
        publicationRevision: 8
      } }
    }],
    ["malformed follow-up evidence", {
      classifier: { ...marker, [CONTINUATION_FOLLOW_UP_CLASSIFIER_KEY]: null }
    }]
  ])("hands off a %s publication winner", (_label, overrides) => {
    expect(continuationStopDisposition("project-1", job(), operation(overrides))).toBe("handoff");
  });
});
