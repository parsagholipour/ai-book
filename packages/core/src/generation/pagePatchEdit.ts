import { z } from "zod";

import type { ChatMessage } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { codeBlockRules } from "./codeBlockRules.js";
import { GROUNDED_FACTUALITY_RULE, writerToneRules } from "./pagesShared.js";

/**
 * A reader's edit as exact replacements on one page, never as a rewritten
 * page.
 *
 * **The surgical tier of a chat edit.** Until this existed there was nothing
 * between a verified literal find/replace (`exactReplacement.ts`, free and
 * model-free) and a whole-page regeneration through the QA revise prompt. "Use
 * JavaScript in the codes" therefore re-drafted eight pages of an algorithms
 * book at temperature 0.65 under a prompt built to freshen prose, and the
 * reader got a staircase recursion where a topological sort had been. The
 * model is now asked, per page, for the smallest set of `{find, replace}`
 * pairs that performs the approved instruction; code applies them with an
 * exact, unique match and refuses anything else, so every character the
 * instruction did not name is provably the character that was there.
 *
 * The model may decline: `unchanged` when nothing on the page is covered by
 * the instruction (the page is skipped and settled, not re-drafted), and
 * `whole_page` when the request is a re-plot, a restructure or a rewrite of
 * the page's whole argument — the one case the regeneration path exists for.
 * A patch whose `find` is not on the page, or is on it twice, fails the whole
 * set; the caller re-asks once with the failures and then falls back to the
 * whole-page path. Nothing is ever partially applied.
 */

export const PAGE_PATCH_PURPOSE = "patch-page";

/**
 * Why a text edit left a page it was priced for untouched. `literal_gone` is
 * the exact path's reason (the quoted text was no longer on the page);
 * `nothing_to_change` is the patch tier declining a page the instruction does
 * not cover. Recorded on the operation's classifier beside
 * `skippedPageIndexes`, because the card is where the reader learns it.
 */
export const TEXT_EDIT_SKIP_REASONS = ["literal_gone", "nothing_to_change"] as const;
export type TextEditSkipReason = (typeof TEXT_EDIT_SKIP_REASONS)[number];

/** Enough for every code block on a long page and a handful of sentences. */
export const MAX_PAGE_PATCHES = 24;
const MAX_PATCH_FIND_LENGTH = 6000;
const MAX_PATCH_REPLACE_LENGTH = 8000;

export const pagePatchSchema = z
  .object({
    find: z.string().min(1).max(MAX_PATCH_FIND_LENGTH),
    replace: z.string().max(MAX_PATCH_REPLACE_LENGTH)
  })
  .strict();

export const PAGE_PATCH_OUTCOMES = ["patched", "unchanged", "whole_page"] as const;

export const pagePatchResponseSchema = z
  .object({
    outcome: z.enum(PAGE_PATCH_OUTCOMES),
    reason: z.string().trim().max(400).default(""),
    patches: z.array(pagePatchSchema).max(MAX_PAGE_PATCHES).default([]),
    /** Only when the change alters what the stored summary says. */
    summary: z.string().trim().min(1).max(1200).nullish()
  })
  .strict();

export type PagePatch = z.infer<typeof pagePatchSchema>;
export type PagePatchResponse = z.infer<typeof pagePatchResponseSchema>;

export const PAGE_PATCH_OUTPUT_CONTRACT = {
  outcome: "patched",
  reason: "<one sentence, only for unchanged or whole_page>",
  patches: [{ find: "<text copied verbatim from pageMarkdown, unique on the page>", replace: "<the text that takes its place>" }],
  summary: "<the page summary, only when the change alters what it says>"
} as const;

export type PagePatchFailureReason = "not_found" | "ambiguous" | "unbalanced_fence" | "empty_result";

export type PagePatchFailure = {
  find: string;
  reason: PagePatchFailureReason;
};

export type PagePatchApplication = {
  /** The original text when any patch failed; nothing is applied by half. */
  markdown: string;
  applied: number;
  failures: PagePatchFailure[];
};

/**
 * Applies every patch, in order, against the text as the earlier patches left
 * it, or applies none. A `find` has to occur exactly once: zero occurrences is
 * a copy the model got wrong, two is a span the page cannot tell apart, and
 * either one is sent back for a re-ask rather than guessed at.
 */
