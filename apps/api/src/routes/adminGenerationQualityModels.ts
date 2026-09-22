import {
  JEV_SELECTION,
  isJevSelection,
  GENERATION_TEXT_MODEL_ROUTE_FIELDS,
  GENERATION_TEXT_MODEL_TIERS,
  GENERATION_MODEL_STAGES,
  generationStageRoute,
  stageSupportsFiniteDecisions,
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

const jevSelectionSchema = z.object({
  provider: z.literal(JEV_SELECTION.provider),
  model: z.literal(JEV_SELECTION.model)
}).strict();
const partialSelectionSchema = textModelSelectionSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Name at least one model selection field." });
const stageRoutePatchSchema = z.object({
  primary: z.union([jevSelectionSchema, partialSelectionSchema]).optional(),
  fallback: partialSelectionSchema.optional()
}).strict().refine((value) => value.primary !== undefined || value.fallback !== undefined, { message: "Name a primary or fallback route." });
const stagesPatchSchema = z.partialRecord(z.enum(GENERATION_MODEL_STAGES.map((stage) => stage.id)), stageRoutePatchSchema)
  .refine((value) => Object.keys(value).length > 0, { message: "Name at least one stage." });
const tierModelsPatchSchema = z
  .object({
    writer: partialSelectionSchema.optional(),
    writerFallback: partialSelectionSchema.optional(),
    judgment: partialSelectionSchema.optional(),
    judgmentFallback: partialSelectionSchema.optional(),
    stages: stagesPatchSchema.optional()
  })
  .strict()
  .refine((value) => value.stages !== undefined || GENERATION_TEXT_MODEL_ROUTE_FIELDS.some((field) => value[field] !== undefined), {
    message: "Name a stage or default primary/fallback route."
  });

export const generationModelsPatchSchema = z
  .object({
    fastJudgments: partialSelectionSchema.optional(),
    fastJudgmentsFallback: partialSelectionSchema.optional(),
    fastDecisions: jevSelectionSchema.nullable().optional(),
    fastDecisionsFallback: partialSelectionSchema.optional(),
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
      value.fastDecisions !== undefined || value.fastDecisionsFallback !== undefined ||
      GENERATION_TEXT_MODEL_TIERS.some((tier) => value[tier] !== undefined),
    { message: "Name at least one model role." }
  );

export type GenerationModelsPatch = z.infer<typeof generationModelsPatchSchema>;

const selectionProperties = {
  provider: {
    type: "string",
    enum: ["deepseek", "deepinfra", "openrouter", "gemini", "alibaba", "openai", "openai-compatible"]
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
    judgmentFallback: partialSelectionOpenApi,
    stages: {
      type: "object", additionalProperties: false, minProperties: 1,
      properties: Object.fromEntries(GENERATION_MODEL_STAGES.map(({ id }) => [id, {
        type: "object", additionalProperties: false, minProperties: 1,
        properties: { primary: { anyOf: [partialSelectionOpenApi, {
          type: "object", additionalProperties: false, required: ["provider", "model"],
          properties: { provider: { const: JEV_SELECTION.provider }, model: { const: JEV_SELECTION.model } }
        }] }, fallback: partialSelectionOpenApi }
      }]))
    }
  }
} as const;

export const generationModelsPatchOpenApi = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    fastJudgments: partialSelectionOpenApi,
    fastJudgmentsFallback: partialSelectionOpenApi,
    fastDecisions: { anyOf: [{
      type: "object", additionalProperties: false, required: ["provider", "model"],
      properties: { provider: { const: JEV_SELECTION.provider }, model: { const: JEV_SELECTION.model } }
    }, { type: "null" }] },
    fastDecisionsFallback: partialSelectionOpenApi,
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
  const rootKeys = new Set<string>(["fastJudgments", "fastJudgmentsFallback", "fastDecisions", "fastDecisionsFallback", ...GENERATION_TEXT_MODEL_TIERS]);
  for (const key of Object.keys(models)) {
    if (!rootKeys.has(key)) {
      unknown.push(`models.${key}`);
    }
  }
  inspectSelection(models.fastJudgments, "models.fastJudgments", unknown);
  inspectSelection(models.fastJudgmentsFallback, "models.fastJudgmentsFallback", unknown);
  inspectSelection(models.fastDecisions, "models.fastDecisions", unknown);
  inspectSelection(models.fastDecisionsFallback, "models.fastDecisionsFallback", unknown);
  for (const tier of GENERATION_TEXT_MODEL_TIERS) {
    const tierValue = record(models[tier]);
    if (!tierValue) {
      continue;
    }
    for (const role of Object.keys(tierValue)) {
      if (role !== "stages" && !(GENERATION_TEXT_MODEL_ROUTE_FIELDS as readonly string[]).includes(role)) {
        unknown.push(`models.${tier}.${role}`);
      }
    }
    for (const field of GENERATION_TEXT_MODEL_ROUTE_FIELDS) {
      inspectSelection(tierValue[field], `models.${tier}.${field}`, unknown);
    }
    for (const [id, value] of Object.entries(record(tierValue.stages) ?? {})) {
      const path = `models.${tier}.stages.${id}`;
      if (!GENERATION_MODEL_STAGES.some((stage) => stage.id === id)) unknown.push(path);
      for (const field of Object.keys(record(value) ?? {})) {
        if (field !== "primary" && field !== "fallback") unknown.push(`${path}.${field}`);
        else inspectSelection(record(value)?.[field], `${path}.${field}`, unknown);
      }
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
  options: readonly GenerationTextModelOption[],
  jevAvailable = false
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
    const rawTier = cloneJsonObject(record(rawModels[tier]));
    // Snapshot legacy stages before changing defaults so unrelated stages cannot drift.
    const stages = cloneJsonObject(record(rawTier.stages));
    for (const { id } of GENERATION_MODEL_STAGES) {
      const currentRoute = generationStageRoute(current, tier, id);
      const stagePatch = tierPatch?.stages?.[id];
      let primary = currentRoute.primary;
      if (stagePatch?.primary) {
        if (isJevSelection(stagePatch.primary)) {
          if (!stageSupportsFiniteDecisions(id) || !jevAvailable) throw new GenerationModelSelectionError(`${tier}.${id}: Jev is unavailable or unsupported for this stage.`);
          primary = { ...JEV_SELECTION };
        } else {
          primary = validatedSelection(isJevSelection(primary) ? currentRoute.fallback : primary, stagePatch.primary, options, `${tier}.${id}.primary`);
        }
      }
      const fallback = stagePatch?.fallback
        ? validatedSelection(currentRoute.fallback, stagePatch.fallback, options, `${tier}.${id}.fallback`)
        : currentRoute.fallback;
      const rawStage = cloneJsonObject(record(stages[id]));
      stages[id] = {
        ...rawStage,
        primary: stagePatch?.primary ? { ...primary } : rawStage.primary ?? { ...primary },
        fallback: stagePatch?.fallback ? { ...fallback } : rawStage.fallback ?? { ...fallback }
      } as Prisma.InputJsonObject;
    }
    rawTier.stages = stages;
    for (const field of GENERATION_TEXT_MODEL_ROUTE_FIELDS) {
      const leaf = tierPatch?.[field];
      if (leaf) {
        rawTier[field] = validatedSelection(current[tier][field], leaf, options, `${tier}.${field}`) as Prisma.InputJsonObject;
      }
    }
    rawModels[tier] = rawTier;
  }
  if (patch.fastDecisions !== undefined) {
    if (patch.fastDecisions === null) rawModels.fastDecisions = null;
    else {
      if (!isJevSelection(patch.fastDecisions)) {
        throw new GenerationModelSelectionError(
          "Fast decisions: only Jev or the existing judgment routes are allowed."
        );
      }
      if (!jevAvailable) throw new GenerationModelSelectionError("Fast decisions: Jev credentials are unavailable.");
      rawModels.fastDecisions = { ...JEV_SELECTION };
      // Fresh enable pins from the post-patch Fast judgments leaf, never leftover fallback.
      if (!isJevSelection(current.fastDecisions) && patch.fastDecisionsFallback === undefined) {
        rawModels.fastDecisionsFallback = {
          ...(patch.fastJudgments ? rawModels.fastJudgments as object : current.fastJudgments)
        } as Prisma.InputJsonObject;
      }
    }
  }
  if (patch.fastDecisionsFallback) {
    const resultingPrimaryIsJev = patch.fastDecisions !== undefined
      ? isJevSelection(patch.fastDecisions)
      : isJevSelection(current.fastDecisions);
    if (!resultingPrimaryIsJev) {
      throw new GenerationModelSelectionError(
        "Fast decisions fallback can only be set when Fast decisions is Jev."
      );
    }
    rawModels.fastDecisionsFallback = validatedSelection(current.fastDecisionsFallback ?? current.fastJudgments, patch.fastDecisionsFallback, options, "Fast decisions fallback") as Prisma.InputJsonObject;
  }
  return rawModels;
}

/** Reset the known writer, judgment, and Fast-decision primary/fallback routes and preserve routing a newer build may own. */
export function resetGenerationModels(
  storedSettings: unknown,
  compiled: GenerationTextModelRouting
): Prisma.InputJsonObject {
  const rawModels = cloneJsonObject(record(record(storedSettings)?.models));
  rawModels.fastJudgments = { ...compiled.fastJudgments } as Prisma.InputJsonObject;
  rawModels.fastDecisions = null;
  rawModels.fastDecisionsFallback = { ...(compiled.fastDecisionsFallback ?? compiled.fastJudgments) } as Prisma.InputJsonObject;
  rawModels.fastJudgmentsFallback = { ...compiled.fastJudgmentsFallback } as Prisma.InputJsonObject;
  for (const tier of GENERATION_TEXT_MODEL_TIERS) {
    const rawTier = cloneJsonObject(record(rawModels[tier]));
    for (const field of GENERATION_TEXT_MODEL_ROUTE_FIELDS) {
      rawTier[field] = { ...compiled[tier][field] } as Prisma.InputJsonObject;
    }
    const stages = cloneJsonObject(record(rawTier.stages));
    for (const { id } of GENERATION_MODEL_STAGES) {
      const route = generationStageRoute(compiled, tier, id);
      stages[id] = { primary: { ...route.primary }, fallback: { ...route.fallback } } as Prisma.InputJsonObject;
    }
    rawTier.stages = stages;
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
  const allowed = new Set(isJevSelection(selection) ? ["provider", "model"] : Object.keys(selectionProperties));
  for (const key of Object.keys(selection)) {
    if (!allowed.has(key)) {
      unknown.push(`${path}.${key}`);
    }
  }
}

function cloneJsonObject(value: Record<string, unknown> | undefined): Record<string, Prisma.InputJsonValue | null> {
  return value ? (JSON.parse(JSON.stringify(value)) as Record<string, Prisma.InputJsonValue | null>) : {};
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
