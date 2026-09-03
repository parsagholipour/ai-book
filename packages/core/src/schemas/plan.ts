import { z } from "zod";
import {
  booleanField,
  coerceStringArray,
  isRecord,
  recordField,
  stringArrayField,
  stringField,
  unwrapJsonObject
} from "./jsonCoercion.js";
import { bookArcSchema } from "./bookArc.js";
import { illustrationCadenceSchema } from "./mediaSettings.js";
import {
  isWritingMode,
  parseStyleContract,
  styleContractSchema,
  truncateStyleRuleText,
  WRITING_MODES
} from "./styleContract.js";

/**
 * The plan tree: bookPlanSchema and every schema it is assembled from,
 * including planQuestionSchema (the question surface CLAUDE.md documents).
 * Split out of book.ts; book.ts re-exports everything here.
 */

const PLAN_WRAPPER_KEYS = ["plan", "bookPlan", "planningPackage", "outline", "data", "result"] as const;
const PLANNER_RECOVERY_WRAPPER_KEYS = [...PLAN_WRAPPER_KEYS, "generationPlan"] as const;

function isPlanLikeRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (typeof value.title === "string" ||
      typeof value.premise === "string" ||
      typeof value.audience === "string" ||
      Array.isArray(value.chapters) ||
      isRecord(value.illustrationPlan))
  );
}

/**
 * The plan fields a model is allowed to misspell, canonical spelling first —
 * the same order `normalizeBookPlan` reads them in, because these lists *are*
 * that lookup.
 *
 * The lookup runs at the end of the pipeline, over a record a revision has
 * already been merged onto. The fallback is a parsed plan, so it always carries
 * the canonical spelling: `{ opening_hook: "<new>" }` merged onto
 * `{ openingHook: "<old>" }` leaves both keys standing, and a first-match lookup
 * answers with the stale one — the reader asks for a new opening and the book
 * keeps opening on the old. So a candidate's aliases are promoted to their
 * canonical spelling *before* the merge. An alias is how the model spelled the
 * field, never a weaker claim on it.
 *
 * `accepts` is what keeps that promotion from making things worse. Only a value
 * the schema can actually use displaces the fallback; a hook emitted as an
 * object, or a reading level of "grade 5", is not an answer, and letting it
 * through would trade a preserved field for a revision that no longer parses.
 * The test is on the *value*, not on the spelling, so it governs the canonical
 * key too — a revision that spelt `writingComplexity` correctly and answered it
 * "grade 5" was still overwriting the fallback's number, and since that field is
 * required the whole revision then lost its parse. A key whose value
 * is refused is dropped from the candidate, so the merge sees no answer there
 * and the fallback's value stands.
 */
const WRITING_COMPLEXITY_KEYS = [
  "writingComplexity",
  "complexity",
  "writing_complexity",
  "writingLevel",
  "readingLevel"
] as const;
const OPENING_HOOK_KEYS = ["openingHook", "opening_hook", "hook"] as const;
const AUTHOR_STANCE_KEYS = ["authorStance", "author_stance", "stance"] as const;

/**
 * The author the composed-chapters strategy writes as: what the book argues,
 * the stands it takes, the habits it refuses, and a voice sample written as
 * that author on a subject outside the book. See
 * `generation/authorStance.ts`. Optional: the planner is asked for it, a plan
 * without one has it generated at composition time, and a malformed answer
 * degrades to "no stance" rather than failing the plan parse.
 */
const authorStanceObjectSchema = z.object({
  thesis: z.string().min(1),
  positions: z.array(z.string()).default([]),
  refusals: z.array(z.string()).default([]),
  voiceSample: z.string().min(1)
});
/**
 * Tolerant on purpose: the planner was asked for positions "each naming what
 * the author believes and the strongest rival view they reject", and the first
 * live plan answered with `{ believes, rejects }` objects — which a string-only
 * array silently dropped, so the book was composed with no positions at all.
 * A stance the model spelled as objects, or under an alias, is read; one with
 * no thesis or no voice sample is no stance.
 */
export const authorStanceSchema = z.preprocess(
  (value) => normalizeAuthorStance(value) ?? value,
  authorStanceObjectSchema
);
export type AuthorStance = z.infer<typeof authorStanceObjectSchema>;

