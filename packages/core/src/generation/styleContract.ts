import { createHash } from "node:crypto";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { isBookCategory } from "../categories.js";
import {
  isWritingMode,
  MAX_DISTRIBUTION_STYLE_RULES,
  MAX_LOCAL_STYLE_RULES,
  parseStyleContract,
  type StyleContract,
  type StyleRule,
  type WritingMode
} from "../schemas/styleContract.js";
import { foldCharacterName } from "./libraryCharacters.js";

export type { StyleContract, StyleRule, WritingMode } from "../schemas/styleContract.js";
export {
  MAX_DISTRIBUTION_STYLE_RULES,
  MAX_LOCAL_STYLE_RULES,
  MAX_STYLE_RULE_INSTRUCTION_LENGTH,
  WRITING_MODES,
  styleContractSchema,
  styleRuleSchema,
  truncateStyleRuleText
} from "../schemas/styleContract.js";

export const STYLE_CONTRACT_VERSION = "style-contract-v1";

export const REQUIRED_LOCAL_RULE_IDS = [
  "no-proof-leap",
  "no-invented-evidence",
  "no-generic-conclusion",
  "uncertainty-where-earned",
  "prompt-leak-ban"
] as const;

export const REQUIRED_ANALYTICAL_DISTRIBUTION_IDS = [
  "vary-caveat-endings",
  "select-relevant-lens",
  "allow-bounded-conclusions",
  "reintroduce-only-when-advancing"
] as const;

const REQUIRED_LOCAL_RULES: StyleRule[] = [
  {
    id: "no-proof-leap",
    instruction:
      "Avoid unsupported proof-leap transitions; do not jump from a local fact to a sweeping conclusion without evidence on this page."
  },
  {
    id: "no-invented-evidence",
    instruction: "Do not invent evidence, citations, studies, experts, or source identities."
  },
  {
    id: "no-generic-conclusion",
    instruction: "Avoid generic conclusions and visible prompt scaffolding in reader-facing prose."
  },
  {
    id: "uncertainty-where-earned",
    instruction: "Use uncertainty only where the evidence on this page requires it."
  },
  {
    id: "prompt-leak-ban",
    instruction:
      "Do not mention AI, prompts, plans, JSON, schemas, generation, or production instructions in reader-facing pages."
  }
];

const ANALYTICAL_DISTRIBUTION_RULES: StyleRule[] = [
  {
    id: "vary-caveat-endings",
    instruction:
      "Do not use the same caveat construction as the default ending across chapters."
  },
  {
    id: "select-relevant-lens",
    instruction:
      "Choose only the analytical lens relevant to a page rather than repeating the complete comparison grid."
  },
  {
    id: "allow-bounded-conclusions",
    instruction:
      "Let some pages commit to a bounded conclusion instead of balancing every cause symmetrically."
  },
  {
    id: "reintroduce-only-when-advancing",
    instruction:
      "Reintroduce a concept only when the later treatment advances, challenges, or applies it."
  }
];

const INSTRUCTIONAL_DISTRIBUTION_RULES: StyleRule[] = [
  {
    id: "terminology-may-repeat",
    instruction:
      "Repeated technical terminology is legitimate in instructional books; do not recast a defined term for variety."
  },
  {
    id: "vary-worked-examples",
    instruction:
      "When a method recurs, change the worked example, constraint, or failure mode rather than restating the same demonstration."
  }
];

const NARRATIVE_DISTRIBUTION_RULES: StyleRule[] = [
  {
    id: "motif-may-return",
    instruction:
      "A motif or refrain may return when the later occurrence advances, complicates, or pays it off."
  },
  {
    id: "no-identical-scene-replay",
    instruction: "Do not restage an earlier scene with only wording changed."
  }
];

const REFERENCE_DISTRIBUTION_RULES: StyleRule[] = [
  {
    id: "entry-terms-may-repeat",
    instruction: "Reference entries may reuse canonical names and glosses; that is not duplicate treatment."
  }
];

