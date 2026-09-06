import type { GenerateJsonOptions } from "./types.js";

/**
 * Dry-run answers for the surgical page-patch call (`pagePatchEdit.ts`).
 *
 * The default answer changes one visible thing — the first fenced block, or
 * failing that the first line — so a `MOCK_AI` edit still moves the page and
 * the adherence review still has a change to read. The decline and failure
 * paths are reachable the way the adherence fake's are: a marker in the edit
 * instruction, because that is the one string a developer types and the
 * prompt carries it as `editInstruction`. `unchanged` and `whole_page` are the
 * model's two ways of declining; `miss` returns a find that is not on the page
 * so the re-ask and the whole-page fallback run; `failed` throws.
 */
export const FAKE_PATCH_MODES = ["unchanged", "whole_page", "miss", "failed"] as const;

export type FakePatchMode = (typeof FAKE_PATCH_MODES)[number];

export function fakePagePatch(options: GenerateJsonOptions<unknown>): unknown {
  const payload = userPayload(options);
  const instruction = typeof payload.editInstruction === "string" ? payload.editInstruction : "";
  const mode = FAKE_PATCH_MODES.find((candidate) => instruction.includes(`[mock-patch:${candidate}]`));
  if (mode === "failed") {
    throw new Error("[MOCK_AI] The page patcher is unavailable.");
  }
  if (mode === "unchanged" || mode === "whole_page") {
    return { outcome: mode, reason: `[MOCK_AI] declined as ${mode}.`, patches: [] };
  }
  if (mode === "miss") {
    return {
      outcome: "patched",
      reason: "",
      patches: [{ find: "[MOCK_AI] a span that is not on this page", replace: "[MOCK_AI] never applied" }]
    };
  }
  const markdown = typeof payload.pageMarkdown === "string" ? payload.pageMarkdown : "";
  const fence = markdown.match(/```[^\n]*\n[\s\S]*?```/);
  if (fence) {
    return {
      outcome: "patched",
      reason: "",
      patches: [{ find: fence[0], replace: "```javascript\n// [MOCK_AI] patched block\n```" }]
    };
  }
  const firstLine = markdown.split("\n").find((line) => line.trim().length > 0) ?? "";
  if (!firstLine) {
    return { outcome: "unchanged", reason: "[MOCK_AI] empty page.", patches: [] };
  }
  return {
    outcome: "patched",
    reason: "",
    patches: [{ find: firstLine, replace: `${firstLine} [MOCK_AI patched]` }]
  };
}

function userPayload(options: GenerateJsonOptions<unknown>): Record<string, unknown> {
  const userMessage = [...options.messages].reverse().find((message) => message.role === "user");
  if (!userMessage) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(userMessage.content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
