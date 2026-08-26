import type { AppConfig } from "../config.js";
import type { TextGenerationCostRate } from "../costs.js";
import type {
  ModelTier,
  TextModelSelection,
  TextModelThinkingEffort
} from "../schemas/book.js";

export type { ModelTier, TextModelSelection, TextModelThinkingEffort } from "../schemas/book.js";

export const GENERATION_TEXT_MODEL_TIERS = ["fast", "balanced", "premium", "ultra"] as const;
export const GENERATION_TEXT_MODEL_ROLES = ["writer", "judgment"] as const;
export const GENERATION_TEXT_MODEL_ROUTE_FIELDS = [
  "writer",
  "writerFallback",
  "judgment",
  "judgmentFallback"
] as const;

export type GenerationTextModelRole = (typeof GENERATION_TEXT_MODEL_ROLES)[number];
export type GenerationTextModelRouteField = (typeof GENERATION_TEXT_MODEL_ROUTE_FIELDS)[number];
export type GenerationTextModelTierRouting = {
  writer: TextModelSelection;
  writerFallback: TextModelSelection;
  judgment: TextModelSelection;
  judgmentFallback: TextModelSelection;
};

/** The nine text-model routes and their operator-controlled fallback selections. */
export type GenerationTextModelRouting = {
  fastJudgments: TextModelSelection;
  fastJudgmentsFallback: TextModelSelection;
  fast: GenerationTextModelTierRouting;
  balanced: GenerationTextModelTierRouting;
  premium: GenerationTextModelTierRouting;
  ultra: GenerationTextModelTierRouting;
};

export type GenerationTextModelOption = TextModelSelection & {
  label: string;
  costs?: TextGenerationCostRate[] | undefined;
  preview?: boolean | undefined;
  thinking?: boolean | undefined;
  thinkingEfforts?: Array<{
    value: TextModelThinkingEffort;
    label: string;
    default?: boolean | undefined;
  }> | undefined;
};

const PREMIUM_WRITER: TextModelSelection = {
  provider: "gemini",
  model: "gemini-2.5-pro",
  thinkingBudget: 2048
};
const PREMIUM_JUDGMENT: TextModelSelection = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  thinkingBudget: 0
};
const FAST_GEMINI: TextModelSelection = {
  provider: "gemini",
  model: "gemini-2.5-flash-lite",
  thinkingBudget: 0
};

/**
 * Defaults are the routing that existed before the Quality tab exposed models.
 * A missing preferred provider falls through to the configured catalog order.
 */
export function compiledGenerationTextModelRouting(
  config: AppConfig,
  configuredOptions: readonly GenerationTextModelOption[]
): GenerationTextModelRouting {
  const fast = preferredRoute(
    [
      { provider: "deepseek", model: config.DEEPSEEK_FAST_MODEL, thinkingEnabled: false },
      { provider: "deepinfra", model: config.DEEPINFRA_FAST_MODEL, thinkingEnabled: false },
      FAST_GEMINI,
      { provider: "alibaba", model: "qwen-flash" }
    ],
    configuredOptions
  );
  const balancedWriter = preferredRoute(
    [
      { provider: "deepseek", model: config.DEEPSEEK_MODEL },
      { provider: "deepinfra", model: config.DEEPINFRA_MODEL },
      PREMIUM_WRITER,
      { provider: "alibaba", model: config.ALIBABA_TEXT_MODEL }
    ],
    configuredOptions
  );
  const balancedJudgment = preferredRoute(
    [
      { provider: "deepseek", model: config.DEEPSEEK_FAST_MODEL, thinkingEnabled: false },
      { provider: "deepinfra", model: config.DEEPINFRA_FAST_MODEL, thinkingEnabled: false },
      PREMIUM_JUDGMENT,
      { provider: "alibaba", model: "qwen-flash" }
    ],
    configuredOptions
  );
  const premiumWriter = preferredRoute(
    [
      PREMIUM_WRITER,
      { provider: "deepseek", model: config.DEEPSEEK_MODEL },
      { provider: "deepinfra", model: config.DEEPINFRA_MODEL },
      { provider: "alibaba", model: config.ALIBABA_TEXT_MODEL }
    ],
    configuredOptions
  );
  const premiumJudgment = preferredRoute(
    [
      PREMIUM_JUDGMENT,
      { provider: "deepseek", model: config.DEEPSEEK_FAST_MODEL, thinkingEnabled: false },
      { provider: "deepinfra", model: config.DEEPINFRA_FAST_MODEL, thinkingEnabled: false },
      { provider: "alibaba", model: "qwen-flash" }
    ],
    configuredOptions
  );
  return {
    fastJudgments: fast.primary,
    fastJudgmentsFallback: fast.fallback,
    fast: tierRoute(fast, fast),
    balanced: tierRoute(balancedWriter, balancedJudgment),
    premium: tierRoute(premiumWriter, premiumJudgment),
    ultra: tierRoute(premiumWriter, premiumJudgment)
  };
}