const CHILDREN_DISTRIBUTION_RULES: StyleRule[] = [
  {
    id: "intentional-phrase-repeat",
    instruction:
      "A small repeated phrase is allowed when it is an intentional refrain, not a copied scene."
  }
];

const ANALYTICAL_CATEGORY = new Set(["HISTORY", "BIOGRAPHY", "SOCIETY", "SCIENCE"]);
const INSTRUCTIONAL_CATEGORY = new Set(["EDUCATION", "SELF_HELP", "BUSINESS", "HEALTH"]);

const ANALYTICAL_CUE =
  /\b(histor(?:y|ical)|civilization|era|dynasty|archaeolog\w*|compare|analy(?:[sz]\w*|tic\w*)|survey of|across (?:regions?|eras?|centuries))\b/i;
const INSTRUCTIONAL_CUE = /\b(how to|step[- ]by[- ]step|guide to|workbook|exercises?|lesson)\b/i;
const REFERENCE_CUE = /\b(encyclop(?:a)?edia|glossary|dictionary|gazetteer|companion to)\b/i;

const REPETITIVE_GLOBAL_GUIDANCE =
  /\b(?:ask the same questions|always distinguish the same|reiterate interacting possibilities|same (?:questions|categories|framework) (?:throughout|for every|in every|on every))\b/i;

export const USER_PARALLEL_INTENT =
  /\b(?:same (?:questions|framework|structure) (?:throughout|for every)|deliberate parallel|repeat the same questions)\b/i;

export const PLANNER_STYLE_CONTRACT_GUIDANCE = [
  "Do not instruct every page to ask the same questions, distinguish the same categories, reiterate the same possibilities, or apply the same framework to every era or region.",
  "Put page-local bans (invented evidence, prompt leaks, generic conclusions, unearned hedges) in antiAiRules.",
  "If you emit styleContract, localRules reach page drafts and page review; distributionRules reach manuscript review only and must not be copied onto every page prompt."
];

export type StyleContractSource = {
  input?: CreateProjectInput | undefined;
  userPrompt?: string | undefined;
};

export function inferWritingMode(
  input: CreateProjectInput | undefined,
  plan?: Pick<BookPlan, "title" | "premise" | "audience">
): WritingMode {
  const category = input?.category;
  const text = [input?.prompt, plan?.title, plan?.premise, plan?.audience].filter(Boolean).join(" ");
  if (category === "KIDS") {
    return "children-narrative";
  }
  if (REFERENCE_CUE.test(text)) {
    return "reference";
  }
  if (category && ANALYTICAL_CATEGORY.has(category)) {
    return INSTRUCTIONAL_CUE.test(text) && category === "SCIENCE" ? "instructional" : "analytical-history";
  }
  if (category && INSTRUCTIONAL_CATEGORY.has(category)) {
    return "instructional";
  }
  if (category === "STORY" || category === "ARTS") {
    return "narrative";
  }
  if (category === "CUSTOM" || !category || (typeof category === "string" && !isBookCategory(category))) {
    if (ANALYTICAL_CUE.test(text)) {
      return "analytical-history";
    }
    if (INSTRUCTIONAL_CUE.test(text)) {
      return "instructional";
    }
    if (REFERENCE_CUE.test(text)) {
      return "reference";
    }
    return "narrative";
  }
  return "narrative";
}

export function requiredStyleRulesFor(mode: WritingMode): StyleContract {
  return {
    localRules: REQUIRED_LOCAL_RULES.map(cloneRule),
    distributionRules: distributionRulesFor(mode).map(cloneRule)
  };
}

function distributionRulesFor(mode: WritingMode): StyleRule[] {
  if (mode === "analytical-history") {
    return ANALYTICAL_DISTRIBUTION_RULES;
  }
  if (mode === "instructional") {
    return INSTRUCTIONAL_DISTRIBUTION_RULES;
  }
  if (mode === "reference") {
    return REFERENCE_DISTRIBUTION_RULES;
  }
  if (mode === "children-narrative") {
    return CHILDREN_DISTRIBUTION_RULES;
  }
  return NARRATIVE_DISTRIBUTION_RULES;
}

