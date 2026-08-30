import { describe, expect, it } from "vitest";
import {
  authoritativeReplanMessage,
  LEGACY_CHARACTER_CONTEXT_PREFIX,
  resolveEditPromptContext
} from "./editOperationContext.js";

const sheets = `${LEGACY_CHARACTER_CONTEXT_PREFIX}\n- Luna: careful navigator`;
const shortSheets = "Mentioned character profiles:\n- Luna: a brave night-flying rabbit.";

describe("resolveEditPromptContext", () => {
  it("keeps the durable approved instruction byte-equivalent while carrying sheets separately", () => {
    expect(
      resolveEditPromptContext(
        { request: "Mention Luna", editInstruction: "  Add Luna to page 2.  ", characterContext: `  ${sheets}  ` },
        { request: "stale", editInstruction: "stale", characterContext: "stale sheets" }
      )
    ).toEqual({
      editInstruction: "Add Luna to page 2.",
      requestContext: "stale",
      characterContext: sheets
    });
  });

  it("splits legacy combined durable strings without turning the sheets into requirements", () => {
    expect(
      resolveEditPromptContext(
        {
          request: "Mention Luna",
          editInstruction: `Add Luna to page 2.\n\n${sheets}`
        },
        { request: `Mention Luna\n\n${sheets}` }
      )
    ).toEqual({
      editInstruction: "Add Luna to page 2.",
      requestContext: "Mention Luna",
      characterContext: sheets
    });
  });

  it("recovers separate context from a legacy queue only when the durable row lacks it", () => {
    expect(
      resolveEditPromptContext(
        { request: "Mention Luna", editInstruction: null },
        { editInstruction: `Add Luna.\n\n${sheets}`, characterContext: "queued separate sheets" }
      )
    ).toEqual({
      editInstruction: "Add Luna.",
      requestContext: "Mention Luna",
      characterContext: "queued separate sheets"
    });
  });

  it("strips a fused request-plus-sheets payload without treating the sheets as the request", () => {
    const instruction = "Make the book brighter around Luna.";
    expect(
      resolveEditPromptContext(
        { request: "Make it brighter around @Luna.", editInstruction: instruction, characterContext: shortSheets },
        {
          request: `Make it brighter around @Luna.\n\n${shortSheets}`,
          editInstruction: instruction,
          characterContext: shortSheets
        }
      )
    ).toEqual({
      editInstruction: instruction,
      requestContext: "Make it brighter around @Luna.",
      characterContext: shortSheets
    });
  });
});

describe("authoritativeReplanMessage", () => {
  it("keeps sheets out of the approved-instruction section", () => {
    const instruction = "Rewrite the ending so Mara refuses the red key.";
    const composed = authoritativeReplanMessage(
      instruction,
      "change the ending",
      "Mentioned character profiles:\n- Mara: a careful navigator"
    );

    expect(composed).toContain(instruction);
    expect(composed).toContain("Original request context (supplemental only):");
    expect(composed).toContain("change the ending");
    expect(composed).toContain("Character context (supplemental canon, not an additional edit requirement):");
    expect(composed).toContain("careful navigator");
  });
});
