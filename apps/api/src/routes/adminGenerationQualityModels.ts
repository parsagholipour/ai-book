import {
  GENERATION_TEXT_MODEL_ROUTE_FIELDS,
  GENERATION_TEXT_MODEL_TIERS,
  generationTextModelOptionKey,
  resolveGenerationTextModelRouting,
  selectionFromGenerationOption,
  textModelSelectionSchema,
  type GenerationTextModelOption,
  type GenerationTextModelRouting,
  type TextModelSelection
} from "@book-maker/core";
import type { Prisma } from "@book-maker/db";
import { z } from "zod";

const partialSelectionSchema = textModelSelectionSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Name at least one model selection field." });
const tierModelsPatchSchema = z
  .object({
    writer: partialSelectionSchema.optional(),
    writerFallback: partialSelectionSchema.optional(),
    judgment: partialSelectionSchema.optional(),
    judgmentFallback: partialSelectionSchema.optional()
  })
  .strict()
  .refine((value) => GENERATION_TEXT_MODEL_ROUTE_FIELDS.some((field) => value[field] !== undefined), {
    message: "Name a Writer or Judgment primary/fallback route."
  });

export const generationModelsPatchSchema = z
  .object({
    fastJudgments: partialSelectionSchema.optional(),
    fastJudgmentsFallback: partialSelectionSchema.optional(),
    fast: tierModelsPatchSchema.optional(),
    balanced: tierModelsPatchSchema.optional(),
    premium: tierModelsPatchSchema.optional(),
    ultra: tierModelsPatchSchema.optional()
  })
  .strict()
  .refine(
    (value) =>
      value.fastJudgments !== undefined ||
      value.fastJudgmentsFallback !== undefined ||
      GENERATION_TEXT_MODEL_TIERS.some((tier) => value[tier] !== undefined),
    { message: "Name at least one model role." }
  );

export type GenerationModelsPatch = z.infer<typeof generationModelsPatchSchema>;

const selectionProperties = {
  provider: {
    type: "string",
    enum: ["deepseek", "deepinfra", "gemini", "alibaba", "openai", "openai-compatible"]
  },
  model: { type: "string", minLength: 1, maxLength: 120 },
  thinkingBudget: { type: "integer", minimum: -1, maximum: 32768 },
  thinkingEnabled: { type: "boolean" },
  thinkingEffort: {
    type: "string",
    enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
  }
} as const;

const partialSelectionOpenApi = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: selectionProperties
} as const;
const tierModelsPatchOpenApi = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    writer: partialSelectionOpenApi,
    writerFallback: partialSelectionOpenApi,
    judgment: partialSelectionOpenApi,
    judgmentFallback: partialSelectionOpenApi
  }
} as const;

export const generationModelsPatchOpenApi = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    fastJudgments: partialSelectionOpenApi,
    fastJudgmentsFallback: partialSelectionOpenApi,
    fast: tierModelsPatchOpenApi,
    balanced: tierModelsPatchOpenApi,
    premium: tierModelsPatchOpenApi,
    ultra: tierModelsPatchOpenApi
  }
} as const;

export class GenerationModelSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationModelSelectionError";
  }
}

/** Paths AJV would otherwise strip before Zod can name them. */
export function unknownGenerationModelPaths(body: unknown): string[] {
  const root = record(body);
  const models = record(root?.models);
  if (!models) {
    return [];
  }
  const unknown: string[] = [];
  const rootKeys = new Set<string>(["fastJudgments", "fastJudgmentsFallback", ...GENERATION_TEXT_MODEL_TIERS]);
  for (const key of Object.keys(models)) {
    if (!rootKeys.has(key)) {
      unknown.push(`models.${key}`);
    }
  }
  inspectSelection(models.fastJudgments, "models.fastJudgments", unknown);
  inspectSelection(models.fastJudgmentsFallback, "models.fastJudgmentsFallback", unknown);
  for (const tier of GENERATION_TEXT_MODEL_TIERS) {
    const tierValue = record(models[tier]);
    if (!tierValue) {
      continue;
    }
    for (const role of Object.keys(tierValue)) {
      if (!(GENERATION_TEXT_MODEL_ROUTE_FIELDS as readonly string[]).includes(role)) {
        unknown.push(`models.${tier}.${role}`);
      }
    }
    for (const field of GENERATION_TEXT_MODEL_ROUTE_FIELDS) {
      inspectSelection(tierValue[field], `models.${tier}.${field}`, unknown);
    }
  }
  return unknown;
}

/**
 * Merge only claimed leaves onto the raw stored model document. Future roles
 * survive, while every claimed leaf is completed and checked against the
 * configured catalog before it is written.
 */