/**
 * Required rules merge by `id`. A planner list that already has six arbitrary
 * anti-AI lines cannot suppress mandatory factuality or prompt-leak protections
 * merely by exceeding a count. Optional house preferences yield to explicit
 * user intent; required protections do not.
 */
export function applyPlanStyleContract(plan: BookPlan, options: StyleContractSource = {}): BookPlan {
  const writingMode = isWritingMode(plan.writingMode)
    ? plan.writingMode
    : inferWritingMode(options.input, plan);
  const required = requiredStyleRulesFor(writingMode);
  const incoming = incomingStyleRules(plan);
  const userPrompt = options.userPrompt ?? options.input?.prompt;
  const merged = relocateRepetitiveLocalRules(
    finalizeRuleList(
      mergeStyleRulesById(required.localRules, incoming.localRules, MAX_LOCAL_STYLE_RULES),
      required.localRules,
      userPrompt,
      "local"
    ),
    finalizeRuleList(
      mergeStyleRulesById(
        required.distributionRules,
        incoming.distributionRules,
        MAX_DISTRIBUTION_STYLE_RULES
      ),
      required.distributionRules,
      userPrompt,
      "distribution"
    ),
    required.localRules,
    userPrompt
  );
  const antiAiRules = merged.localRules.map((rule) => rule.instruction);
  if (
    plan.writingMode === writingMode &&
    styleContractEquals(plan.styleContract, merged) &&
    sameInstructionList(plan.antiAiRules ?? [], antiAiRules)
  ) {
    return plan;
  }
  return {
    ...plan,
    writingMode,
    styleContract: merged,
    antiAiRules
  };
}

export function resolveStyleContract(plan: BookPlan, options: StyleContractSource = {}): StyleContract {
  return applyPlanStyleContract(plan, options).styleContract ?? { localRules: [], distributionRules: [] };
}

export function localStyleInstructions(plan: BookPlan): string[] {
  return resolveStyleContract(plan).localRules.map((rule) => rule.instruction);
}

export function distributionStyleInstructions(plan: BookPlan): string[] {
  return manuscriptPromptStyleFields(plan).distributionRules;
}

/** Page drafts and page review: local rules only. */
export function pagePromptBookStyle(plan: BookPlan): { voiceGuide: string[]; antiAiRules: string[] } {
  return {
    voiceGuide: plan.voiceGuide,
    antiAiRules: localStyleInstructions(plan)
  };
}

/**
 * Manuscript structural model review: distribution rules only.
 *
 * Plan-time `applyPlanStyleContract` already rewrote or preserved optional
 * distribution wording (including USER_PARALLEL_INTENT). Re-applying that
 * rewrite here without the user prompt would turn a stored "Ask the same
 * questions throughout…" line into the chapter-scoped house rewrite. Read
 * stored `distributionRules` when they exist; only a legacy plan with no
 * stored contract still goes through apply.
 */
export function manuscriptPromptStyleFields(plan: BookPlan): {
  distributionRules: string[];
  writingMode?: WritingMode;
} {
  const stored = parseStyleContract(plan.styleContract);
  if (stored && stored.distributionRules.length > 0) {
    const writingMode = isWritingMode(plan.writingMode)
      ? plan.writingMode
      : inferWritingMode(undefined, plan);
    const required = requiredStyleRulesFor(writingMode);
    return {
      distributionRules: mergeStyleRulesById(
        required.distributionRules,
        stored.distributionRules,
        MAX_DISTRIBUTION_STYLE_RULES
      ).map((rule) => rule.instruction),
      ...(writingMode ? { writingMode } : {})
    };
  }
  const resolved = applyPlanStyleContract(plan);
  return {
    distributionRules: (resolved.styleContract?.distributionRules ?? []).map((rule) => rule.instruction),
    ...(resolved.writingMode ? { writingMode: resolved.writingMode } : {})
  };
}