export function applyPagePatches(markdown: string, patches: readonly PagePatch[]): PagePatchApplication {
  let current = markdown;
  let applied = 0;
  const failures: PagePatchFailure[] = [];
  for (const patch of patches) {
    if (patch.find === patch.replace) continue;
    const span = locatePatchSpan(current, patch.find);
    if (span.kind !== "one") {
      failures.push({ find: patch.find, reason: span.kind });
      continue;
    }
    current = `${current.slice(0, span.start)}${patch.replace}${current.slice(span.end)}`;
    applied += 1;
  }
  if (failures.length > 0) {
    return { markdown, applied: 0, failures };
  }
  if (current.trim().length === 0) {
    return { markdown, applied: 0, failures: [{ find: "", reason: "empty_result" }] };
  }
  if (!codeFencesBalanced(current)) {
    return { markdown, applied: 0, failures: [{ find: "", reason: "unbalanced_fence" }] };
  }
  return { markdown: current, applied, failures: [] };
}

type PatchSpan = { kind: "one"; start: number; end: number } | { kind: "not_found" | "ambiguous" };

/**
 * Exact first; then the two ways a model most often mis-copies a span —
 * trailing/leading whitespace, and collapsed runs of whitespace or line
 * breaks — matched loosely but still required to be unique.
 */
function locatePatchSpan(text: string, find: string): PatchSpan {
  const exact = uniqueOccurrence(text, find);
  if (exact.kind !== "not_found") return exact;
  const trimmed = find.trim();
  if (trimmed && trimmed !== find) {
    const loose = uniqueOccurrence(text, trimmed);
    if (loose.kind !== "not_found") return loose;
  }
  const pattern = whitespaceInsensitivePattern(trimmed || find);
  if (!pattern) return { kind: "not_found" };
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return { kind: "not_found" };
  if (matches.length > 1) return { kind: "ambiguous" };
  const match = matches[0]!;
  return { kind: "one", start: match.index, end: match.index + match[0].length };
}

function uniqueOccurrence(text: string, find: string): PatchSpan {
  const first = text.indexOf(find);
  if (first < 0) return { kind: "not_found" };
  if (text.indexOf(find, first + find.length) >= 0) return { kind: "ambiguous" };
  return { kind: "one", start: first, end: first + find.length };
}

function whitespaceInsensitivePattern(find: string): RegExp | null {
  const parts = find.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const source = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  try {
    return new RegExp(source, "g");
  } catch {
    return null;
  }
}

