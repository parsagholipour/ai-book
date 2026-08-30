import { describe, expect, it } from "vitest";
import {
  ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL,
  CONTINUATION_PUBLICATION_PROTOCOL_FIELD
} from "@book-maker/core";
import { continuationDeliveryProtocol } from "./continueBookProtocol.js";

const payload = {
  projectId: "project-1",
  generationJobId: "job-1",
  operationId: "operation-1",
  [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL
};

function operation(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-1",
    kind: "CONTINUE_BOOK",
    generationJobId: "job-1",
    classifier: {
      [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL
    },
    ...overrides
  };
}

describe("continuation delivery publication protocol", () => {
  it("accepts only a marked delivery with its exact durable job relation", () => {
    expect(continuationDeliveryProtocol(operation(), payload)).toBe("atomic");
    expect(() => continuationDeliveryProtocol(operation({ generationJobId: null }), payload)).toThrow(
      "durable link does not match"
    );
    expect(() => continuationDeliveryProtocol(operation({ generationJobId: "job-other" }), payload)).toThrow(
      "not linked"
    );
  });

  it("fails closed on missing, one-sided, unknown, or malformed markers", () => {
    expect(() => continuationDeliveryProtocol(operation(), {
      projectId: payload.projectId,
      generationJobId: payload.generationJobId,
      operationId: payload.operationId
    })).toThrow("does not match");
    expect(() => continuationDeliveryProtocol(operation({ classifier: {} }), payload)).toThrow("does not match");
    expect(() => continuationDeliveryProtocol(operation({
      classifier: { [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: "future-v2" }
    }), payload)).toThrow("invalid");
    expect(() => continuationDeliveryProtocol(operation(), {
      ...payload,
      [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: "future-v2"
    })).toThrow("invalid");
  });

  it("keeps unmarked rolling-deploy rows on the legacy compatibility path", () => {
    expect(continuationDeliveryProtocol(operation({ generationJobId: null, classifier: {} }), {
      projectId: payload.projectId,
      generationJobId: payload.generationJobId,
      operationId: payload.operationId
    })).toBe("legacy");
  });

  it("rejects the wrong operation kind or project before any handler write", () => {
    expect(() => continuationDeliveryProtocol(operation({ kind: "PAGE_REWRITE" }), payload)).toThrow("not linked");
    expect(() => continuationDeliveryProtocol(operation({ projectId: "project-other" }), payload)).toThrow(
      "not linked"
    );
  });
});