/**
 * Reads the nested `models` document without making credentials authoritative
 * over a saved choice. Removed credentials must leave the saved selection
 * visible to the admin UI as unavailable; only a missing/malformed leaf falls
 * back to the compiled routing.
 */
export function resolveGenerationTextModelRouting(
  storedSettings: unknown,
  compiled: GenerationTextModelRouting
): GenerationTextModelRouting {
  const settings = record(storedSettings);
  const stored = record(settings?.models);
  const fastJudgments = parseTextModelSelection(stored?.fastJudgments) ?? cloneSelection(compiled.fastJudgments);
  return {
    fastJudgments,
    fastJudgmentsFallback:
      parseTextModelSelection(stored?.fastJudgmentsFallback) ??
      legacyFallback(fastJudgments, compiled.fastJudgments, compiled.fastJudgmentsFallback),
    fast: tierRouting(stored?.fast, compiled.fast),
    balanced: tierRouting(stored?.balanced, compiled.balanced),
    premium: tierRouting(stored?.premium, compiled.premium),
    ultra: tierRouting(stored?.ultra, compiled.ultra)
  };
}

export function routingSelection(
  routing: GenerationTextModelRouting,
  tier: ModelTier,
  role: GenerationTextModelRole
): TextModelSelection {
  return routing[tier][role];
}

export function routingFallbackSelection(
  routing: GenerationTextModelRouting,
  tier: ModelTier,
  role: GenerationTextModelRole
): TextModelSelection {
  return routing[tier][fallbackField(role)];
}

export function fallbackField(role: GenerationTextModelRole): "writerFallback" | "judgmentFallback" {
  return role === "writer" ? "writerFallback" : "judgmentFallback";
}

/** Stable value for adapter caches and browser select controls. */
export function textModelSelectionKey(selection: TextModelSelection): string {
  return JSON.stringify({
    provider: selection.provider,
    model: selection.model,
    ...(selection.thinkingBudget !== undefined ? { thinkingBudget: selection.thinkingBudget } : {}),
    ...(selection.thinkingEnabled !== undefined ? { thinkingEnabled: selection.thinkingEnabled } : {}),
    ...(selection.thinkingEffort !== undefined ? { thinkingEffort: selection.thinkingEffort } : {})
  });
}

export function sameTextModelSelection(a: TextModelSelection, b: TextModelSelection): boolean {
  return textModelSelectionKey(a) === textModelSelectionKey(b);
}

/** Model identity plus catalog-fixed flags; effort is the separately editable capability. */
export function generationTextModelOptionKey(selection: TextModelSelection): string {
  return JSON.stringify({
    provider: selection.provider,
    model: selection.model,
    ...(selection.thinkingBudget !== undefined ? { thinkingBudget: selection.thinkingBudget } : {}),
    ...(selection.thinkingEnabled !== undefined ? { thinkingEnabled: selection.thinkingEnabled } : {})
  });
}

/** Apply a catalog default effort without inventing reasoning for models that advertise none. */
export function selectionFromGenerationOption(option: GenerationTextModelOption): TextModelSelection {
  const defaultEffort = option.thinkingEfforts?.find((effort) => effort.default)?.value;
  return {
    provider: option.provider,
    model: option.model,
    ...(option.thinkingBudget !== undefined ? { thinkingBudget: option.thinkingBudget } : {}),
    ...(option.thinkingEnabled !== undefined ? { thinkingEnabled: option.thinkingEnabled } : {}),
    ...(defaultEffort !== undefined ? { thinkingEffort: defaultEffort } : {})
  };
}

function preferredOrNext(
  preferred: TextModelSelection,
  options: readonly GenerationTextModelOption[],
  alternates: readonly TextModelSelection[] = []
): TextModelSelection {
  for (const candidate of [preferred, ...alternates]) {
    const exact = options.find(
      (option) =>
        option.provider === candidate.provider &&
        option.model === candidate.model &&
        fixedReasoningMatches(option, candidate)
    );
    if (exact) {
      // Keep the historical spelling of the default (notably
      // thinkingEnabled:false) while using the catalog to prove availability.
      return cloneSelection(candidate);
    }
    const sameModel = options.find(
      (option) => option.provider === candidate.provider && option.model === candidate.model
    );
    if (sameModel) {
      return fixedReasoningSupported(sameModel, candidate)
        ? cloneSelection(candidate)
        : selectionFromGenerationOption(sameModel);
    }
  }
  const fallback = options[0];
  return fallback ? selectionFromGenerationOption(fallback) : cloneSelection(preferred);
}

function preferredRoute(
  candidates: readonly [TextModelSelection, ...TextModelSelection[]],
  options: readonly GenerationTextModelOption[]
): { primary: TextModelSelection; fallback: TextModelSelection } {
  const primary = preferredOrNext(candidates[0], options, candidates.slice(1));
  for (const candidate of candidates) {
    const available = availableSelection(candidate, options);
    if (available && !sameTextModelIdentity(primary, available)) {
      return { primary, fallback: available };
    }
  }
  const catalogFallback = options
    .map(selectionFromGenerationOption)
    .find((selection) => !sameTextModelIdentity(primary, selection));
  return { primary, fallback: catalogFallback ?? cloneSelection(primary) };
}