/** A stance line the model spelled as an object: its string fields joined, the rival view labelled. */
function stanceLine(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  // The view the author holds, and only that. A planner that answered
  // `{belief, rejects}` objects had `belief` missing from this list, so the
  // fallback handed the writer the *rejected* views as its positions and one
  // whole book was written rebutting them (composed-6).
  const believes = stringField(value, [
    "belief",
    "believes",
    "holds",
    "assertion",
    "position",
    "claim",
    "stand",
    "text",
    "statement",
    "habit",
    "refusal"
  ])?.trim();
  if (believes) {
    return believes;
  }
  const rejectedKeys = new Set(["rejects", "against", "rival", "rejectedview", "rejected_view", "alternative", "reason", "why"]);
  const strings = Object.entries(value)
    .filter(([key, entry]) => !rejectedKeys.has(key.toLowerCase()) && typeof entry === "string" && entry.trim().length > 0)
    .map(([, entry]) => (entry as string).trim());
  return strings.length > 0 ? strings.join(" ") : undefined;
}

function stanceLines(value: unknown): string[] {
  if (typeof value === "string") {
    return cleanStyleRules(value);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of value) {
    const line = stanceLine(entry);
    if (line && !seen.has(line.toLowerCase())) {
      seen.add(line.toLowerCase());
      lines.push(line);
    }
  }
  return lines;
}

function normalizeAuthorStance(value: unknown): AuthorStance | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const thesis = stringField(value, ["thesis", "argument", "spine"])?.trim();
  const voiceSample = stringField(value, ["voiceSample", "voice_sample", "sample", "voice"])?.trim();
  if (!thesis || !voiceSample) {
    return undefined;
  }
  return {
    thesis,
    positions: stanceLines(firstPresentField(value, ["positions", "stands", "claims"])),
    refusals: stanceLines(firstPresentField(value, ["refusals", "refuses", "avoids"])),
    voiceSample
  };
}

type PlanAliasedField = {
  readonly keys: readonly [string, ...string[]];
  readonly accepts: (value: unknown) => boolean;
};

/**
 * The level field, spelled once. `accepts` refusing a value the object schema
 * would have taken is the same bug in the other direction — the answer is
 * dropped and a required field goes missing — so the predicate must be this
 * schema itself, never a hand-written restatement of its range.
 */
const writingComplexitySchema = z.coerce.number().int().min(1).max(10);

const PLAN_ALIASED_FIELDS: readonly PlanAliasedField[] = [
  { keys: WRITING_COMPLEXITY_KEYS, accepts: (value) => writingComplexitySchema.safeParse(value).success },
  // A hook is stored trimmed, so a blank one is not a hook: every consumer gates
  // on truthiness, and promoting `""` cost the book its opening commitment.
  { keys: OPENING_HOOK_KEYS, accepts: (value) => typeof value === "string" && value.trim().length > 0 }
];

function canonicalizePlanAliases(candidate: Record<string, unknown>): Record<string, unknown> {
  let resolved: Record<string, unknown> | undefined;
  for (const { keys, accepts } of PLAN_ALIASED_FIELDS) {
    const [canonical] = keys;
    const answered = keys.find((key) => accepts(candidate[key]));
    const refused = keys.filter((key) => key in candidate && !accepts(candidate[key]));
    if (refused.length === 0 && (answered === undefined || answered === canonical)) {
      continue;
    }
    resolved ??= { ...candidate };
    for (const key of refused) {
      delete resolved[key];
    }
    if (answered !== undefined) {
      resolved[canonical] = candidate[answered];
    }
  }
  return resolved ?? candidate;
}

/** The first key carrying a value at all — the `??` chain, over one shared key list. */
function firstPresentField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function mergePlanRecords(
  fallback: Record<string, unknown> | undefined,
  candidate: Record<string, unknown>
): Record<string, unknown> {
  // Canonicalised here rather than after the merge: once the fallback's own
  // canonical keys have joined the record, they outrank the candidate's aliased
  // answer in every lookup downstream.
  const answered = canonicalizePlanAliases(candidate);
  return fallback ? mergeRecords(fallback, answered) : answered;
}

/** Plain recursive merge. Aliases are a top-level plan concern, so nesting does not repeat it. */
function mergeRecords(
  fallback: Record<string, unknown>,
  candidate: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...fallback };
  for (const [key, value] of Object.entries(candidate)) {
    if (value === undefined || value === null) {
      continue;
    }
    const fallbackValue = merged[key];
    // Plan revisions are patches. Objects may be emitted field-by-field, while
    // arrays are intentional atomic replacements (chapter order and question
    // deletion would otherwise be ambiguous).
    merged[key] = isRecord(fallbackValue) && isRecord(value)
      ? mergeRecords(fallbackValue, value)
      : value;
  }
  return merged;
}