/** A fenced block opened and never closed swallows the rest of the page at render time. */
export function codeFencesBalanced(markdown: string): boolean {
  const fenceLines = markdown.split(/\r?\n/).filter((line) => /^\s*(?:```|~~~)/.test(line));
  return fenceLines.length % 2 === 0;
}

export type PagePatchPromptOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  /** The approved reader request; authoritative. */
  editInstruction: string;
  /** Supplemental guidance scoped to this page; never authoritative over editInstruction. */
  pageEditGuidance?: string | undefined;
  /** Prompt-only character canon, never part of the approved instruction. */
  characterContext?: string | undefined;
  /** Concrete omissions the operation-level adherence reviewer named. */
  adherenceRepair?: readonly string[] | undefined;
  /** Patches from the previous reply that could not be applied. */
  patchRepair?: readonly PagePatchFailure[] | undefined;
  page: {
    index: number;
    title: string;
    summary: string;
    /** What the model is shown: a stored figure appears as its stand-in. */
    markdown: string;
  };
};

export function pagePatchMessages(options: PagePatchPromptOptions): ChatMessage[] {
  const system = [
    "You apply one approved reader edit to one page of a finished book by returning exact replacements, never a rewritten page.",
    "editInstruction is the approved reader request and is authoritative. Perform it completely on this page; do not soften, substitute, or silently omit it.",
    ...(options.pageEditGuidance
      ? ["pageEditGuidance is supplemental guidance for this page. Follow it while still satisfying the complete authoritative editInstruction."]
      : []),
    ...(options.characterContext
      ? ["characterContext is supplemental canon for character identity, traits, and appearance. Use it when writing a replacement, but do not treat it as an additional requested edit."]
      : []),
    "Each patch's find is copied verbatim from pageMarkdown — the same characters, spacing, punctuation and line breaks — occurs exactly once on the page, and is as short as the change allows while staying unique. replace is the text that takes its place; an empty replace deletes it.",
    "Change only what editInstruction asks. Every sentence, heading, list, code block and figure the instruction does not cover stays exactly as it is: do not freshen wording, examples, openings or transitions, and do not add material the instruction did not ask for.",
    "A fenced code block is replaced whole: find is the complete block from its opening fence line to its closing fence line, and replace is the complete new block with its own fences.",
    "Use outcome unchanged with an empty patches list when nothing on this page is covered by the instruction, and say why in reason. Use outcome whole_page with an empty patches list only when the instruction cannot be carried out by local replacements because it asks to restructure, re-plot, lengthen, shorten or rewrite the page's argument as a whole.",
    "Set summary only when the change alters what the stored summary says; otherwise omit it.",
    ...(options.adherenceRepair?.length
      ? ["adherenceRepair lists what a previous attempt at this edit left unmet. Perform every item on this page where it applies."]
      : []),
    ...(options.patchRepair?.length
      ? ["patchRepair lists patches from your previous reply that could not be applied: not_found means the find was not copied verbatim from pageMarkdown, ambiguous means it occurs more than once and needs more surrounding text. Return the complete corrected patch list."]
      : []),
    GROUNDED_FACTUALITY_RULE,
    "Do not mention the edit, AI, prompts, JSON, schemas, generation, or production instructions in any replacement text.",
    ...targetLanguageGenerationGuidance(options.input.language),
    ...writerToneRules(options.input),
    ...codeBlockRules(options.input, options.plan),
    "Return exactly one JSON object with the top-level keys outcome (patched, unchanged or whole_page), reason (string), patches (array of objects with find and replace) and optionally summary, shaped like outputContract, and no other keys."
  ].join(" ");
  const language = targetLanguagePayload(options.input.language);
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: JSON.stringify(
        {
          ...(language ? { language } : {}),
          editInstruction: options.editInstruction,
          ...(options.pageEditGuidance ? { pageEditGuidance: options.pageEditGuidance } : {}),
          ...(options.characterContext ? { characterContext: options.characterContext } : {}),
          ...(options.adherenceRepair?.length ? { adherenceRepair: [...options.adherenceRepair] } : {}),
          ...(options.patchRepair?.length
            ? { patchRepair: options.patchRepair.map((failure) => ({ find: failure.find, reason: failure.reason })) }
            : {}),
          book: {
            title: options.plan.title,
            premise: options.plan.premise,
            audience: options.plan.audience,
            category: options.input.category,
            subcategory: options.input.subcategory
          },
          pageIndex: options.page.index,
          pageTitle: options.page.title,
          pageSummary: options.page.summary,
          pageMarkdown: options.page.markdown,
          outputContract: PAGE_PATCH_OUTPUT_CONTRACT
        },
        null,
        2
      )
    }
  ];
}

/**
 * The reply echoes every replaced span once (`find`) and writes its
 * replacement, so the budget follows the page: one token per character, the
 * same worst case the adherence review sizes against for non-Latin scripts,
 * plus room for the frame. Floored so a short page can still return a long
 * code block, capped so a runaway reply cannot spend a whole draft's budget.
 */
export function pagePatchMaxTokens(markdown: string): number {
  return Math.min(12_000, Math.max(2_400, 1_200 + markdown.length));
}

/** How the model's reply is read: a patched outcome with no patches is an unchanged page. */
export function pagePatchDecision(
  response: PagePatchResponse
): { kind: "patched"; patches: PagePatch[]; summary: string | null } | { kind: "unchanged" | "whole_page"; reason: string } {
  const reason = response.reason || (response.outcome === "whole_page" ? "The model asked for a whole-page rewrite." : "Nothing on this page is covered by the instruction.");
  if (response.outcome !== "patched") {
    return { kind: response.outcome, reason };
  }
  const patches = response.patches.filter((patch) => patch.find !== patch.replace);
  if (patches.length === 0) {
    return { kind: "unchanged", reason: response.reason || "The model returned no replacements." };
  }
  return { kind: "patched", patches, summary: response.summary ?? null };
}
