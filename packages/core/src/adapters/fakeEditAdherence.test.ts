import { z } from "zod";
import { describe, expect, it } from "vitest";

import { fakeEditAdherence } from "./fakeEditAdherence.js";

describe("fakeEditAdherence", () => {
  it.each([
    { phase: "collect-evidence", key: "segments", expected: { contradictions: [] } },
    { phase: "reduce-evidence", key: "evidenceNodes", expected: { requirementEvidence: [] } }
  ])("accepts every bounded $phase input id", ({ phase, key, expected }) => {
    expect(call({ reviewPhase: phase, [key]: [{ id: "one" }, { id: "two" }] })).toMatchObject({
      acceptedInputIds: ["one", "two"],
      ...expected
    });
  });

  it("echoes the final coverage identity", () => {
    expect(
      call({
        reviewPhase: "global-verdict",
        completeCoverage: { evidenceId: "root", digest: "a".repeat(64), evidenceDigest: "b".repeat(64) }
      })
    ).toMatchObject({
      satisfied: true,
      acceptedEvidenceId: "root",
      coverageDigest: "a".repeat(64),
      evidenceDigest: "b".repeat(64),
      acceptedNegativeFactIds: []
    });
  });

  it("answers satisfied for an ordinary dry-run instruction", () => {
    expect(call({ reviewPhase: "global-verdict", approvedInstruction: "Make the ending warmer." })).toMatchObject({
      satisfied: true,
      missingRequirements: []
    });
  });

  it("reports an unsatisfied verdict only when the instruction asks for one", () => {
    expect(
      call({ reviewPhase: "global-verdict", approvedInstruction: "Warmer. [mock-adherence:unsatisfied]" })
    ).toMatchObject({ satisfied: false, missingRequirements: [expect.any(String)] });
  });

  it("reports incomplete leaf evidence only when the instruction asks for one", () => {
    expect(
      call({
        reviewPhase: "collect-evidence",
        approvedInstruction: "Warmer. [mock-adherence:incomplete]",
        segments: [{ id: "one" }]
      })
    ).toMatchObject({ evidenceComplete: false });
  });

  it.each([
    { mode: "truncated", error: SyntaxError },
    { mode: "failed", error: /adherence reviewer is unavailable/ }
  ])("throws a $mode provider call in every phase when asked", ({ mode, error }) => {
    for (const reviewPhase of ["collect-evidence", "reduce-evidence", "global-verdict"]) {
      expect(() => call({ reviewPhase, approvedInstruction: `Warmer. [mock-adherence:${mode}]` })).toThrow(error);
    }
  });

  it("preserves more than four reducer facts without slicing", () => {
    const facts = Array.from({ length: 6 }, (_, index) => ({ id: `fact-${index}`, text: `Fact ${index}` }));
    const result = call({
      reviewPhase: "reduce-evidence",
      evidenceNodes: [{ id: "one", evidence: { requirementEvidence: facts } }, { id: "two", evidence: {} }]
    }) as { requirementEvidence: Array<{ text: string }> };

    expect(result.requirementEvidence.map((fact) => fact.text)).toEqual(facts.map((fact) => fact.text));
  });
});

function call(payload: Record<string, unknown>): unknown {
  return fakeEditAdherence({
    schema: z.unknown(),
    messages: [{ role: "user", content: JSON.stringify(payload) }]
  });
}