/**
 * `.min(1)` on the schema checks array length, not content, so a planner that
 * emitted `[""]` or `["Write naturally", "write naturally"]` used to satisfy it
 * — and because plan arrays replace atomically, that vacuous list displaced the
 * fallback contract and became the "Avoid:" line of every draft and review
 * prompt in the book. Cleanup here; the quality floor that appends real rules
 * back is `ensurePlanStyleContract` in generation/planner.ts.
 */
const MAX_STYLE_RULES = 24;

const GENERIC_VOICE_GUIDE = ["Write in a natural, specific human voice suited to the book's audience."];
const GENERIC_ANTI_AI_RULES = [
  "Avoid formulaic AI rhetoric: stock transitions, proof-leap phrases, contrast-pair clichés, and inflated abstractions."
];

/** Whatever this parse already had to fall back on: the current plan of a revision, or an echoed outline. */
type PlanStyleSource = { voiceGuide?: unknown; antiAiRules?: unknown; styleContract?: unknown };

function cleanStyleRules(value: unknown): string[] {
  const coerced = coerceStringArray(value);
  const rules = Array.isArray(coerced) ? coerced : [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const rule of rules) {
    if (typeof rule !== "string") {
      continue;
    }
    // Code points, not UTF-16: see truncateStyleRuleText.
    const trimmed = truncateStyleRuleText(rule.trim());
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) {
      continue;
    }
    seen.add(key);
    cleaned.push(trimmed);
    if (cleaned.length >= MAX_STYLE_RULES) {
      break;
    }
  }
  return cleaned;
}

/**
 * An emitted `[]` is not an omitted field, but `mergePlanRecords` skips only
 * undefined and null — so an empty array arrives here having already replaced
 * the plan it was patching. It used to fail `.min(1)` and the revision was
 * repaired or rejected; substituting the generic pair instead would let "make it
 * shorter" trade a book's whole voice contract for one line of boilerplate. So a
 * list that cleans down to nothing means "not provided": restore what this parse
 * was falling back on — the current plan on a revision, the template outline on
 * initial planning. The generic pair is the last resort, for a parse with no
 * fallback at all, because a stored plan whose arrays clean down to nothing must
 * stay readable or the book it describes cannot be compiled, revised, or
 * continued.
 */
function cleanStyleRuleArray(value: unknown, fallback: unknown, generic: string[]): string[] {
  const cleaned = cleanStyleRules(value);
  if (cleaned.length > 0) {
    return cleaned;
  }
  const restored = cleanStyleRules(fallback);
  return restored.length > 0 ? restored : [...generic];
}

function normalizePlanScalarArrays(
  value: Record<string, unknown>,
  fallback: PlanStyleSource | undefined
): Record<string, unknown> {
  return {
    ...value,
    voiceGuide: cleanStyleRuleArray(value.voiceGuide, fallback?.voiceGuide, GENERIC_VOICE_GUIDE),
    antiAiRules: cleanStyleRuleArray(value.antiAiRules, fallback?.antiAiRules, GENERIC_ANTI_AI_RULES)
  };
}

function normalizeBookPlan(value: unknown, fallback: PlanStyleSource | undefined): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const fallbackOutline = recordField(value, ["fallbackOutline", "fallbackPlan"]);
  const nestedPlan = recordField(value, [...PLAN_WRAPPER_KEYS]);
  const unwrapped = isPlanLikeRecord(value)
    ? value
    : isPlanLikeRecord(nestedPlan)
      ? mergePlanRecords(isPlanLikeRecord(fallbackOutline) ? fallbackOutline : undefined, nestedPlan)
    : isPlanLikeRecord(fallbackOutline)
      ? fallbackOutline
      : unwrapJsonObject([...PLAN_WRAPPER_KEYS])(value);
  if (!isRecord(unwrapped)) {
    return unwrapped;
  }

  const styleSource = fallback ?? fallbackOutline;
  return normalizeStyleContractFields(
    normalizePlanScalarArrays(
      {
        ...unwrapped,
        writingComplexity: firstPresentField(unwrapped, WRITING_COMPLEXITY_KEYS),
        // stringField rather than `??`: a model that answers the hook as an
        // object or array must degrade to "no hook", not fail the whole parse.
        // Trimmed like every other string this file normalizes, and a hook that
        // trims away is no hook at all.
        openingHook: stringField(unwrapped, [...OPENING_HOOK_KEYS])?.trim() || undefined,
        authorStance: normalizeAuthorStance(firstPresentField(unwrapped, AUTHOR_STANCE_KEYS))
      },
      styleSource
    ),
    styleSource
  );
}