export function mergeGenerationModelPatch(
  storedSettings: unknown,
  patch: GenerationModelsPatch,
  compiled: GenerationTextModelRouting,
  options: readonly GenerationTextModelOption[]
): Prisma.InputJsonObject {
  const current = resolveGenerationTextModelRouting(storedSettings, compiled);
  const rawModels = cloneJsonObject(record(record(storedSettings)?.models));
  if (patch.fastJudgments) {
    rawModels.fastJudgments = validatedSelection(
      current.fastJudgments,
      patch.fastJudgments,
      options,
      "Fast judgments"
    ) as Prisma.InputJsonObject;
  }
  if (patch.fastJudgmentsFallback) {
    rawModels.fastJudgmentsFallback = validatedSelection(
      current.fastJudgmentsFallback,
      patch.fastJudgmentsFallback,
      options,
      "Fast judgments fallback"
    ) as Prisma.InputJsonObject;
  }
  for (const tier of GENERATION_TEXT_MODEL_TIERS) {
    const tierPatch = patch[tier];
    if (!tierPatch) {
      continue;
    }
    const rawTier = cloneJsonObject(record(rawModels[tier]));
    for (const field of GENERATION_TEXT_MODEL_ROUTE_FIELDS) {
      const leaf = tierPatch[field];
      if (leaf) {
        rawTier[field] = validatedSelection(current[tier][field], leaf, options, `${tier}.${field}`) as Prisma.InputJsonObject;
      }
    }
    rawModels[tier] = rawTier;
  }
  return rawModels;
}

/** Reset the nine known primary/fallback route pairs and preserve routing a newer build may own. */
export function resetGenerationModels(
  storedSettings: unknown,
  compiled: GenerationTextModelRouting
): Prisma.InputJsonObject {
  const rawModels = cloneJsonObject(record(record(storedSettings)?.models));
  rawModels.fastJudgments = { ...compiled.fastJudgments } as Prisma.InputJsonObject;
  rawModels.fastJudgmentsFallback = { ...compiled.fastJudgmentsFallback } as Prisma.InputJsonObject;
  for (const tier of GENERATION_TEXT_MODEL_TIERS) {
    const rawTier = cloneJsonObject(record(rawModels[tier]));
    for (const field of GENERATION_TEXT_MODEL_ROUTE_FIELDS) {
      rawTier[field] = { ...compiled[tier][field] } as Prisma.InputJsonObject;
    }
    rawModels[tier] = rawTier;
  }
  return rawModels;
}

function validatedSelection(
  current: TextModelSelection,
  patch: {
    provider?: TextModelSelection["provider"] | undefined;
    model?: string | undefined;
    thinkingBudget?: number | undefined;
    thinkingEnabled?: boolean | undefined;
    thinkingEffort?: TextModelSelection["thinkingEffort"] | undefined;
  },
  options: readonly GenerationTextModelOption[],
  label: string
): TextModelSelection {
  const provider = patch.provider ?? current.provider;
  const model = patch.model ?? current.model;
  const candidates = options.filter((option) => option.provider === provider && option.model === model);
  if (candidates.length === 0) {
    throw new GenerationModelSelectionError(
      `${label}: ${provider}/${model} is not a configured catalog model.`
    );
  }
  const identityChanged = provider !== current.provider || model !== current.model;
  const fixedRequested = patch.thinkingBudget !== undefined || patch.thinkingEnabled !== undefined;
  const requestedFixed = {
    provider,
    model,
    ...(patch.thinkingBudget !== undefined ? { thinkingBudget: patch.thinkingBudget } : {}),
    ...(patch.thinkingEnabled !== undefined ? { thinkingEnabled: patch.thinkingEnabled } : {})
  } satisfies TextModelSelection;
  const option = fixedRequested
    ? candidates.find((candidate) => generationTextModelOptionKey(candidate) === generationTextModelOptionKey(requestedFixed))
    : candidates.find((candidate) => generationTextModelOptionKey(candidate) === generationTextModelOptionKey(current)) ?? candidates[0];
  if (!option) {
    throw new GenerationModelSelectionError(`${label}: fixed reasoning settings are catalog-controlled.`);
  }
  const base = identityChanged || fixedRequested ? selectionFromGenerationOption(option) : canonicalCurrent(current, option);
  const effort = patch.thinkingEffort ?? base.thinkingEffort;
  const supportedEfforts = option.thinkingEfforts?.map((candidate) => candidate.value) ?? [];
  if (effort !== undefined && !supportedEfforts.includes(effort)) {
    throw new GenerationModelSelectionError(
      `${label}: effort ${effort} is not supported by ${provider}/${model}.`
    );
  }
  return {
    provider,
    model,
    ...(option.thinkingBudget !== undefined ? { thinkingBudget: option.thinkingBudget } : {}),
    ...(option.thinkingEnabled !== undefined ? { thinkingEnabled: option.thinkingEnabled } : {}),
    ...(effort !== undefined ? { thinkingEffort: effort } : {})
  };
}

function canonicalCurrent(current: TextModelSelection, option: GenerationTextModelOption): TextModelSelection {
  const fixedMatches = generationTextModelOptionKey(current) === generationTextModelOptionKey(option);
  return fixedMatches ? { ...current } : selectionFromGenerationOption(option);
}

function inspectSelection(value: unknown, path: string, unknown: string[]): void {
  const selection = record(value);
  if (!selection) {
    return;
  }
  const allowed = new Set(Object.keys(selectionProperties));
  for (const key of Object.keys(selection)) {
    if (!allowed.has(key)) {
      unknown.push(`${path}.${key}`);
    }
  }
}

function cloneJsonObject(value: Record<string, unknown> | undefined): Record<string, Prisma.InputJsonValue> {
  return value ? (JSON.parse(JSON.stringify(value)) as Record<string, Prisma.InputJsonValue>) : {};
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
