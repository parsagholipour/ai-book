import type { AppConfig } from "../config.js";
import type {
  ModelTier,
  TextModelSelection,
  TextModelThinkingEffort
} from "../schemas/book.js";

export type { ModelTier, TextModelSelection, TextModelThinkingEffort } from "../schemas/book.js";

export const GENERATION_TEXT_MODEL_TIERS = ["fast", "balanced", "premium", "ultra"] as const;
export const GENERATION_TEXT_MODEL_ROLES = ["writer", "judgment"] as const;

export type GenerationTextModelRole = (typeof GENERATION_TEXT_MODEL_ROLES)[number];
export type GenerationTextModelTierRouting = {
  writer: TextModelSelection;
  judgment: TextModelSelection;
};

/** The nine operator-controlled text-model roles used by generation and inline decisions. */
export type GenerationTextModelRouting = {
  fastJudgments: TextModelSelection;
  fast: GenerationTextModelTierRouting;
  balanced: GenerationTextModelTierRouting;
  premium: GenerationTextModelTierRouting;
  ultra: GenerationTextModelTierRouting;
};

export type GenerationTextModelOption = TextModelSelection & {
  label: string;
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
  const fast = preferredOrNext(
    { provider: "deepseek", model: config.DEEPSEEK_FAST_MODEL, thinkingEnabled: false },
    configuredOptions,
    [
      { provider: "deepinfra", model: config.DEEPINFRA_FAST_MODEL, thinkingEnabled: false },
      FAST_GEMINI,
      { provider: "alibaba", model: "qwen-flash" }
    ]
  );
  const balancedWriter = preferredOrNext(
    { provider: "deepseek", model: config.DEEPSEEK_MODEL },
    configuredOptions,
    [
      { provider: "deepinfra", model: config.DEEPINFRA_MODEL },
      PREMIUM_WRITER,
      { provider: "alibaba", model: config.ALIBABA_TEXT_MODEL }
    ]
  );
  const balancedJudgment = preferredOrNext(
    { provider: "deepseek", model: config.DEEPSEEK_FAST_MODEL, thinkingEnabled: false },
    configuredOptions,
    [
      { provider: "deepinfra", model: config.DEEPINFRA_FAST_MODEL, thinkingEnabled: false },
      PREMIUM_JUDGMENT,
      { provider: "alibaba", model: "qwen-flash" }
    ]
  );
  const premiumWriter = preferredOrNext(PREMIUM_WRITER, configuredOptions, [
    { provider: "deepseek", model: config.DEEPSEEK_MODEL },
    { provider: "deepinfra", model: config.DEEPINFRA_MODEL },
    { provider: "alibaba", model: config.ALIBABA_TEXT_MODEL }
  ]);
  const premiumJudgment = preferredOrNext(PREMIUM_JUDGMENT, configuredOptions, [
    { provider: "deepseek", model: config.DEEPSEEK_FAST_MODEL, thinkingEnabled: false },
    { provider: "deepinfra", model: config.DEEPINFRA_FAST_MODEL, thinkingEnabled: false },
    { provider: "alibaba", model: "qwen-flash" }
  ]);
  return {
    fastJudgments: fast,
    fast: { writer: fast, judgment: fast },
    balanced: { writer: balancedWriter, judgment: balancedJudgment },
    premium: { writer: premiumWriter, judgment: premiumJudgment },
    ultra: { writer: premiumWriter, judgment: premiumJudgment }
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
  return {
    fastJudgments: parseTextModelSelection(stored?.fastJudgments) ?? cloneSelection(compiled.fastJudgments),
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
  return {
    writer: parseTextModelSelection(stored?.writer) ?? cloneSelection(fallback.writer),
    judgment: parseTextModelSelection(stored?.judgment) ?? cloneSelection(fallback.judgment)
  };
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