function normalizeStyleContractFields(
  value: Record<string, unknown>,
  fallback: PlanStyleSource | undefined
): Record<string, unknown> {
  const writingMode = isWritingMode(value.writingMode) ? value.writingMode : undefined;
  const styleContract = parseStyleContract(value.styleContract, fallback?.styleContract);
  const next = { ...value };
  delete next.writingMode;
  delete next.styleContract;
  return {
    ...next,
    ...(writingMode ? { writingMode } : {}),
    ...(styleContract ? { styleContract } : {})
  };
}

function normalizeBookPlanWithFallback(fallback: BookPlan) {
  return (value: unknown): unknown => {
    if (!isRecord(value)) {
      return value;
    }

    const fallbackRecord = fallback as unknown as Record<string, unknown>;
    const outer = { ...value };
    const nestedPlan = recordField(value, [...PLANNER_RECOVERY_WRAPPER_KEYS]);
    for (const key of PLANNER_RECOVERY_WRAPPER_KEYS) {
      delete outer[key];
    }

    const candidate = isPlanLikeRecord(nestedPlan)
      ? mergePlanRecords(mergePlanRecords(fallbackRecord, outer), nestedPlan)
      : isPlanLikeRecord(value)
        ? mergePlanRecords(fallbackRecord, value)
        : mergePlanRecords(fallbackRecord, outer);

    return normalizeBookPlan(candidate, fallbackRecord);
  };
}

export const chapterPlanSchema = z.object({
  index: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  targetPages: z.number().int().positive(),
  keyBeats: z.array(z.string()).default([]),
  illustrationPrompts: z.array(z.string()).optional()
});

/**
 * The name is trimmed here because it is the *identity* of a plan character,
 * not a display string: a library character reaches a book by name, a reference
 * sheet is claimed by name, and a sheet's filename is derived from one. Every
 * one of those consumers trims the name it reads back out of storage, and none
 * of them could trim the plan's copy, so a planner name with a stray space was
 * a character no sheet and no refusal could ever answer for — which had every
 * illustrated page's image job redraw the whole cast (see
 * `characterReferenceNameKey` in the worker). Blank falls through to the
 * placeholder for the same reason `role` and `description` do: a nameless
 * character keys to nothing, and nothing is not an answer either.
 */
function normalizeCharacter(value: unknown): unknown {
  if (typeof value === "string" && value.trim()) {
    return {
      name: value.trim(),
      role: "Supporting character",
      description: "Recurring character in the plan.",
      traits: [],
      visualRules: []
    };
  }
  if (!isRecord(value)) {
    return value;
  }

  const role = stringField(value, [
    "role",
    "storyRole",
    "characterRole",
    "narrativeRole",
    "function",
    "archetype",
    "relationship"
  ]);
  const description = stringField(value, ["description", "summary", "bio", "profile", "backstory", "notes"]);

  return {
    ...value,
    name: stringField(value, ["name", "characterName", "fullName"])?.trim() || "Unnamed character",
    role: role?.trim() || "Supporting character",
    description: description?.trim() || "Recurring character in the plan.",
    traits: stringArrayField(value, ["traits", "personality", "personalityTraits", "qualities"]) ?? [],
    visualRules: stringArrayField(value, ["visualRules", "visual_rules", "appearance", "visualDescription", "visual", "design"]) ?? []
  };
}

export const characterSchema = z.preprocess(
  normalizeCharacter,
  z.object({
    name: z.string(),
    role: z.string(),
    description: z.string(),
    traits: z.array(z.string()).default([]),
    visualRules: z.array(z.string()).default([])
  })
);

export const locationSchema = z.object({
  name: z.string(),
  description: z.string(),
  rules: z.array(z.string()).default([])
});

export const illustrationPlanSchema = z.object({
  cadence: illustrationCadenceSchema,
  globalStyle: z.string(),
  coverPrompt: z.string().optional(),
  characterReferencePrompts: z.array(z.string()).default([]),
  pageRules: z.array(z.string()).default([])
});

function normalizeResearchSource(value: unknown): unknown {
  if (typeof value === "string") {
    return {
      query: "planner-note",
      title: "Planner research note",
      summary: value.trim()
    };
  }
  if (!isRecord(value)) {
    return value;
  }

  const query = stringField(value, ["query", "searchQuery", "topic"]);
  const title = stringField(value, ["title", "source", "name"]);
  const summary = stringField(value, ["summary", "note", "notes", "body", "description", "content", "text"]);
  const url = stringField(value, ["url", "link", "sourceUrl"]);
  const publishedAt = stringField(value, ["publishedAt", "published_at", "date"]);

  return {
    ...value,
    query: query?.trim() || "planner-note",
    title: title?.trim() || "Planner research note",
    url: url?.trim() || undefined,
    summary: summary?.trim() || title?.trim() || "",
    publishedAt: publishedAt?.trim() || undefined
  };
}

