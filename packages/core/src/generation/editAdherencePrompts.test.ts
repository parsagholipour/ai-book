import { describe, expect, it } from "vitest";

import { editAdherenceVerdictSchema } from "./editAdherence.js";
import {
  clipEvidenceText,
  EDIT_ADHERENCE_EVIDENCE_CAPACITY,
  finalResponseSchema,
  leafEvidenceResponseSchema,
  MAX_EVIDENCE_ITEM_LENGTH,
  MAX_VERDICT_PROSE_LENGTH,
  reducerEvidenceResponseSchema
} from "./editAdherenceSchemas.js";
import {
  evidenceSystemMessage,
  FINAL_VERDICT_CONTRACT,
  finalSystemMessage,
  LEAF_EVIDENCE_CONTRACT,
  REDUCED_EVIDENCE_CONTRACT,
  reducerSystemMessage,
  wholeSetSystemMessage,
  WHOLE_SET_VERDICT_CONTRACT
} from "./editAdherencePrompts.js";

/**
 * Every adherence call names each key its schema requires and shows the shape.
 * The leaf prompt used to name two of seven, and on 2026-09-06 twelve of twelve
 * real-model replies coined an `evidence` key instead; the phase had never
 * parsed on a real model.
 */
const prompts = [
  {
    name: "whole-set verdict",
    system: wholeSetSystemMessage(MAX_VERDICT_PROSE_LENGTH),
    contract: WHOLE_SET_VERDICT_CONTRACT,
    schema: editAdherenceVerdictSchema
  },
  {
    name: "leaf evidence",
    system: evidenceSystemMessage(EDIT_ADHERENCE_EVIDENCE_CAPACITY, MAX_EVIDENCE_ITEM_LENGTH),
    contract: LEAF_EVIDENCE_CONTRACT,
    schema: leafEvidenceResponseSchema
  },
  {
    name: "reduced evidence",
    system: reducerSystemMessage(EDIT_ADHERENCE_EVIDENCE_CAPACITY, MAX_EVIDENCE_ITEM_LENGTH),
    contract: REDUCED_EVIDENCE_CONTRACT,
    schema: reducerEvidenceResponseSchema
  },
  {
    name: "final verdict",
    system: finalSystemMessage(MAX_VERDICT_PROSE_LENGTH),
    contract: FINAL_VERDICT_CONTRACT,
    schema: finalResponseSchema
  }
];

describe("edit adherence prompts", () => {
  for (const prompt of prompts) {
    const keys = Object.keys(prompt.schema.shape);

    it(`${prompt.name}: names every key its schema requires`, () => {
      for (const key of keys) {
        expect(prompt.system, key).toContain(key);
      }
      expect(prompt.system).toContain("outputContract");
    });

    it(`${prompt.name}: shows a contract with exactly the schema's keys`, () => {
      expect(Object.keys(prompt.contract).sort()).toEqual([...keys].sort());
    });
  }

  it("the two verdict contracts parse as verdicts, so the shape shown is the shape accepted", () => {
    expect(editAdherenceVerdictSchema.safeParse(WHOLE_SET_VERDICT_CONTRACT).success).toBe(true);
    expect(
      leafEvidenceResponseSchema.safeParse({ ...LEAF_EVIDENCE_CONTRACT, acceptedInputIds: ["seg-1"] }).success
    ).toBe(true);
  });

  it("states every length bound it enforces, and cuts a fact past it instead of refusing the review", () => {
    expect(evidenceSystemMessage(8, MAX_EVIDENCE_ITEM_LENGTH)).toContain(`at most ${MAX_EVIDENCE_ITEM_LENGTH} characters`);
    expect(reducerSystemMessage(8, MAX_EVIDENCE_ITEM_LENGTH)).toContain(`at most ${MAX_EVIDENCE_ITEM_LENGTH} characters`);
    expect(finalSystemMessage(MAX_VERDICT_PROSE_LENGTH)).toContain(`at most ${MAX_VERDICT_PROSE_LENGTH} characters`);
    expect(wholeSetSystemMessage(MAX_VERDICT_PROSE_LENGTH)).toContain(`at most ${MAX_VERDICT_PROSE_LENGTH} characters`);

    const long = "The after segment presents the lookup routine as concrete Python using def, while loops, indexing and None, ".repeat(4);
    const parsed = leafEvidenceResponseSchema.parse({
      acceptedInputIds: ["seg-1"],
      evidenceComplete: true,
      observedChanges: [long],
      requirementEvidence: [],
      possibleOmissions: [],
      contradictions: [],
      pageIndexes: [2]
    });
    expect(parsed.observedChanges[0]!.length).toBeLessThanOrEqual(MAX_EVIDENCE_ITEM_LENGTH);
    expect(parsed.observedChanges[0]!.endsWith("…")).toBe(true);
    expect(clipEvidenceText("short", 240)).toBe("short");
    const verdict = editAdherenceVerdictSchema.parse({ ...WHOLE_SET_VERDICT_CONTRACT, missingRequirements: ["x".repeat(900)] });
    expect(verdict.missingRequirements[0]!.length).toBeLessThanOrEqual(MAX_VERDICT_PROSE_LENGTH);
  });
});
