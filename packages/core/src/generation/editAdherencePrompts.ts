/**
 * What every adherence-review call is told, beside the shape it is told to
 * return.
 *
 * **Each prompt names its JSON keys and shows the shape, because prose alone
 * has the model spelling them from the words.** The leaf prompt used to say
 * "each evidence list has capacity 8" and name only `evidenceComplete` and
 * `acceptedInputIds`; on 2026-09-06 every one of twelve `collect-evidence`
 * calls in one edit came back with a coined `evidence` key and none of the four
 * lists the schema requires, and across every stored run that phase had never
 * once parsed on a real model. The whole-set prompt had the same gap one key
 * wide (`confidence`) and survived only because it gets a repair attempt. With
 * the leaf calls at zero repairs, one omission was a fail-closed verdict, an
 * `unverified` audit, and a delivered edit nobody had checked. The same rule
 * already governs the chapter-brief prompt (→ CLAUDE.md, "A brief prompt names
 * its JSON keys"); this file is that rule applied to the four review calls, and
 * `outputContract` in each payload is the shape beside the sentence.
 *
 * Kept out of `editAdherenceHierarchy.ts` so the prompt text can grow without
 * that file crossing its size budget, and so the sentence and the contract sit
 * next to each other.
 */

const WHOLE_SET_KEYS =
  "Return exactly one JSON object with the top-level keys satisfied (boolean), confidence (number from 0 to 1), missingRequirements (array of strings), contradictions (array of strings) and pageIndexesToRevise (array of integers), shaped like outputContract, and no other keys.";

/** Every bound the schema enforces is said in the prompt too; a length the model was never told is a refusal it cannot avoid. */
const verdictProseBound = (maxLength: number) =>
  `Each missingRequirements and contradictions entry is one sentence of at most ${maxLength} characters; longer entries are cut.`;
const evidenceItemBound = (maxLength: number) =>
  `Each fact is one sentence of at most ${maxLength} characters; a longer fact is cut, so lead with what matters.`;

export const wholeSetSystemMessage = (maxProseLength: number): string => [
  "You are an instruction-adherence checker for an already approved book edit.",
  "Judge only whether the after pages fully perform the approved instruction when compared with the before pages.",
  "Do not judge morality, safety, taste, advisability, writing style, or whether you would have chosen this edit.",
  "Review the changed page set jointly, because one requirement may be distributed across several pages.",
  "A material omission, contradiction, substitution, or silent softening means satisfied is false.",
  "missingRequirements, contradictions and pageIndexesToRevise are the repair order a satisfied=false verdict carries: name the concrete unmet requirements, the contradictions, and the after pages that can repair them. Leave all three empty when satisfied is true — nothing else is read from a satisfied verdict, and this review has no field for optional improvements.",
  verdictProseBound(maxProseLength),
  WHOLE_SET_KEYS
].join(" ");

export const WHOLE_SET_VERDICT_CONTRACT = {
  satisfied: true,
  confidence: 0.9,
  missingRequirements: ["<unmet requirement, only when satisfied is false>"],
  contradictions: ["<contradiction, only when satisfied is false>"],
  pageIndexesToRevise: [1]
} as const;

export function evidenceSystemMessage(capacity: number, maxItemLength: number): string {
  return [
    "You collect bounded evidence for an instruction-adherence review of an approved book edit.",
    "Inspect every supplied manuscript segment and report concrete facts relevant to the approved instruction.",
    "Do not make the operation-level satisfied or missing judgment: a requirement may be fulfilled in another segment.",
    "Preserve evidence of performed changes, possible omissions or softening, and contradictions for the global reviewer.",
    `Each evidence list has capacity ${capacity}; set evidenceComplete=false rather than omitting, sampling, or truncating a material fact, and a smaller slice of the same manuscript will be sent back to you.`,
    evidenceItemBound(maxItemLength),
    "Copy every supplied segment id into acceptedInputIds exactly once.",
    "Return exactly one JSON object with the top-level keys acceptedInputIds (array of strings), evidenceComplete (boolean), observedChanges (array of strings: changes the after segments perform), requirementEvidence (array of strings: where a requirement of the instruction is met), possibleOmissions (array of strings), contradictions (array of strings) and pageIndexes (array of integers: the pages the evidence is about), shaped like outputContract, and no other keys. Every list is present even when empty."
  ].join(" ");
}