export const researchSourceSchema = z.preprocess(
  normalizeResearchSource,
  z.object({
    query: z.string(),
    title: z.string(),
    url: z.string().url().optional(),
    summary: z.string(),
    publishedAt: z.string().optional()
  })
);

/**
 * How many of the offered answers the reader may pick. A question the reader can
 * honestly answer with several options ("which of these themes?") used to arrive
 * as `choice`, so the app sent the first tap and dropped the rest; the model
 * worked around it by listing the options inside the prompt text and asking for
 * a typed answer. `multi` is that question declared honestly.
 *
 * Fewer than two options is `open` whatever the model says: one choice is not a
 * choice, so the reader types the value instead of tapping an invented answer.
 */
function planQuestionAnswerKind(value: Record<string, unknown>, options: string[]): "choice" | "multi" | "open" {
  if (options.length < 2) {
    return "open";
  }
  const declared = stringField(value, ["answerKind", "answerType"])?.trim().toLowerCase();
  const multiple = booleanField(value, ["multiSelect", "multiple", "allowMultiple", "selectMultiple"]);
  return multiple === true || declared === "multi" || declared === "multiple" ? "multi" : "choice";
}

export const planQuestionSchema = z.preprocess(
  (value) => {
    if (typeof value === "string") {
      return {
        prompt: value,
        options: [],
        answerKind: "open",
        allowCustom: true
      };
    }
    if (!isRecord(value)) {
      return value;
    }

    const options = stringArrayField(value, ["options", "suggestedAnswers", "answers", "choices", "premadeAnswers"]) ?? [];
    const answerKind = planQuestionAnswerKind(value, options);
    return {
      ...value,
      prompt: stringField(value, ["prompt", "question", "text"]),
      options,
      answerKind,
      // An open question with `allowCustom: false` renders no options and no
      // text box on either picker — unanswerable except by Skip — so open
      // always allows typing, whatever the model said.
      allowCustom: answerKind === "open" ? true : booleanField(value, ["allowCustom", "customAnswer", "custom"]) ?? true
    };
  },
  z.object({
    prompt: z.string(),
    options: z.array(z.string()).default([]),
    answerKind: z.enum(["choice", "multi", "open"]).default("open"),
    allowCustom: z.boolean().default(true)
  })
);

const bookPlanObjectSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  premise: z.string(),
  audience: z.string(),
  writingComplexity: writingComplexitySchema,
  voiceGuide: z.array(z.string()).min(1),
  antiAiRules: z.array(z.string()).min(1),
  writingMode: z.enum(WRITING_MODES).optional(),
  styleContract: styleContractSchema.optional(),
  questions: z.array(planQuestionSchema).default([]),
  chapters: z.array(chapterPlanSchema).min(1),
  characters: z.array(characterSchema).default([]),
  locations: z.array(locationSchema).default([]),
  continuityRules: z.array(z.string()).default([]),
  researchQueries: z.array(z.string()).default([]),
  researchNotes: z.array(researchSourceSchema).default([]),
  promises: z.array(z.string()).default([]),
  openingHook: z.string().optional(),
  authorStance: authorStanceSchema.optional(),
  /** The book's arc (generation/bookArc.ts). A stored arc that no longer parses is dropped, never a reason to fail the plan. */
  bookArc: z.preprocess((value) => (bookArcSchema.safeParse(value).success ? value : undefined), bookArcSchema.optional()),
  illustrationPlan: illustrationPlanSchema
});

export const bookPlanSchema = z.preprocess((value) => normalizeBookPlan(value, undefined), bookPlanObjectSchema);

export function bookPlanSchemaWithFallback(fallback: BookPlan) {
  return z.preprocess(normalizeBookPlanWithFallback(fallback), bookPlanObjectSchema);
}

/**
 * Initial planning treats research as trusted server-owned context. Omitting it
 * from the model-facing schema prevents structured-output providers from
 * reproducing the source package in their response; the planner attaches the
 * original notes after this schema has parsed the creative plan fields.
 */
export function bookPlanModelOutputSchemaWithFallback(fallback: BookPlan) {
  return z.preprocess(
    normalizeBookPlanWithFallback(fallback),
    bookPlanObjectSchema.omit({ researchNotes: true })
  );
}

export type BookPlan = z.infer<typeof bookPlanSchema>;
export type ChapterPlan = z.infer<typeof chapterPlanSchema>;
export type ResearchSource = z.infer<typeof researchSourceSchema>;
