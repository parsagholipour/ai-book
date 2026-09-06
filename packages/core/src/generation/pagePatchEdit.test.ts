import { describe, expect, it } from "vitest";

import { makeFallbackPlan } from "../prompting/templates.js";
import {
  applyPagePatches,
  codeFencesBalanced,
  MAX_PAGE_PATCHES,
  PAGE_PATCH_OUTPUT_CONTRACT,
  pagePatchDecision,
  pagePatchMaxTokens,
  pagePatchMessages,
  pagePatchResponseSchema
} from "./pagePatchEdit.js";

const page = [
  "A warehouse dashboard lists outgoing packages by tracking number.",
  "",
  "```pseudocode",
  "binarySearch(items, target):",
  "    low = 0",
  "```",
  "",
  "The search continues on the remaining half. The search continues on the remaining half."
].join("\n");

const jsBlock = ["```javascript", "const binarySearch = (items, target) => {", "  let low = 0;", "};", "```"].join("\n");

describe("applyPagePatches", () => {
  it("replaces a unique span and leaves every other byte in place", () => {
    const result = applyPagePatches(page, [{ find: page.split("\n").slice(2, 6).join("\n"), replace: jsBlock }]);

    expect(result.failures).toEqual([]);
    expect(result.applied).toBe(1);
    expect(result.markdown).toBe(
      [
        "A warehouse dashboard lists outgoing packages by tracking number.",
        "",
        jsBlock,
        "",
        "The search continues on the remaining half. The search continues on the remaining half."
      ].join("\n")
    );
  });

  it("applies nothing when one patch cannot be placed, and says which", () => {
    const result = applyPagePatches(page, [
      { find: "A warehouse dashboard", replace: "A depot dashboard" },
      { find: "This sentence is not on the page.", replace: "x" }
    ]);

    expect(result.markdown).toBe(page);
    expect(result.applied).toBe(0);
    expect(result.failures).toEqual([{ find: "This sentence is not on the page.", reason: "not_found" }]);
  });

  it("refuses a span the page holds twice", () => {
    const result = applyPagePatches(page, [{ find: "The search continues on the remaining half.", replace: "x" }]);

    expect(result.failures).toEqual([{ find: "The search continues on the remaining half.", reason: "ambiguous" }]);
  });

  it("forgives collapsed whitespace and stray padding in a find, still uniquely", () => {
    const result = applyPagePatches(page, [
      { find: "  binarySearch(items, target): low = 0 ", replace: "search(items, target):\n    low = 0" }
    ]);

    expect(result.failures).toEqual([]);
    expect(result.markdown).toContain("search(items, target):\n    low = 0\n```");
  });

  it("refuses a result that opens a fence it never closes", () => {
    const result = applyPagePatches(page, [{ find: "```pseudocode", replace: "```javascript\n```javascript" }]);

    expect(result.markdown).toBe(page);
    expect(result.failures).toEqual([{ find: "", reason: "unbalanced_fence" }]);
  });

  it("refuses a result that empties the page", () => {
    const result = applyPagePatches("Only line.", [{ find: "Only line.", replace: "   " }]);

    expect(result.failures).toEqual([{ find: "", reason: "empty_result" }]);
  });

  it("skips a patch whose replacement is its find", () => {
    const result = applyPagePatches(page, [{ find: "A warehouse dashboard", replace: "A warehouse dashboard" }]);

    expect(result.applied).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.markdown).toBe(page);
  });

  it("applies later patches against the text the earlier ones left", () => {
    const result = applyPagePatches("one two three", [
      { find: "one", replace: "uno" },
      { find: "uno two", replace: "uno dos" }
    ]);

    expect(result.markdown).toBe("uno dos three");
    expect(result.applied).toBe(2);
  });
});

describe("codeFencesBalanced", () => {
  it("counts fence lines, not backticks in prose", () => {
    expect(codeFencesBalanced("say `x` then\n```js\ncode\n```")).toBe(true);
    expect(codeFencesBalanced("```js\ncode")).toBe(false);
    expect(codeFencesBalanced("~~~\ncode\n~~~")).toBe(true);
  });
});

