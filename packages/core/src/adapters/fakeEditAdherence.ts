import type { GenerateJsonOptions } from "./types.js";

/**
 * **A fake that can only ever answer "satisfied" hides the expensive half of
 * this protocol, and `MOCK_AI=true` is how this repo is worked on.** Nobody
 * meets a fail-closed verdict, a repair round or a refund locally, so every
 * failure path in the adherence review is exercised by unit tests alone. The
 * opt-in is a marker in the reader's own edit instruction, because that is the
 * one string a developer types and every phase of the protocol carries it as
 * `approvedInstruction` — no environment variable, no process restart, and two
 * edits in one session can ask for different answers. Nothing here runs outside
 * `FakeTextModelAdapter`, so the marker is unreachable from a real provider.
 *
 * `unsatisfied` drives the caller's repair rounds and then
 * `EDIT_ADHERENCE_FAILED`; `truncated` and `failed` are the two shapes of a
 * thrown provider call, and both become the fail-closed verdict; `incomplete`
 * is the leaf's backpressure, so it only bites a manuscript large enough to be
 * segmented at all.
 */
export const FAKE_ADHERENCE_MODES = ["unsatisfied", "incomplete", "truncated", "failed"] as const;

export type FakeAdherenceMode = (typeof FAKE_ADHERENCE_MODES)[number];

/** Phase-aware dry-run answers for the bounded adherence-review protocol. */
export function fakeEditAdherence(options: GenerateJsonOptions<unknown>): unknown {
  const payload = userPayload(options);
  const mode = requestedMode(payload);
  if (mode === "truncated") {
    throw new SyntaxError("Unexpected end of JSON input");
  }
  if (mode === "failed") {
    throw new Error("[MOCK_AI] The adherence reviewer is unavailable.");
  }
  if (payload.reviewPhase === "collect-evidence") {
    return leafEvidenceFor(payload.segments, mode !== "incomplete");
  }
  if (payload.reviewPhase === "reduce-evidence") {
    return reducedEvidenceFor(payload.evidenceNodes);
  }
  if (payload.reviewPhase === "global-verdict") {
    const coverage = recordValue(payload.completeCoverage);
    const negativeEvidence = recordValue(payload.negativeEvidence);
    const possibleOmissions = factRecords(negativeEvidence?.possibleOmissions);
    const contradictions = factRecords(negativeEvidence?.contradictions);
    return {
      ...verdictFor(mode),
      acceptedEvidenceId: coverage?.evidenceId ?? "missing-evidence",
      coverageDigest: coverage?.digest ?? "0".repeat(64),
      evidenceDigest: coverage?.evidenceDigest ?? "0".repeat(64),
      acceptedNegativeFactIds: [...possibleOmissions, ...contradictions].map((fact) => fact.id),
      resolvedPossibleOmissionIds: possibleOmissions.map((fact) => fact.id)
    };
  }
  return verdictFor(mode);
}

function leafEvidenceFor(inputs: unknown, evidenceComplete: boolean) {
  return {
    ...acceptedInputs(inputs),
    evidenceComplete,
    observedChanges: [],
    requirementEvidence: [],
    possibleOmissions: [],
    contradictions: [],
    pageIndexes: []
  };
}

function reducedEvidenceFor(inputs: unknown) {
  const nodes = records(inputs);
  return {
    ...acceptedInputs(inputs),
    evidenceComplete: true,
    observedChanges: positiveFacts(nodes, "observedChanges"),
    requirementEvidence: positiveFacts(nodes, "requirementEvidence")
  };
}

function acceptedInputs(inputs: unknown) {
  const acceptedInputIds = Array.isArray(inputs)
    ? inputs.flatMap((input) => {
        const record = recordValue(input);
        return typeof record?.id === "string" ? [record.id] : [];
      })
    : [];
  return {
    acceptedInputIds
  };
}

function positiveFacts(nodes: Array<Record<string, unknown>>, field: string) {
  return nodes.flatMap((node) =>
    factRecords(recordValue(node.evidence)?.[field]).map((fact) => ({
      text: fact.text,
      sourceFactIds: [fact.id]
    }))
  );
}

function verdictFor(mode: FakeAdherenceMode | undefined) {
  const satisfied = mode !== "unsatisfied";
  return {
    satisfied,
    confidence: satisfied ? 1 : 0.9,
    missingRequirements: satisfied ? [] : ["[MOCK_AI] The approved instruction was not performed."],
    contradictions: [],
    // Empty is the honest answer: the reviewer normalizes an unsatisfied
    // verdict onto every changed page, which is the set a dry run is editing.
    pageIndexesToRevise: []
  };
}

/** The marker is matched whole, so an instruction merely discussing one is not one. */
function requestedMode(payload: Record<string, unknown>): FakeAdherenceMode | undefined {
  const instruction = typeof payload.approvedInstruction === "string" ? payload.approvedInstruction : "";
  return FAKE_ADHERENCE_MODES.find((mode) => instruction.includes(`[mock-adherence:${mode}]`));
}

function userPayload(options: GenerateJsonOptions<unknown>): Record<string, unknown> {
  const userMessage = [...options.messages].reverse().find((message) => message.role === "user");
  if (!userMessage) {
    return {};
  }
  try {
    return recordValue(JSON.parse(userMessage.content)) ?? {};
  } catch {
    return {};
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.flatMap((item) => (recordValue(item) ? [recordValue(item)!] : [])) : [];
}

function factRecords(value: unknown): Array<{ id: string; text: string }> {
  return records(value).flatMap((fact) =>
    typeof fact.id === "string" && typeof fact.text === "string" ? [{ id: fact.id, text: fact.text }] : []
  );
}