export const LEAF_EVIDENCE_CONTRACT = {
  acceptedInputIds: ["<every supplied segment id, exactly once>"],
  evidenceComplete: true,
  observedChanges: ["<a change the after text performs>"],
  requirementEvidence: ["<where a requirement of the instruction is met>"],
  possibleOmissions: ["<a requirement this slice may leave unmet>"],
  contradictions: ["<a place the after text contradicts the instruction>"],
  pageIndexes: [1]
} as const;

export function reducerSystemMessage(capacity: number, maxItemLength: number): string {
  return [
    "You merge complete bounded evidence for an instruction-adherence review of an approved book edit.",
    "Summarize the supplied positive facts without inventing or dropping any of them.",
    "Combine complementary evidence because one requirement may be distributed across nodes.",
    "Every output fact must list the exact sourceFactIds it summarizes; across each category, those ids must reproduce every supplied fact id exactly once and in order.",
    `Each output list has capacity ${capacity}: name more source facts in one summary rather than omitting, sampling, or truncating any of them, and set evidenceComplete=false only if you could not name every supplied fact id.`,
    evidenceItemBound(maxItemLength),
    "Do not make the operation-level satisfied judgment. Copy every supplied node id into acceptedInputIds exactly once.",
    "Return exactly one JSON object with the top-level keys acceptedInputIds (array of strings), evidenceComplete (boolean), observedChanges and requirementEvidence (each an array of objects with text and sourceFactIds), shaped like outputContract, and no other keys."
  ].join(" ");
}

export const REDUCED_EVIDENCE_CONTRACT = {
  acceptedInputIds: ["<every supplied node id, exactly once>"],
  evidenceComplete: true,
  observedChanges: [{ text: "<summary of the source facts>", sourceFactIds: ["<fact id copied from evidenceNodes>"] }],
  requirementEvidence: [{ text: "<summary of the source facts>", sourceFactIds: ["<fact id copied from evidenceNodes>"] }]
} as const;

export const finalSystemMessage = (maxProseLength: number): string => [
  "You are the final instruction-adherence checker for an already approved book edit.",
  "The evidence covers the complete before/after candidate set. Make one operation-level judgment over all of it.",
  "Judge only whether the after pages fully perform the approved instruction when compared with the before pages.",
  "Do not judge morality, safety, taste, advisability, writing style, or whether you would have chosen this edit.",
  "Requirements may be distributed across evidence nodes, but a material omission, contradiction, substitution, or silent softening means satisfied is false.",
  "Copy every supplied negative fact id into acceptedNegativeFactIds exactly once and in order.",
  "A possible omission may appear in resolvedPossibleOmissionIds only when the complete positive evidence proves that exact concern was fulfilled elsewhere; preserve order and never include a contradiction id.",
  "missingRequirements, contradictions and pageIndexesToRevise are the repair order a satisfied=false verdict carries: name the concrete unmet requirements, the contradictions, and the after pages that can repair them. Leave all three empty when satisfied is true — nothing else is read from a satisfied verdict, and this review has no field for optional improvements.",
  "Copy the supplied evidence id, coverage digest, and evidence digest exactly.",
  verdictProseBound(maxProseLength),
  "Return exactly one JSON object with the top-level keys satisfied (boolean), confidence (number from 0 to 1), missingRequirements (array of strings), contradictions (array of strings), pageIndexesToRevise (array of integers), acceptedEvidenceId (string), coverageDigest (string), evidenceDigest (string), acceptedNegativeFactIds (array of strings) and resolvedPossibleOmissionIds (array of strings), shaped like outputContract, and no other keys."
].join(" ");

export const FINAL_VERDICT_CONTRACT = {
  satisfied: true,
  confidence: 0.9,
  missingRequirements: ["<unmet requirement, only when satisfied is false>"],
  contradictions: ["<contradiction, only when satisfied is false>"],
  pageIndexesToRevise: [1],
  acceptedEvidenceId: "<completeCoverage.evidenceId, copied exactly>",
  coverageDigest: "<completeCoverage.digest, copied exactly>",
  evidenceDigest: "<completeCoverage.evidenceDigest, copied exactly>",
  acceptedNegativeFactIds: ["<every negativeEvidence fact id, in order>"],
  resolvedPossibleOmissionIds: ["<a possibleOmissions id the positive evidence resolves>"]
} as const;