describe("pagePatchDecision", () => {
  it("reads a patched reply with no replacements as an unchanged page", () => {
    expect(pagePatchDecision({ outcome: "patched", reason: "", patches: [] })).toMatchObject({ kind: "unchanged" });
    expect(
      pagePatchDecision({ outcome: "patched", reason: "", patches: [{ find: "a", replace: "a" }] })
    ).toMatchObject({ kind: "unchanged" });
  });

  it("carries the model's reason for declining", () => {
    expect(pagePatchDecision({ outcome: "whole_page", reason: "It re-plots the scene.", patches: [] })).toEqual({
      kind: "whole_page",
      reason: "It re-plots the scene."
    });
    expect(pagePatchDecision({ outcome: "unchanged", reason: "", patches: [] })).toMatchObject({ kind: "unchanged" });
  });

  it("hands the patches and the optional summary through", () => {
    expect(
      pagePatchDecision({ outcome: "patched", reason: "", patches: [{ find: "a", replace: "b" }], summary: "New summary." })
    ).toEqual({ kind: "patched", patches: [{ find: "a", replace: "b" }], summary: "New summary." });
  });
});

describe("pagePatchMessages", () => {
  const input = {
    prompt: "A practical guide to programming algorithms for working developers.",
    category: "CUSTOM" as const,
    targetPages: 8,
    complexity: 6,
    temperature: 0.6,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven" as const,
      includeCover: true,
      coverTemplate: "auto" as const,
      finalReview: true,
      toneProfile: "neutral" as const
    }
  };
  const plan = makeFallbackPlan(input as never);

  it("names the reply's keys, shows the contract and carries the page and the instruction", () => {
    const messages = pagePatchMessages({
      input: input as never,
      plan,
      editInstruction: "Rewrite every code block in JavaScript.",
      page: { index: 4, title: "Halving", summary: "Binary search.", markdown: page }
    });

    const system = messages[0]!.content;
    for (const key of Object.keys(pagePatchResponseSchema.shape)) {
      expect(system).toContain(key);
    }
    const payload = JSON.parse(messages[1]!.content);
    expect(payload).toMatchObject({
      editInstruction: "Rewrite every code block in JavaScript.",
      pageIndex: 4,
      pageMarkdown: page,
      outputContract: PAGE_PATCH_OUTPUT_CONTRACT
    });
    expect(Object.keys(PAGE_PATCH_OUTPUT_CONTRACT).sort()).toEqual(Object.keys(pagePatchResponseSchema.shape).sort());
    expect(payload).not.toHaveProperty("adherenceRepair");
    expect(payload).not.toHaveProperty("patchRepair");
  });

  it("sends the previous attempt's failures back and says what each reason means", () => {
    const messages = pagePatchMessages({
      input: input as never,
      plan,
      editInstruction: "Rewrite every code block in JavaScript.",
      adherenceRepair: ["The second block is still pseudocode."],
      patchRepair: [{ find: "not here", reason: "not_found" }],
      page: { index: 4, title: "Halving", summary: "Binary search.", markdown: page }
    });

    expect(messages[0]!.content).toContain("not_found");
    expect(JSON.parse(messages[1]!.content)).toMatchObject({
      adherenceRepair: ["The second block is still pseudocode."],
      patchRepair: [{ find: "not here", reason: "not_found" }]
    });
  });

  it("tells a book about code how to fence it", () => {
    const messages = pagePatchMessages({
      input: input as never,
      plan,
      editInstruction: "Use JavaScript.",
      page: { index: 1, title: "t", summary: "s", markdown: "x" }
    });

    expect(messages[0]!.content).toContain("tag pseudocode as pseudocode");
  });
});

describe("pagePatchMaxTokens", () => {
  it("follows the page between a floor and a cap", () => {
    expect(pagePatchMaxTokens("short")).toBe(2400);
    expect(pagePatchMaxTokens("x".repeat(4000))).toBe(5200);
    expect(pagePatchMaxTokens("x".repeat(50_000))).toBe(12_000);
  });
});

describe("pagePatchResponseSchema", () => {
  it("defaults reason and patches, refuses unknown keys and over-long lists", () => {
    expect(pagePatchResponseSchema.parse({ outcome: "unchanged" })).toEqual({ outcome: "unchanged", reason: "", patches: [] });
    expect(pagePatchResponseSchema.safeParse({ outcome: "patched", patches: [], extra: 1 }).success).toBe(false);
    expect(
      pagePatchResponseSchema.safeParse({
        outcome: "patched",
        patches: Array.from({ length: MAX_PAGE_PATCHES + 1 }, () => ({ find: "a", replace: "b" }))
      }).success
    ).toBe(false);
  });
});
