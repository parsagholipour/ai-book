import { z } from "zod";
import { isRecord } from "./jsonCoercion.js";

export const WRITING_MODES = [
  "narrative",
  "analytical-history",
  "instructional",
  "reference",
  "children-narrative"
] as const;

export type WritingMode = (typeof WRITING_MODES)[number];

/** Same bound `antiAiRules` / `voiceGuide` use in `plan.ts`. */
export const MAX_STYLE_RULE_INSTRUCTION_LENGTH = 500;

/**
 * A UTF-16 slice is not a truncation. `.slice(0, 500)` cuts an emoji that
 * straddles index 500 in half, and the lone high surrogate left behind is a
 * legal JS string that `JSON.stringify` writes as `\ud83d` — which Postgres
 * `jsonb` **rejects**. Counting code points instead can never split a pair.
 *
 * A surrogate the model itself sent unpaired is dropped for the same reason:
 * `JSON.parse("\"\\ud83d\"")` hands one straight through, and nothing
 * downstream can store it however it got here.
 *
 * `z.string().max(500)` is UTF-16, so a 500-code-point emoji line that is
 * legal on `antiAiRules` used to fail this schema and take the whole contract
 * with it. Truncate / measure code points here too.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function truncateStyleRuleText(
  value: string,
  maxLength = MAX_STYLE_RULE_INSTRUCTION_LENGTH
): string {
  const storable = value.replace(LONE_SURROGATE, "");
  const characters = [...storable];
  return characters.length > maxLength ? characters.slice(0, maxLength).join("") : storable;
}

const styleRuleInstructionSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  return truncateStyleRuleText(value.trim());
}, z.string().min(1));

export const styleRuleSchema = z.object({
  id: z.string().trim().min(1).max(80),
  instruction: styleRuleInstructionSchema
});

export type StyleRule = z.infer<typeof styleRuleSchema>;

/** Page-local contract cap. Matches the plan `antiAiRules` list bound; required ids always fit. */
export const MAX_LOCAL_STYLE_RULES = 24;
/** Manuscript-distribution contract cap. */
export const MAX_DISTRIBUTION_STYLE_RULES = 12;

/**
 * Same policy as plan `antiAiRules`: a lone non-empty string is a one-item list
 * of that instruction, not a missing field. A string *in* an array of objects
 * is still dropped as an invalid entry.
 */
function styleRuleFromInstruction(value: string): StyleRule | undefined {
  const instruction = truncateStyleRuleText(value.trim());
  if (!instruction) {
    return undefined;
  }
  const id =
    instruction
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "planner-rule";
  const parsed = styleRuleSchema.safeParse({ id, instruction });
  return parsed.success ? parsed.data : undefined;
}

function coerceStyleRuleListItems(value: unknown): unknown[] {
  if (typeof value === "string") {
    const rule = styleRuleFromInstruction(value);
    return rule ? [rule] : [];
  }
  return Array.isArray(value) ? value : [];
}

function parseStyleRuleList(value: unknown, max: number): StyleRule[] {
  const kept: StyleRule[] = [];
  for (const item of coerceStyleRuleListItems(value)) {
    const parsed = styleRuleSchema.safeParse(item);
    if (!parsed.success) {
      continue;
    }
    kept.push(parsed.data);
    if (kept.length >= max) {
      break;
    }
  }
  return kept;
}

/**
 * A too-long list used to fail the whole object, and `parseStyleContract` then
 * dropped planner `distributionRules` with it. Truncate to the cap instead.
 * One invalid *entry* used to do the same — drop that rule, keep the rest.
 */
function styleRuleListSchema(max: number) {
  return z.preprocess((value) => {
    if (value === undefined) {
      return [];
    }
    return parseStyleRuleList(value, max);
  }, z.array(styleRuleSchema).max(max));
}

export const styleContractSchema = z.object({
  localRules: styleRuleListSchema(MAX_LOCAL_STYLE_RULES),
  distributionRules: styleRuleListSchema(MAX_DISTRIBUTION_STYLE_RULES)
});

export type StyleContract = z.infer<typeof styleContractSchema>;

const WRITING_MODE_SET = new Set<string>(WRITING_MODES);

export function isWritingMode(value: unknown): value is WritingMode {
  return typeof value === "string" && WRITING_MODE_SET.has(value);
}

function restoreStyleRuleList(
  value: unknown,
  fallback: readonly StyleRule[] | undefined,
  max: number
): StyleRule[] {
  const cleaned = parseStyleRuleList(value, max);
  if (cleaned.length > 0) {
    return cleaned;
  }
  return fallback ? [...fallback] : [];
}

function parsedStyleContract(value: unknown): StyleContract | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const localRules = parseStyleRuleList(value.localRules, MAX_LOCAL_STYLE_RULES);
  const distributionRules = parseStyleRuleList(value.distributionRules, MAX_DISTRIBUTION_STYLE_RULES);
  if (localRules.length === 0 && distributionRules.length === 0) {
    return undefined;
  }
  return { localRules, distributionRules };
}

/**
 * `fallback` is the current plan of a revision, matching `antiAiRules`: a list
 * that cleans to nothing is omitted, not a wipe. A lone valid instruction
 * string becomes a one-item list and does replace the stored rules.
 */
export function parseStyleContract(value: unknown, fallback?: unknown): StyleContract | undefined {
  const fallbackContract = parsedStyleContract(fallback);
  if (!isRecord(value)) {
    return fallbackContract;
  }
  const localRules = restoreStyleRuleList(value.localRules, fallbackContract?.localRules, MAX_LOCAL_STYLE_RULES);
  const distributionRules = restoreStyleRuleList(
    value.distributionRules,
    fallbackContract?.distributionRules,
    MAX_DISTRIBUTION_STYLE_RULES
  );
  if (localRules.length === 0 && distributionRules.length === 0) {
    return undefined;
  }
  return { localRules, distributionRules };
}