export function isRepetitiveGlobalGuidance(instruction: string): boolean {
  return REPETITIVE_GLOBAL_GUIDANCE.test(instruction);
}

export function matchesUserParallelIntent(text: string | undefined): boolean {
  return Boolean(text && USER_PARALLEL_INTENT.test(text));
}

export function rewriteRepetitiveStyleInstruction(instruction: string, userPrompt?: string): string {
  if (matchesUserParallelIntent(userPrompt) && isRepetitiveGlobalGuidance(instruction)) {
    return instruction;
  }
  if (!isRepetitiveGlobalGuidance(instruction)) {
    return instruction;
  }
  return (
    "Use this analytical move only in the chapter where it is assigned; do not repeat the same questions, categories, or framework on every page."
  );
}

function incomingStyleRules(plan: BookPlan): StyleContract {
  const classified = classifyAntiAiRules(plan.antiAiRules ?? []);
  const stored = parseStyleContract(plan.styleContract);
  if (!stored || (stored.localRules.length === 0 && stored.distributionRules.length === 0)) {
    return classified;
  }
  return mergeClassifiedRulesIntoStored(stored, classified);
}

function classifyAntiAiRules(antiAiRules: string[]): StyleContract {
  const classified: StyleContract = { localRules: [], distributionRules: [] };
  const seen = new Set<string>();
  for (const instruction of antiAiRules) {
    const trimmed = instruction.trim();
    if (!trimmed) {
      continue;
    }
    const id = slugRuleId(trimmed);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const rule = { id, instruction: trimmed };
    if (isRepetitiveGlobalGuidance(trimmed) || looksDistributional(trimmed)) {
      classified.distributionRules.push(rule);
    } else {
      classified.localRules.push(rule);
    }
  }
  return classified;
}

/**
 * Classified `antiAiRules` extras merge by `id` onto the stored contract.
 * Instructions already present on either list keep their stored ids; they are
 * not re-slugged as duplicates. Planner `distributionRules` that are absent
 * from `antiAiRules` stay on the contract.
 */
function mergeClassifiedRulesIntoStored(stored: StyleContract, classified: StyleContract): StyleContract {
  const knownInstructions = new Set(
    [...stored.localRules, ...stored.distributionRules].map((rule) => rule.instruction.trim().toLowerCase())
  );
  return {
    localRules: mergeStyleRulesById(
      stored.localRules,
      classified.localRules.filter((rule) => !knownInstructions.has(rule.instruction.trim().toLowerCase())),
      MAX_LOCAL_STYLE_RULES
    ),
    distributionRules: mergeStyleRulesById(
      stored.distributionRules,
      classified.distributionRules.filter(
        (rule) => !knownInstructions.has(rule.instruction.trim().toLowerCase())
      ),
      MAX_DISTRIBUTION_STYLE_RULES
    )
  };
}

function relocateRepetitiveLocalRules(
  localRules: StyleRule[],
  distributionRules: StyleRule[],
  requiredLocal: StyleRule[],
  userPrompt: string | undefined
): StyleContract {
  const requiredLocalIds = new Set(requiredLocal.map((rule) => rule.id));
  const local: StyleRule[] = [];
  const moved: StyleRule[] = [];
  for (const rule of localRules) {
    if (
      !requiredLocalIds.has(rule.id) &&
      (isRepetitiveGlobalGuidance(rule.instruction) || looksDistributional(rule.instruction))
    ) {
      moved.push({
        ...rule,
        instruction: rewriteRepetitiveStyleInstruction(rule.instruction, userPrompt)
      });
    } else {
      local.push(rule);
    }
  }
  return {
    localRules: local,
    distributionRules: mergeStyleRulesById(distributionRules, moved, MAX_DISTRIBUTION_STYLE_RULES)
  };
}

function looksDistributional(instruction: string): boolean {
  return (
    /\b(?:across chapters|across every chapter|manuscript[- ]wide|comparison grid|same caveat|same ending)\b/i.test(
      instruction
    )
  );
}

