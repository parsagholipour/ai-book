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
import { illustrationCadenceSchema } from "./mediaSettings.js";

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

function mergePlanRecords(
  fallback: Record<string, unknown> | undefined,
  candidate: Record<string, unknown>
): Record<string, unknown> {
  if (!fallback) {
    return candidate;
  }

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
      ? mergePlanRecords(fallbackValue, value)
      : value;
  }
  return merged;
}

function normalizePlanScalarArrays(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    voiceGuide: coerceStringArray(value.voiceGuide),
    antiAiRules: coerceStringArray(value.antiAiRules)
  };
}

function normalizeBookPlan(value: unknown): unknown {
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

  return normalizePlanScalarArrays({
    ...unwrapped,
    writingComplexity:
      unwrapped.writingComplexity ??
      unwrapped.complexity ??
      unwrapped.writing_complexity ??
      unwrapped.writingLevel ??
      unwrapped.readingLevel
  });
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

    return normalizeBookPlan(candidate);
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
    name: stringField(value, ["name", "characterName", "fullName"]) ?? "Unnamed character",
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
  writingComplexity: z.coerce.number().int().min(1).max(10),
  voiceGuide: z.array(z.string()).min(1),
  antiAiRules: z.array(z.string()).min(1),
  questions: z.array(planQuestionSchema).default([]),
  chapters: z.array(chapterPlanSchema).min(1),
  characters: z.array(characterSchema).default([]),
  locations: z.array(locationSchema).default([]),
  continuityRules: z.array(z.string()).default([]),
  researchQueries: z.array(z.string()).default([]),
  researchNotes: z.array(researchSourceSchema).default([]),
  promises: z.array(z.string()).default([]),
  illustrationPlan: illustrationPlanSchema
});

export const bookPlanSchema = z.preprocess(normalizeBookPlan, bookPlanObjectSchema);

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
