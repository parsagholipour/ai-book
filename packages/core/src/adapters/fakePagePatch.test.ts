import { describe, expect, it } from "vitest";

import { pagePatchResponseSchema } from "../generation/pagePatchEdit.js";
import { fakePagePatch } from "./fakePagePatch.js";

function call(editInstruction: string, pageMarkdown: string) {
  return fakePagePatch({
    schema: pagePatchResponseSchema,
    messages: [
      { role: "system", content: "patch" },
      { role: "user", content: JSON.stringify({ editInstruction, pageMarkdown }) }
    ]
  });
}

describe("fakePagePatch", () => {
  it("replaces the first fenced block, and the first line of a page without one", () => {
    const fenced = pagePatchResponseSchema.parse(call("Use JavaScript.", "Intro.\n\n```pseudocode\nx\n```\n\nOutro."));
    expect(fenced.outcome).toBe("patched");
    expect(fenced.patches[0]).toMatchObject({ find: "```pseudocode\nx\n```" });
    expect(fenced.patches[0]!.replace).toContain("```javascript");

    const plain = pagePatchResponseSchema.parse(call("Warmer.", "First line.\nSecond line."));
    expect(plain.patches).toEqual([{ find: "First line.", replace: "First line. [MOCK_AI patched]" }]);
  });

  it("declines, misses or fails on the marker in the instruction", () => {
    expect(pagePatchResponseSchema.parse(call("x [mock-patch:unchanged]", "Line."))).toMatchObject({ outcome: "unchanged", patches: [] });
    expect(pagePatchResponseSchema.parse(call("x [mock-patch:whole_page]", "Line."))).toMatchObject({ outcome: "whole_page" });
    const miss = pagePatchResponseSchema.parse(call("x [mock-patch:miss]", "Line."));
    expect(miss.patches[0]!.find).not.toContain("Line.");
    expect(() => call("x [mock-patch:failed]", "Line.")).toThrow(/unavailable/);
  });
});