function availableSelection(
  candidate: TextModelSelection,
  options: readonly GenerationTextModelOption[]
): TextModelSelection | undefined {
  const exact = options.find(
    (option) =>
      option.provider === candidate.provider &&
      option.model === candidate.model &&
      fixedReasoningMatches(option, candidate)
  );
  if (exact) return cloneSelection(candidate);
  const sameModel = options.find(
    (option) => option.provider === candidate.provider && option.model === candidate.model
  );
  if (!sameModel) return undefined;
  return fixedReasoningSupported(sameModel, candidate)
    ? cloneSelection(candidate)
    : selectionFromGenerationOption(sameModel);
}

function tierRoute(
  writer: { primary: TextModelSelection; fallback: TextModelSelection },
  judgment: { primary: TextModelSelection; fallback: TextModelSelection }
): GenerationTextModelTierRouting {
  return {
    writer: cloneSelection(writer.primary),
    writerFallback: cloneSelection(writer.fallback),
    judgment: cloneSelection(judgment.primary),
    judgmentFallback: cloneSelection(judgment.fallback)
  };
}

function fixedReasoningSupported(
  option: GenerationTextModelOption,
  selection: TextModelSelection
): boolean {
  if (selection.thinkingBudget !== undefined) {
    // 0 disables thinking and is valid even when the catalog omits a budget (flash-lite).
    return option.thinkingBudget !== undefined || selection.thinkingBudget === 0;
  }
  if (selection.thinkingEnabled !== undefined) {
    return option.thinking === true || option.thinkingEnabled !== undefined || Boolean(option.thinkingEfforts?.length);
  }
  return true;
}

function fixedReasoningMatches(option: TextModelSelection, selection: TextModelSelection): boolean {
  return (
    option.thinkingBudget === selection.thinkingBudget &&
    option.thinkingEnabled === selection.thinkingEnabled
  );
}

function tierRouting(value: unknown, fallback: GenerationTextModelTierRouting): GenerationTextModelTierRouting {
  const stored = record(value);
  const writer = parseTextModelSelection(stored?.writer) ?? cloneSelection(fallback.writer);
  const judgment = parseTextModelSelection(stored?.judgment) ?? cloneSelection(fallback.judgment);
  return {
    writer,
    writerFallback:
      parseTextModelSelection(stored?.writerFallback) ??
      legacyFallback(writer, fallback.writer, fallback.writerFallback),
    judgment,
    judgmentFallback:
      parseTextModelSelection(stored?.judgmentFallback) ??
      legacyFallback(judgment, fallback.judgment, fallback.judgmentFallback)
  };
}

function legacyFallback(
  primary: TextModelSelection,
  compiledPrimary: TextModelSelection,
  compiledFallback: TextModelSelection
): TextModelSelection {
  if (!sameTextModelIdentity(primary, compiledFallback)) return cloneSelection(compiledFallback);
  if (!sameTextModelIdentity(primary, compiledPrimary)) return cloneSelection(compiledPrimary);
  return cloneSelection(compiledFallback);
}

function sameTextModelIdentity(a: TextModelSelection, b: TextModelSelection): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/** Reads a stored or wire selection; malformed leaves fall through to compiled routing. */
export function parseTextModelSelection(value: unknown): TextModelSelection | undefined {
  const candidate = record(value);
  if (!candidate || typeof candidate.model !== "string" || !textProvider(candidate.provider)) {
    return undefined;
  }
  const model = candidate.model.trim();
  if (!model) {
    return undefined;
  }
  const thinkingBudget = candidate.thinkingBudget;
  const thinkingEnabled = candidate.thinkingEnabled;
  const thinkingEffort = candidate.thinkingEffort;
  if (
    (thinkingBudget !== undefined &&
      (typeof thinkingBudget !== "number" || !Number.isInteger(thinkingBudget) || thinkingBudget < -1 || thinkingBudget > 32768)) ||
    (thinkingEnabled !== undefined && typeof thinkingEnabled !== "boolean") ||
    (thinkingEffort !== undefined && !thinkingEfforts().has(thinkingEffort))
  ) {
    return undefined;
  }
  return {
    provider: candidate.provider,
    model,
    ...(typeof thinkingBudget === "number" ? { thinkingBudget } : {}),
    ...(typeof thinkingEnabled === "boolean" ? { thinkingEnabled } : {}),
    ...(typeof thinkingEffort === "string" ? { thinkingEffort: thinkingEffort as TextModelThinkingEffort } : {})
  };
}

function textProvider(value: unknown): value is TextModelSelection["provider"] {
  return (
    value === "deepseek" ||
    value === "deepinfra" ||
    value === "gemini" ||
    value === "alibaba" ||
    value === "openai" ||
    value === "openai-compatible"
  );
}

function thinkingEfforts(): ReadonlySet<unknown> {
  return new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
}

function cloneSelection(selection: TextModelSelection): TextModelSelection {
  return { ...selection };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
