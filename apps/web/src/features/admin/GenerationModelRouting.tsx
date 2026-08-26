import { AlertTriangle, Cpu } from "lucide-react";
import {
  GENERATION_TEXT_MODEL_ROUTE_FIELDS,
  GENERATION_TEXT_MODEL_TIERS,
  generationTextModelOptionKey,
  parseTextModelSelection,
  selectionFromGenerationOption,
  type GenerationTextModelOption,
  type GenerationTextModelRouteField,
  type GenerationTextModelRouting,
  type ModelTier,
  type TextModelSelection,
  type TextModelThinkingEffort
} from "@book-maker/core/generationTextModelRouting";

export type GenerationModelRoutingPatch = {
  fastJudgments?: Partial<TextModelSelection> | undefined;
  fastJudgmentsFallback?: Partial<TextModelSelection> | undefined;
  fast?: Partial<Record<GenerationTextModelRouteField, Partial<TextModelSelection>>> | undefined;
  balanced?: Partial<Record<GenerationTextModelRouteField, Partial<TextModelSelection>>> | undefined;
  premium?: Partial<Record<GenerationTextModelRouteField, Partial<TextModelSelection>>> | undefined;
  ultra?: Partial<Record<GenerationTextModelRouteField, Partial<TextModelSelection>>> | undefined;
};

const TIER_LABELS: Record<ModelTier, string> = {
  fast: "Quick",
  balanced: "Balanced",
  premium: "Premium",
  ultra: "Ultra"
};

