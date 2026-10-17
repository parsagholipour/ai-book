/**
 * Arms for the chapter line edit (H2). `no-edit` is arm (a), `baseline` (common.ts) is (b) as today,
 * `no-extend` is H2 item 4 alone (the length instruction is always "keep within ten percent"), and
 * `patch-mode` is arm (d) as probed in `.scratch/harness-redesign-2026-10-15/tools/probe-patch-edit.ts`,
 * with the plan's limits enforced in code. Hunk verdicts (arm c) need H2's new core module; a variant
 * for it imports that module once it exists and calls it on `fixture.payload.draft` and the edit.
 */
import { core, z } from "../container/runtime.ts";
import { sentences, wordCount } from "../lib/text.ts";
import { chapterFinal, replayLogged, rewriteSystem } from "./common.ts";
import type { Variant } from "./types.ts";

const KEEP_LENGTH = "Keep the draft's length within ten percent; do not add facts, sections, examples or explanation to reach a length.";

/** Replace whichever length instruction `editChapter` chose (extend / range / final line edit) with the ten-percent rule. */
export function withoutExtension(system: string): string {
  return system
    .replace(/The draft is \d+ words and the chapter needs about[\s\S]*?restating\./, KEEP_LENGTH)
    .replace(/Return between \d+ and \d+ words; the draft is \d+ words\. Over \d+, cut\./, KEEP_LENGTH);
}

export const noEdit: Variant = {
  name: "no-edit",
  description: "Arm (a): no line edit — the draft is staged as composed. Free.",
  purposes: ["edit-chapter"],
  async run({ fixture }) {
    const draft = String(fixture.payload?.draft ?? "");
    return { output: draft, finalText: chapterFinal(fixture, draft), calls: [], reported: { latencyMs: 0, usage: { promptTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheHitTokens: 0 }, costUsd: 0, model: { provider: "none", model: "none" } } };
  }
};

export const noExtend: Variant = {
  name: "no-extend",
  description: "H2 item 4: the editor is always told to keep the length within ten percent (the 'develop the existing sections' and word-range branches removed).",
  purposes: ["edit-chapter"],
  run: (context) => replayLogged(context, ({ messages, ...rest }) => ({ ...rest, messages: rewriteSystem(messages, withoutExtension) }))
};

const PATCH_RULE =
  "Return your edit as JSON only: {\"patches\":[{\"find\":\"an exact span copied from draft\",\"replace\":\"its replacement; an empty string deletes it\",\"reason\":\"a few words\"}]}. Copy every find exactly from draft, long enough to occur exactly once and never longer than two sentences; patches apply in order. Never replace a whole paragraph. Make exactly the edits the rules above call for and nothing else; leave every other sentence untouched. Return {\"patches\":[]} when the draft needs no edit.";
const patchSchema = z.object({ patches: z.array(z.object({ find: z.string(), replace: z.string(), reason: z.string().optional() })) });

export const patchMode: Variant = {
  name: "patch-mode",
  description: "Arm (d): find/replace patches instead of a whole chapter; maxTokens 3,000, at most 20 patches, finds of at most two sentences / 60 words (longer ones dropped in code), applied by core applyPagePatches.",
  purposes: ["edit-chapter"],
  async run(context) {
    const { fixture } = context;
    const draft = String(fixture.payload?.draft ?? "");
    const messages = rewriteSystem(fixture.messages, (system) => `${withoutExtension(system).replace(/Return only the revised chapter as Markdown[\s\S]*$/, "").trim()} ${PATCH_RULE}`);
    const record = await context.call({ purpose: fixture.purpose, json: true, messages, maxTokens: 3_000, ...(fixture.request.temperature !== undefined ? { temperature: fixture.request.temperature } : {}) });
    const parsed = patchSchema.safeParse(record.data);
    const proposed = parsed.success ? parsed.data.patches : [];
    const kept = proposed.filter((patch) => sentences(patch.find).length <= 2 && wordCount(patch.find) <= 60).slice(0, 20);
    // applyPagePatches is all-or-nothing; apply one at a time so a single bad find costs only itself.
    let patched = draft;
    let applied = 0;
    for (const patch of kept) {
      const step = core.applyPagePatches(patched, [{ find: patch.find, replace: patch.replace }]);
      if (step.failures.length === 0) {
        patched = step.markdown;
        applied += step.applied;
      }
    }
    return {
      output: record.text,
      data: record.data,
      finalText: chapterFinal(fixture, patched),
      calls: [record],
      extra: { proposed: proposed.length, kept: kept.length, droppedLongFinds: proposed.length - kept.length, applied, failures: kept.length - applied, schemaValid: parsed.success }
    };
  }
};