/**
 * Incoming extras keep their order. Required ids overlay in place (wording cannot
 * be weakened) and any missing required ids are appended. Optional extras that
 * would push the list past `max` are dropped so the contract still parses;
 * required ids are never dropped.
 */
export function mergeStyleRulesById(required: StyleRule[], incoming: StyleRule[], max: number): StyleRule[] {
  const requiredById = new Map(required.map((rule) => [rule.id, cloneRule(rule)]));
  const seen = new Set<string>();
  const merged: StyleRule[] = [];
  for (const rule of incoming) {
    const id = rule.id.trim();
    const instruction = rule.instruction.trim();
    if (!id || !instruction || seen.has(id)) {
      continue;
    }
    seen.add(id);
    merged.push(requiredById.get(id) ?? { id, instruction });
  }
  for (const rule of required) {
    if (seen.has(rule.id)) {
      continue;
    }
    seen.add(rule.id);
    merged.push(cloneRule(rule));
  }
  return capMergedStyleRules(merged, requiredById, max);
}

function capMergedStyleRules(
  merged: StyleRule[],
  requiredById: Map<string, StyleRule>,
  max: number
): StyleRule[] {
  if (!Number.isFinite(max) || merged.length <= max) {
    return merged;
  }
  const requiredCount = merged.reduce((count, rule) => count + (requiredById.has(rule.id) ? 1 : 0), 0);
  let optionalSlots = Math.max(0, max - requiredCount);
  const capped: StyleRule[] = [];
  for (const rule of merged) {
    if (requiredById.has(rule.id)) {
      capped.push(rule);
      continue;
    }
    if (optionalSlots === 0) {
      continue;
    }
    optionalSlots -= 1;
    capped.push(rule);
  }
  return capped;
}

function finalizeRuleList(
  merged: StyleRule[],
  required: StyleRule[],
  userPrompt: string | undefined,
  kind: "local" | "distribution"
): StyleRule[] {
  const requiredIds = new Set(required.map((rule) => rule.id));
  const rewritten = merged.map((rule) => {
    if (requiredIds.has(rule.id)) {
      return cloneRule(rule);
    }
    if (kind === "distribution" || isRepetitiveGlobalGuidance(rule.instruction)) {
      return { ...rule, instruction: rewriteRepetitiveStyleInstruction(rule.instruction, userPrompt) };
    }
    return rule;
  });
  return mergeStyleRulesById(
    required,
    rewritten,
    kind === "local" ? MAX_LOCAL_STYLE_RULES : MAX_DISTRIBUTION_STYLE_RULES
  );
}

/**
 * Stable id for a planner anti-AI line. ASCII instructions keep a readable slug
 * so required English ids still merge. A line whose slug is empty — Persian,
 * Arabic, CJK — used to become the literal `"planner-rule"`, and `seen.has(id)`
 * then kept only the first. The fallback is the same as `characterSlug`: hash
 * the folded form so equivalent spellings share an id and distinct house rules
 * do not share `"planner-rule"`.
 */
function slugRuleId(instruction: string): string {
  const slug = instruction
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (slug) {
    return slug;
  }
  return `planner-rule-${createHash("sha256").update(foldCharacterName(instruction)).digest("hex").slice(0, 10)}`;
}

function cloneRule(rule: StyleRule): StyleRule {
  return { id: rule.id, instruction: rule.instruction };
}

function styleContractEquals(left: StyleContract | undefined, right: StyleContract): boolean {
  if (!left) {
    return false;
  }
  return (
    sameRuleList(left.localRules, right.localRules) &&
    sameRuleList(left.distributionRules, right.distributionRules)
  );
}

function sameRuleList(left: StyleRule[], right: StyleRule[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((rule, index) => rule.id === right[index]?.id && rule.instruction === right[index]?.instruction);
}

function sameInstructionList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((instruction, index) => instruction === right[index]);
}
