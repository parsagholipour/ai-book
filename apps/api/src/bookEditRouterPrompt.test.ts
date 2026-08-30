import { describe, expect, it } from "vitest";
import { z } from "zod";

import { decideActionSchema, decideActionsFor } from "./bookEditRouterPrompt.js";

/**
 * The decide tool has two contracts and only one of them is code the model
 * reads: `decideActionSchema` is what the server *parses*, and the JSON Schema
 * `z.toJSONSchema(tool.parameters, { unrepresentable: "any" })` derives from it
 * — in `packages/core/src/adapters/gemini.ts` and `openaiToolCalling.ts` — is
 * what the provider is *told*. A rule the parser enforces and the conversion
 * cannot express is invisible to the model: a router in structured-output mode
 * omits the field the schema calls optional, the parse refuses the call, and
 * one of the two `ROUTER_MAX_MODEL_CALLS` is spent before the edit falls
 * through to the model-free classifier. So the tests below are asked of the
 * *converted* schema rather than of the zod object.
 */
const convertedToolSchema = (schema: ReturnType<typeof decideActionSchema>) =>
  z.toJSONSchema(schema, { unrepresentable: "any" }) as {
    properties: Record<string, unknown>;
    required?: string[] | undefined;
  };

describe("the decide tool schema the provider receives", () => {
  const actions = decideActionsFor("complete", false);
  const schema = decideActionSchema(actions);

  /** A decision that parses: every field the parser insists on is present. */
  const proposeEdit = {
    action: "propose_edit",
    confidence: 0.92,
    reasoning: "The reader asked for the ending to change.",
    assistantMessage: "I’ll rewrite the last page.",
    editInstruction: "Rewrite the final page so the fox returns the key before the storm.",
    clarification: "none",
    editTarget: "pages",
    editStyle: "rewrite",
    pageIndexes: [12],
    chapterIndex: null,
    targetLanguage: null
  } as const;

  it("marks every field the parser refuses to omit as required", () => {
    // The general form of the bug rather than the one instance of it: a field
    // whose absence the parser rejects, while the schema the model reads calls
    // it optional, is a call the model cannot know how to make.
    const converted = convertedToolSchema(schema);
    const required = new Set(converted.required ?? []);
    expect(schema.safeParse(proposeEdit).success).toBe(true);

    const mandatory = Object.keys(proposeEdit).filter((field) => {
      const withoutField: Record<string, unknown> = { ...proposeEdit };
      delete withoutField[field];
      return !schema.safeParse(withoutField).success;
    });

    expect(mandatory.filter((field) => !required.has(field))).toEqual([]);
  });

  it("names editInstruction in the tool schema, because propose_edit is refused without one", () => {
    const converted = convertedToolSchema(schema);

    expect(Object.keys(converted.properties)).toContain("editInstruction");
    expect(converted.required ?? []).toContain("editInstruction");
    // The durable execution contract for every priced edit: a proposal that
    // reached Apply with the raw chat fragment instead would draft something
    // else, so the parser's refusal stays.
    const withoutInstruction: Record<string, unknown> = { ...proposeEdit };
    delete withoutInstruction.editInstruction;
    expect(schema.safeParse(withoutInstruction).success).toBe(false);
    expect(schema.safeParse({ ...proposeEdit, editInstruction: "   " }).success).toBe(false);
  });

  it("still reads a decision that carries no instruction because it changes nothing", () => {
    // Required on the wire is not the same as required of every action: the
    // prompt asks for an empty string on answer/clarify/show_content, and a
    // model that sends none must not lose the turn over a field its decision
    // has no use for.
    const answered = schema.safeParse({
      action: "answer",
      confidence: 0.8,
      reasoning: "A question about the book.",
      assistantMessage: "It is about a fox.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });

    expect(answered.success).toBe(true);
    expect(answered.success && answered.data.editInstruction).toBe("");
  });
});