export function GenerationModelRoutingSection({
  models,
  options,
  disabled,
  onChange
}: {
  models: GenerationTextModelRouting;
  options: GenerationTextModelOption[];
  disabled: boolean;
  onChange: (next: GenerationTextModelRouting) => void;
}) {
  const update = (tier: ModelTier, field: GenerationTextModelRouteField, selection: TextModelSelection) => {
    onChange({ ...models, [tier]: { ...models[tier], [field]: selection } });
  };
  return (
    <section className="work-section safety-settings-card quality-model-routing">
      <div className="section-title">
        <Cpu size={18} aria-hidden />
        <h3>Model routing</h3>
      </div>
      <p className="muted">
        These provider/model choices control all writer, judgment, and inline decision calls, including calls for
        existing projects. Each successful save affects calls started afterward. An availability failure switches
        once to that route&apos;s fallback; in-flight calls keep the primary/fallback pair they started with. Costs are
        provider USD per 1M tokens; ranges cover long-context or peak/off-peak rate bands.
      </p>
      <div className="quality-model-fast">
        <ModelSelectionField
          label="Fast judgments"
          selection={models.fastJudgments}
          options={options}
          disabled={disabled}
          onChange={(selection) => onChange({ ...models, fastJudgments: selection })}
        />
        <ModelSelectionField
          label="Fast judgments fallback"
          selection={models.fastJudgmentsFallback}
          options={options}
          disabled={disabled}
          onChange={(selection) => onChange({ ...models, fastJudgmentsFallback: selection })}
        />
        <small className="quality-model-fast-summary">
          Short inline creation, routing, advisor, and language-detection decisions.
        </small>
      </div>
      <div className="quality-model-table" role="table" aria-label="Tier model routing">
        <div className="quality-model-head" role="row">
          <span role="columnheader">Tier</span>
          <span role="columnheader">Writer</span>
          <span role="columnheader">Judgment</span>
        </div>
        {GENERATION_TEXT_MODEL_TIERS.map((tier) => {
          const label = TIER_LABELS[tier];
          return (
            <div className="quality-model-row" role="row" key={tier}>
              <strong role="rowheader">{label}</strong>
              <ModelRoutePair
                label={`${label} Writer`}
                primary={models[tier].writer}
                fallback={models[tier].writerFallback}
                options={options}
                disabled={disabled}
                onPrimaryChange={(selection) => update(tier, "writer", selection)}
                onFallbackChange={(selection) => update(tier, "writerFallback", selection)}
              />
              <ModelRoutePair
                label={`${label} Judgment`}
                primary={models[tier].judgment}
                fallback={models[tier].judgmentFallback}
                options={options}
                disabled={disabled}
                onPrimaryChange={(selection) => update(tier, "judgment", selection)}
                onFallbackChange={(selection) => update(tier, "judgmentFallback", selection)}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ModelRoutePair({
  label,
  primary,
  fallback,
  options,
  disabled,
  onPrimaryChange,
  onFallbackChange
}: {
  label: string;
  primary: TextModelSelection;
  fallback: TextModelSelection;
  options: GenerationTextModelOption[];
  disabled: boolean;
  onPrimaryChange: (selection: TextModelSelection) => void;
  onFallbackChange: (selection: TextModelSelection) => void;
}) {
  return (
    <div className="quality-model-pair">
      <div>
        <small>Primary</small>
        <ModelSelectionField
          label={label}
          hideLabel
          selection={primary}
          options={options}
          disabled={disabled}
          onChange={onPrimaryChange}
        />
      </div>
      <div>
        <small>Fallback</small>
        <ModelSelectionField
          label={`${label} fallback`}
          hideLabel
          selection={fallback}
          options={options}
          disabled={disabled}
          onChange={onFallbackChange}
        />
      </div>
    </div>
  );
}

export function ModelSelectionField({
  label,
  hideLabel = false,
  selection,
  options,
  disabled,
  onChange
}: {
  label: string;
  hideLabel?: boolean;
  selection: TextModelSelection;
  options: GenerationTextModelOption[];
  disabled: boolean;
  onChange: (selection: TextModelSelection) => void;
}) {
  const option = optionForSelection(options, selection);
  const unavailable = !option;
  const choices = unavailable
    ? [{ ...selection, label: `${selection.provider}/${selection.model} (unavailable)` }, ...options]
    : options;
  const efforts = option?.thinkingEfforts ?? [];
  return (
    <div className="quality-model-field">
      <label>
        <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
        <select
          aria-label={label}
          value={option ? generationTextModelOptionKey(option) : generationTextModelOptionKey(selection)}
          disabled={disabled}
          onChange={(event) => {
            const selected = choices.find((candidate) => generationTextModelOptionKey(candidate) === event.target.value);
            if (selected) onChange(selectionFromGenerationOption(selected));
          }}
        >
          {choices.map((choice) => (
            <option
              key={generationTextModelOptionKey(choice)}
              value={generationTextModelOptionKey(choice)}
              disabled={unavailable && choice === choices[0]}
            >
              {choice.label}{modelCostSuffix(choice.costs)}
            </option>
          ))}
        </select>
      </label>
      {option?.costs !== undefined ? (
        <span className={`quality-model-cost${option.costs.length === 0 ? " is-unpriced" : ""}`}>
          {option.costs.length > 0 ? modelCostSummary(option.costs) : "Rate-card pricing unavailable"}
        </span>
      ) : null}
      {unavailable ? (
        <span className="quality-model-warning" role="status">
          <AlertTriangle size={14} aria-hidden /> Saved provider credentials are unavailable.
        </span>
      ) : null}
      {efforts.length > 0 ? (
        <label className="quality-model-effort">
          Effort
          <select
            aria-label={`${label} Effort`}
            value={selection.thinkingEffort ?? defaultEffort(option!)}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...selectionFromGenerationOption(option!), thinkingEffort: event.target.value as TextModelThinkingEffort })
            }
          >
            {efforts.map((effort) => (
              <option key={effort.value} value={effort.value}>{effort.label}</option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

export function generationModelRoutingClaim(
  stored: GenerationTextModelRouting,
  draft: GenerationTextModelRouting
): GenerationModelRoutingPatch | null {
  const patch: GenerationModelRoutingPatch = {};
  const fast = selectionDiff(stored.fastJudgments, draft.fastJudgments);
  if (fast) patch.fastJudgments = fast;
  const fastFallback = selectionDiff(stored.fastJudgmentsFallback, draft.fastJudgmentsFallback);
  if (fastFallback) patch.fastJudgmentsFallback = fastFallback;
  for (const tier of GENERATION_TEXT_MODEL_TIERS) {
    const tierPatch: Partial<Record<GenerationTextModelRouteField, Partial<TextModelSelection>>> = {};
    for (const field of GENERATION_TEXT_MODEL_ROUTE_FIELDS) {
      const leaf = selectionDiff(stored[tier][field], draft[tier][field]);
      if (leaf) tierPatch[field] = leaf;
    }
    if (Object.keys(tierPatch).length > 0) patch[tier] = tierPatch;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Head values for untouched leaves, operator values for leaves they changed. */
export function rebaseGenerationModelRouting(
  head: GenerationTextModelRouting,
  loaded: GenerationTextModelRouting,
  draft: GenerationTextModelRouting
): GenerationTextModelRouting {
  const rebased = cloneGenerationModelRouting(head);
  if (selectionDiff(loaded.fastJudgments, draft.fastJudgments)) rebased.fastJudgments = { ...draft.fastJudgments };
  if (selectionDiff(loaded.fastJudgmentsFallback, draft.fastJudgmentsFallback)) {
    rebased.fastJudgmentsFallback = { ...draft.fastJudgmentsFallback };
  }
  for (const tier of GENERATION_TEXT_MODEL_TIERS) {
    for (const field of GENERATION_TEXT_MODEL_ROUTE_FIELDS) {
      if (selectionDiff(loaded[tier][field], draft[tier][field])) {
        rebased[tier][field] = { ...draft[tier][field] };
      }
    }
  }
  return rebased;
}

export function cloneGenerationModelRouting(models: GenerationTextModelRouting): GenerationTextModelRouting {
  return {
    fastJudgments: { ...models.fastJudgments },
    fastJudgmentsFallback: { ...models.fastJudgmentsFallback },
    fast: cloneTier(models.fast),
    balanced: cloneTier(models.balanced),
    premium: cloneTier(models.premium),
    ultra: cloneTier(models.ultra)
  };
}

export function readGenerationModelRouting(value: unknown): GenerationTextModelRouting | null {
  const candidate = record(value);
  if (!candidate) return null;
  const fastJudgments = readTextModelSelection(candidate.fastJudgments);
  const fastJudgmentsFallback = readTextModelSelection(candidate.fastJudgmentsFallback);
  const fast = readTierModels(candidate.fast);
  const balanced = readTierModels(candidate.balanced);
  const premium = readTierModels(candidate.premium);
  const ultra = readTierModels(candidate.ultra);
  return fastJudgments && fastJudgmentsFallback && fast && balanced && premium && ultra
    ? { fastJudgments, fastJudgmentsFallback, fast, balanced, premium, ultra }
    : null;
}

export function readGenerationModelOptions(value: unknown): GenerationTextModelOption[] | null {
  if (!Array.isArray(value)) return null;
  const options: GenerationTextModelOption[] = [];
  for (const entry of value) {
    const selection = readTextModelSelection(entry);
    const candidate = record(entry);
    if (!selection || !candidate || typeof candidate.label !== "string") return null;
    const efforts = candidate.thinkingEfforts;
    const costs = candidate.costs;
    if (
      efforts !== undefined &&
      (!Array.isArray(efforts) || efforts.some((effort) => !validEffortEntry(effort)))
    ) return null;
    if (costs !== undefined && (!Array.isArray(costs) || costs.some((cost) => !validCostEntry(cost)))) return null;
    options.push({
      ...selection,
      label: candidate.label,
      ...(Array.isArray(costs)
        ? {
            costs: costs.map((cost) => {
              const rate = cost as Record<string, number | string | undefined>;
              return {
                inputPerMillion: rate.inputPerMillion as number,
                outputPerMillion: rate.outputPerMillion as number,
                ...(typeof rate.cacheHitPerMillion === "number" ? { cacheHitPerMillion: rate.cacheHitPerMillion } : {}),
                ...(typeof rate.cacheWritePerMillion === "number" ? { cacheWritePerMillion: rate.cacheWritePerMillion } : {}),
                ...(typeof rate.label === "string" ? { label: rate.label } : {})
              };
            })
          }
        : {}),
      ...(candidate.preview === true ? { preview: true } : {}),
      ...(candidate.thinking === true ? { thinking: true } : {}),
      ...(Array.isArray(efforts)
        ? {
            thinkingEfforts: efforts.map((effort) => ({
              value: (effort as { value: TextModelThinkingEffort }).value,
              label: (effort as { label: string }).label,
              ...((effort as { default?: unknown }).default === true ? { default: true } : {})
            }))
          }
        : {})
    });
  }
  return options;
}

function readTierModels(value: unknown): GenerationTextModelRouting["fast"] | null {
  const candidate = record(value);
  if (!candidate) return null;
  const writer = readTextModelSelection(candidate.writer);
  const writerFallback = readTextModelSelection(candidate.writerFallback);
  const judgment = readTextModelSelection(candidate.judgment);
  const judgmentFallback = readTextModelSelection(candidate.judgmentFallback);
  return writer && writerFallback && judgment && judgmentFallback
    ? { writer, writerFallback, judgment, judgmentFallback }
    : null;
}

function readTextModelSelection(value: unknown): TextModelSelection | null {
  return parseTextModelSelection(value) ?? null;
}

function validEffortEntry(value: unknown): value is { value: string; label: string; default?: unknown } {
  const candidate = record(value);
  return Boolean(candidate && typeof candidate.value === "string" && typeof candidate.label === "string");
}

function validCostEntry(value: unknown): boolean {
  const candidate = record(value);
  return Boolean(
    candidate &&
    nonNegativeFinite(candidate.inputPerMillion) &&
    nonNegativeFinite(candidate.outputPerMillion) &&
    optionalNonNegativeFinite(candidate.cacheHitPerMillion) &&
    optionalNonNegativeFinite(candidate.cacheWritePerMillion) &&
    (candidate.label === undefined || typeof candidate.label === "string")
  );
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalNonNegativeFinite(value: unknown): boolean {
  return value === undefined || nonNegativeFinite(value);
}

function cloneTier(tier: GenerationTextModelRouting[ModelTier]) {
  return {
    writer: { ...tier.writer },
    writerFallback: { ...tier.writerFallback },
    judgment: { ...tier.judgment },
    judgmentFallback: { ...tier.judgmentFallback }
  };
}

function selectionDiff(stored: TextModelSelection, draft: TextModelSelection): Partial<TextModelSelection> | null {
  const moved: Record<string, unknown> = {};
  for (const key of ["provider", "model", "thinkingBudget", "thinkingEnabled", "thinkingEffort"] as const) {
    if (stored[key] !== draft[key]) {
      // Provider/model changes submit a complete leaf identity; optional fields
      // are catalog-controlled and therefore need no explicit deletion token.
      if (draft[key] !== undefined) moved[key] = draft[key];
    }
  }
  if ((moved.provider || moved.model) && (!moved.provider || !moved.model)) {
    moved.provider = draft.provider;
    moved.model = draft.model;
  }
  return Object.keys(moved).length > 0 ? (moved as Partial<TextModelSelection>) : null;
}

function optionForSelection(options: GenerationTextModelOption[], selection: TextModelSelection) {
  const exact = options.find((option) => generationTextModelOptionKey(option) === generationTextModelOptionKey(selection));
  if (exact) return exact;

  // The historical Quick/Judgment defaults spell disabled DeepSeek thinking
  // as `thinkingEnabled:false`. The editable catalog exposes the same choice
  // as its discrete `none` effort, so credentials are still available even
  // though the capability-aware spelling differs.
  if (
    selection.thinkingEnabled === false &&
    selection.thinkingBudget === undefined &&
    selection.thinkingEffort === undefined
  ) {
    return options.find(
      (option) =>
        option.provider === selection.provider &&
        option.model === selection.model &&
        option.thinkingEnabled === undefined &&
        option.thinkingBudget === undefined &&
        option.thinkingEfforts?.some((effort) => effort.value === "none")
    );
  }
  return undefined;
}

function defaultEffort(option: GenerationTextModelOption): TextModelThinkingEffort {
  return option.thinkingEfforts?.find((effort) => effort.default)?.value ?? option.thinkingEfforts?.[0]?.value ?? "none";
}

function modelCostSuffix(costs: GenerationTextModelOption["costs"]): string {
  return costs && costs.length > 0 ? ` — ${modelCostSummary(costs)}` : "";
}

function modelCostSummary(costs: NonNullable<GenerationTextModelOption["costs"]>): string {
  const inputs = costs.map((cost) => cost.inputPerMillion);
  const outputs = costs.map((cost) => cost.outputPerMillion);
  if (inputs.every((cost) => cost === 0) && outputs.every((cost) => cost === 0)) {
    return "No marginal API cost";
  }
  return `Input ${costRange(inputs)} · output ${costRange(outputs)} / 1M tokens`;
}

function costRange(costs: number[]): string {
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  return min === max ? formatUsd(min) : `${formatUsd(min)}–${formatUsd(max)}`;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 3
  }).format(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
