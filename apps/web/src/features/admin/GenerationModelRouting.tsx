import { AlertTriangle, Cpu } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "../shared/Button.js";
import { GENERATION_STAGE_EFFORT } from "./generationStageEffort.js";
import {
  JEV_SELECTION,
  isJevSelection,
  parseDecisionModelSelection,
  type DecisionModelSelection,
  GENERATION_TEXT_MODEL_ROUTE_FIELDS,
  GENERATION_TEXT_MODEL_TIERS,
  GENERATION_MODEL_STAGES,
  generationStageRoute,
  stageSupportsFiniteDecisions,
  type GenerationModelStageId,
  type GenerationStageRoutes,
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

type TierModelPatch = Partial<Record<GenerationTextModelRouteField, Partial<TextModelSelection>>> & {
  stages?: Partial<Record<GenerationModelStageId, { primary?: Partial<TextModelSelection> | typeof JEV_SELECTION; fallback?: Partial<TextModelSelection> }>>;
};
export type GenerationModelRoutingPatch = {
  fastDecisions?: DecisionModelSelection | null;
  fastDecisionsFallback?: Partial<TextModelSelection>;
  fastJudgments?: Partial<TextModelSelection> | undefined;
  fastJudgmentsFallback?: Partial<TextModelSelection> | undefined;
  fast?: TierModelPatch | undefined;
  balanced?: TierModelPatch | undefined;
  premium?: TierModelPatch | undefined;
  ultra?: TierModelPatch | undefined;
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
  jevAvailable = false,
  jevCosts,
  disabled,
  onChange
}: {
  models: GenerationTextModelRouting;
  jevAvailable?: boolean;
  jevCosts?: GenerationTextModelOption["costs"];
  options: GenerationTextModelOption[];
  disabled: boolean;
  onChange: (next: GenerationTextModelRouting) => void;
}) {
  const [stageTier, setStageTier] = useState<ModelTier>("ultra");
  const updateStage = (id: GenerationModelStageId, field: "primary" | "fallback", selection: DecisionModelSelection) => {
    if (field === "fallback" && isJevSelection(selection)) return;
    const route = generationStageRoute(models, stageTier, id);
    onChange({ ...models, [stageTier]: { ...models[stageTier], stages: {
      ...models[stageTier].stages, [id]: { ...route, [field]: selection }
    } } });
  };
  const update = (tier: ModelTier, field: GenerationTextModelRouteField, selection: TextModelSelection) => {
    onChange({ ...models, [tier]: { ...models[tier], [field]: selection } });
  };
  return (
    <section className="work-section safety-settings-card quality-model-routing">
      <div className="section-title">
        <Cpu size={18} aria-hidden />
        <h3>Models and reasoning by stage</h3>
      </div>
      <p className="muted">
        Choose the model and reasoning for each stage. Saved choices apply exactly, including to existing projects.
        Changes apply to calls started after saving; calls already running keep their settings.
        Availability failures use the selected fallback. Prices are USD per million tokens.
      </p>
      <div className="quality-stage-tier-picker" role="group" aria-label="Stage settings tier">
        {GENERATION_TEXT_MODEL_TIERS.map((tier) => <button key={tier} type="button" disabled={disabled} aria-pressed={tier === stageTier}
          onClick={() => setStageTier(tier)}>{TIER_LABELS[tier]}</button>)}
      </div>
      <p className="muted">{TIER_LABELS[stageTier]} stage settings. Stages run when their pipeline and quality gates are enabled.</p>
      <SetAllStages key={stageTier} models={models} tier={stageTier} options={options} disabled={disabled} onChange={onChange} />
      <p className="muted">
        Recommended effort is a starting point for text models: 1 = lightest reasoning, 10 = deepest reasoning.
        Scores reflect the stage's task across all tiers. Choose from your model's supported effort options;
        recommendations only affect your draft when you apply a rule above.
      </p>
      {[...new Set(GENERATION_MODEL_STAGES.map((stage) => stage.group))].map((group) => <details key={group}
        className="quality-stage-group" open={group === "Planning" || group === "Chapters"}>
        <summary>{group}</summary>
        {GENERATION_MODEL_STAGES.filter((stage) => stage.group === group).map((stage) => {
          const route = generationStageRoute(models, stageTier, stage.id);
          const effort = GENERATION_STAGE_EFFORT[stage.id];
          return <div key={stage.id} className="quality-stage-row">
            <div className="quality-stage-heading">
              <h4>{stage.label}</h4>
              <span className="quality-stage-effort">Recommended effort: <strong>{effort.score}/10</strong></span>
            </div>
            <p className="quality-stage-effort-reason muted">{effort.reason}</p>
            <div className="quality-model-pair">
              <div><small>Primary</small>
                {stageSupportsFiniteDecisions(stage.id) && <label className="quality-model-field">Model type
                  <select aria-label={`${TIER_LABELS[stageTier]} ${stage.label} Model type`} disabled={disabled}
                    value={isJevSelection(route.primary) ? "jev" : "text"}
                    onChange={(event) => updateStage(stage.id, "primary", event.target.value === "jev" ? JEV_SELECTION : route.fallback)}>
                    <option value="text">Text model</option>
                    <option value="jev" disabled={!jevAvailable}>Jev · TypeSafe{!jevAvailable ? " (unavailable)" : modelCostSuffix(jevCosts)}</option>
                  </select>
                </label>}
                {isJevSelection(route.primary) ? <small>Finite choices; low confidence or failure uses this stage&apos;s fallback.</small> :
                  <ModelSelectionField label={`${TIER_LABELS[stageTier]} ${stage.label}`} hideLabel selection={route.primary}
                    options={options} disabled={disabled} onChange={(selection) => updateStage(stage.id, "primary", selection)} />}
              </div>
              <div><small>Fallback</small><ModelSelectionField label={`${TIER_LABELS[stageTier]} ${stage.label} fallback`} hideLabel
                selection={route.fallback} options={options} disabled={disabled} onChange={(selection) => updateStage(stage.id, "fallback", selection)} /></div>
            </div>
          </div>;
        })}
      </details>)}
      <details className="quality-stage-group">
      <summary>Inline calls and defaults for new stages</summary>
      <p className="muted">These defaults seed stages in older settings and handle unlisted operations. Changing a default does not change saved stage settings.</p>
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
      <FastDecisionFields models={models} options={options} jevAvailable={jevAvailable} jevCosts={jevCosts} disabled={disabled} onChange={onChange} />
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
      </details>
    </section>
  );
}

type StageModelTarget = "primary" | "fallback" | "both";
export type GenerationStageEffortRule = { minScore: number; maxScore: number; selection: TextModelSelection };
type DraftEffortRule = GenerationStageEffortRule & { id: number };

function SetAllStages({ models, tier, options, disabled, onChange }: {
  models: GenerationTextModelRouting;
  tier: ModelTier;
  options: GenerationTextModelOption[];
  disabled: boolean;
  onChange: (next: GenerationTextModelRouting) => void;
}) {
  const initial = generationStageRoute(models, tier, "plan-book");
  const [selection, setSelection] = useState<TextModelSelection>(() => {
    const selected = isJevSelection(initial.primary) ? initial.fallback : initial.primary;
    const option = optionForSelection(options, selected);
    if (!option) return selected;
    const effort = selected.thinkingEffort ?? (selected.thinkingEnabled === false && option.thinkingEfforts?.some((entry) => entry.value === "none") ? "none" : undefined);
    // Applying to mixed stages needs an explicit catalog setting, not an omitted effort that a PATCH cannot clear.
    return { ...selectionFromGenerationOption(option), ...(effort ? { thinkingEffort: effort } : {}) };
  });
  const [target, setTarget] = useState<StageModelTarget>("primary");
  const [rules, setRules] = useState<DraftEffortRule[]>([]);
  const nextRuleId = useRef(0);
  const [applied, setApplied] = useState<string | null>(null);
  const invalidRules = rules.some((rule) => rule.minScore > rule.maxScore) || rules.some((rule, index) =>
    rules.slice(index + 1).some((other) => rule.minScore <= other.maxScore && other.minScore <= rule.maxScore));
  const matchingStages = rules.length === 0 ? GENERATION_MODEL_STAGES.length : GENERATION_MODEL_STAGES.filter(({ id }) =>
    rules.some((rule) => rule.minScore <= GENERATION_STAGE_EFFORT[id].score && GENERATION_STAGE_EFFORT[id].score <= rule.maxScore)).length;
  const availableRange = nextEffortRuleRange(rules);
  const updateRule = (id: number, change: Partial<GenerationStageEffortRule>) => {
    setRules((current) => current.map((rule) => rule.id === id ? { ...rule, ...change } : rule));
    setApplied(null);
  };
  return <div className="quality-stage-bulk" role="group" aria-label="Set all stages">
    <h4>Set all stages</h4>
    <p className="muted">Apply one model and reasoning setting to all {GENERATION_MODEL_STAGES.length} {TIER_LABELS[tier]} stages, or add optional rules for recommended effort ranges. You can adjust individual stages afterward, then save.</p>
    <div className="quality-stage-bulk-controls">
      <label className="quality-model-field">Apply to
        <select aria-label="Set all stages target" disabled={disabled} value={target} onChange={(event) => {
          setTarget(event.target.value as StageModelTarget);
          setApplied(null);
        }}>
          <option value="primary">Primary models</option>
          <option value="fallback">Fallback models</option>
          <option value="both">Primary and fallback models</option>
        </select>
      </label>
      {rules.length === 0 && <ModelSelectionField label="Set all stages model" selection={selection} options={options} disabled={disabled}
        onChange={(next) => { setSelection(next); setApplied(null); }} />}
      <Button variant="secondary" disabled={disabled || invalidRules || matchingStages === 0 ||
        (rules.length === 0 ? !optionForSelection(options, selection) : rules.some((rule) => !optionForSelection(options, rule.selection)))} onClick={() => {
        onChange(rules.length === 0
          ? setAllGenerationStageModels(models, tier, target, selection)
          : setGenerationStageModelsByEffortRules(models, tier, target, rules));
        setApplied(`Updated ${matchingStages} ${TIER_LABELS[tier]} stages in your draft.`);
      }}>{rules.length === 0 ? `Set all ${TIER_LABELS[tier]} stages` : `Apply rules to ${TIER_LABELS[tier]} stages`}</Button>
    </div>
    {rules.map((rule, index) => <div className="quality-stage-bulk-rule" role="group" aria-label={`Recommended effort rule ${index + 1}`} key={rule.id}>
      <label className="quality-model-field">Recommended effort from
        <select aria-label={`Rule ${index + 1} minimum recommended effort`} disabled={disabled} value={rule.minScore}
          onChange={(event) => updateRule(rule.id, { minScore: Number(event.target.value) })}>
          {Array.from({ length: 10 }, (_, score) => <option key={score + 1} value={score + 1}>{score + 1}</option>)}
        </select>
      </label>
      <label className="quality-model-field">To
        <select aria-label={`Rule ${index + 1} maximum recommended effort`} disabled={disabled} value={rule.maxScore}
          onChange={(event) => updateRule(rule.id, { maxScore: Number(event.target.value) })}>
          {Array.from({ length: 10 }, (_, score) => <option key={score + 1} value={score + 1}>{score + 1}</option>)}
        </select>
      </label>
      <ModelSelectionField label={`Rule ${index + 1} model`} selection={rule.selection} options={options} disabled={disabled}
        onChange={(next) => updateRule(rule.id, { selection: next })} />
      <Button variant="secondary" disabled={disabled} onClick={() => {
        setRules((current) => current.filter((entry) => entry.id !== rule.id));
        setApplied(null);
      }}>Remove rule {index + 1}</Button>
    </div>)}
    <Button variant="secondary" disabled={disabled || !availableRange} onClick={() => {
      if (!availableRange) return;
      setRules((current) => [...current, { id: ++nextRuleId.current, ...availableRange,
        selection: { ...(current.at(-1)?.selection ?? selection) } }]);
      setApplied(null);
    }}>Add recommended effort rule</Button>
    {rules.length > 0 && <p className="muted">Rules apply to {matchingStages} {TIER_LABELS[tier]} stages. Stages outside the ranges keep their draft settings.</p>}
    {invalidRules && <p role="alert">Rule ranges must start at or below their end and must not overlap.</p>}
    {applied && <p role="status">{applied}</p>}
  </div>;
}

function nextEffortRuleRange(rules: readonly GenerationStageEffortRule[]): { minScore: number; maxScore: number } | null {
  if (rules.length === 0) return { minScore: 1, maxScore: 5 };
  const covered = (score: number) => rules.some((rule) => rule.minScore <= score && score <= rule.maxScore);
  let minScore = 1;
  while (minScore <= 10 && covered(minScore)) minScore++;
  if (minScore > 10) return null;
  let maxScore = minScore;
  while (maxScore < 10 && !covered(maxScore + 1)) maxScore++;
  return { minScore, maxScore };
}

export function setAllGenerationStageModels(
  models: GenerationTextModelRouting,
  tier: ModelTier,
  target: StageModelTarget,
  selection: TextModelSelection
): GenerationTextModelRouting {
  return updateStageModels(models, tier, target, () => selection);
}

export function setGenerationStageModelsByEffortRules(
  models: GenerationTextModelRouting,
  tier: ModelTier,
  target: StageModelTarget,
  rules: readonly GenerationStageEffortRule[]
): GenerationTextModelRouting {
  return updateStageModels(models, tier, target, (id) => {
    const score = GENERATION_STAGE_EFFORT[id].score;
    return rules.find((rule) => rule.minScore <= score && score <= rule.maxScore)?.selection;
  });
}

function updateStageModels(
  models: GenerationTextModelRouting,
  tier: ModelTier,
  target: StageModelTarget,
  selectionForStage: (id: GenerationModelStageId) => TextModelSelection | undefined
): GenerationTextModelRouting {
  const stages = { ...models[tier].stages };
  for (const { id } of GENERATION_MODEL_STAGES) {
    const selection = selectionForStage(id);
    if (!selection) continue;
    const current = generationStageRoute(models, tier, id);
    stages[id] = {
      primary: { ...(target === "fallback" ? current.primary : selection) },
      fallback: { ...(target === "primary" ? current.fallback : selection) }
    };
  }
  return { ...models, [tier]: { ...models[tier], stages } };
}

function FastDecisionFields({ models, options, jevAvailable, jevCosts, disabled, onChange }: {
  models: GenerationTextModelRouting;
  options: GenerationTextModelOption[];
  jevAvailable: boolean;
  jevCosts?: GenerationTextModelOption["costs"];
  disabled: boolean;
  onChange: (models: GenerationTextModelRouting) => void;
}) {
  const selected = models.fastDecisions ?? null;
  const isJev = isJevSelection(selected);
  const savedText = selected && !isJev ? `${selected.provider}/${selected.model}` : "";
  const key = !selected ? "" : isJev ? "jev" : savedText;
  return <div className="quality-model-fast">
    <div className="quality-model-field">
      <label><span>Fast decisions</span>
        <select aria-label="Fast decisions" disabled={disabled} value={key} onChange={(event) => {
          onChange(applyFastDecisionsPrimaryChange(models, event.target.value));
        }}>
          <option value="">Use existing judgment routes</option>
          {selected && isJev && !jevAvailable && <option disabled value="jev">Jev · TypeSafe (unavailable)</option>}
          {savedText ? <option disabled value={savedText}>{savedText}</option> : null}
          {jevAvailable && <option value="jev">Jev · TypeSafe{modelCostSuffix(jevCosts)}</option>}
        </select>
      </label>
      {selected && isJev && !jevAvailable && <span className="quality-model-warning" role="status">Saved provider credentials are unavailable.</span>}
    </div>
    <ModelSelectionField label="Fast decisions fallback" selection={models.fastDecisionsFallback ?? models.fastJudgments} options={options} disabled={disabled || !isJev} onChange={(selection) => onChange({ ...models, fastDecisionsFallback: selection })} />
    <small className="quality-model-fast-summary">Defaults for new draft-comparison stages and optional preliminary decision screens. Existing stage choices are independent; change a stage directly to choose Jev or a text model for it.</small>
  </div>;
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
            value={selection.thinkingEffort ?? (selection.thinkingEnabled === false ? "none" : "")}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...selectionFromGenerationOption(option!), thinkingEffort: event.target.value as TextModelThinkingEffort })
            }
          >
            <option value="" disabled>Provider default</option>
            {efforts.map((effort) => (
              <option key={effort.value} value={effort.value}>{effort.label}</option>
            ))}
          </select>
        </label>
      ) : null}
      {selection.thinkingBudget !== undefined ? <small>Reasoning token budget: {selection.thinkingBudget === -1 ? "Automatic" : selection.thinkingBudget}</small> : null}
      {efforts.length === 0 && selection.thinkingEnabled !== undefined ? <small>Reasoning {selection.thinkingEnabled ? "enabled" : "disabled"}</small> : null}
    </div>
  );
}

/** Off → Jev pins fallback to the current Fast judgments leaf; turning Off leaves fallback untouched. */
export function applyFastDecisionsPrimaryChange(
  models: GenerationTextModelRouting,
  value: string
): GenerationTextModelRouting {
  if (value === "jev") {
    return {
      ...models,
      fastDecisions: { ...JEV_SELECTION },
      ...(!isJevSelection(models.fastDecisions) ? { fastDecisionsFallback: { ...models.fastJudgments } } : {})
    };
  }
  return { ...models, fastDecisions: null };
}

export function generationModelRoutingClaim(
  stored: GenerationTextModelRouting,
  draft: GenerationTextModelRouting
): GenerationModelRoutingPatch | null {
  const patch: GenerationModelRoutingPatch = {};
  if (JSON.stringify(stored.fastDecisions ?? null) !== JSON.stringify(draft.fastDecisions ?? null)) patch.fastDecisions = draft.fastDecisions ?? null;
  if (isJevSelection(draft.fastDecisions)) {
    const decisionFallback = selectionDiff(stored.fastDecisionsFallback ?? stored.fastJudgments, draft.fastDecisionsFallback ?? draft.fastJudgments);
    if (decisionFallback) patch.fastDecisionsFallback = decisionFallback;
  }
  const fast = selectionDiff(stored.fastJudgments, draft.fastJudgments);
  if (fast) patch.fastJudgments = fast;
  const fastFallback = selectionDiff(stored.fastJudgmentsFallback, draft.fastJudgmentsFallback);
  if (fastFallback) patch.fastJudgmentsFallback = fastFallback;
  for (const tier of GENERATION_TEXT_MODEL_TIERS) {
    const tierPatch: TierModelPatch = {};
    for (const field of GENERATION_TEXT_MODEL_ROUTE_FIELDS) {
      const leaf = selectionDiff(stored[tier][field], draft[tier][field]);
      if (leaf) tierPatch[field] = leaf;
    }
    for (const { id } of GENERATION_MODEL_STAGES) {
      const next = draft[tier].stages?.[id];
      if (!next) continue;
      const previous = generationStageRoute(stored, tier, id);
      const primary = stagePrimaryDiff(previous.primary, next.primary);
      const fallback = selectionDiff(previous.fallback, next.fallback);
      if (primary || fallback) {
        tierPatch.stages ??= {};
        tierPatch.stages[id] = { ...(primary ? { primary } : {}), ...(fallback ? { fallback } : {}) };
      }
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
  if (JSON.stringify(loaded.fastDecisions ?? null) !== JSON.stringify(draft.fastDecisions ?? null)) rebased.fastDecisions = draft.fastDecisions ? { ...draft.fastDecisions } : null;
  if (selectionDiff(loaded.fastDecisionsFallback ?? loaded.fastJudgments, draft.fastDecisionsFallback ?? draft.fastJudgments)) rebased.fastDecisionsFallback = { ...(draft.fastDecisionsFallback ?? draft.fastJudgments) };
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
    for (const { id } of GENERATION_MODEL_STAGES) {
      const next = draft[tier].stages?.[id];
      if (!next) continue;
      const previous = generationStageRoute(loaded, tier, id);
      const route = generationStageRoute(head, tier, id);
      const primary = stagePrimaryDiff(previous.primary, next.primary);
      const fallback = selectionDiff(previous.fallback, next.fallback);
      if (primary || fallback) {
        rebased[tier].stages ??= {};
        rebased[tier].stages[id] = { primary: { ...(primary ? next.primary : route.primary) }, fallback: { ...(fallback ? next.fallback : route.fallback) } };
      }
    }
  }
  return rebased;
}

export function cloneGenerationModelRouting(models: GenerationTextModelRouting): GenerationTextModelRouting {
  return {
    ...(models.fastDecisions !== undefined ? { fastDecisions: models.fastDecisions ? { ...models.fastDecisions } : null } : {}),
    ...(models.fastDecisionsFallback ? { fastDecisionsFallback: { ...models.fastDecisionsFallback } } : {}),
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
  const fastDecisions = candidate.fastDecisions == null ? null : parseDecisionModelSelection(candidate.fastDecisions);
  const fastDecisionsFallback = candidate.fastDecisionsFallback === undefined ? undefined : readTextModelSelection(candidate.fastDecisionsFallback);
  if (fastDecisions === undefined || fastDecisionsFallback === null) return null;
  const fast = readTierModels(candidate.fast);
  const balanced = readTierModels(candidate.balanced);
  const premium = readTierModels(candidate.premium);
  const ultra = readTierModels(candidate.ultra);
  return fastJudgments && fastJudgmentsFallback && fast && balanced && premium && ultra
    ? { fastJudgments, fastJudgmentsFallback, fast, balanced, premium, ultra, ...(candidate.fastDecisions !== undefined ? { fastDecisions } : {}), ...(fastDecisionsFallback ? { fastDecisionsFallback } : {}) }
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
            costs: readGenerationModelCosts(costs)!
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

export function readGenerationModelCosts(value: unknown): GenerationTextModelOption["costs"] | null {
  if (!Array.isArray(value) || value.some((cost) => !validCostEntry(cost))) return null;
  return value.map((cost) => ({
    inputPerMillion: cost.inputPerMillion as number,
    outputPerMillion: cost.outputPerMillion as number,
    ...(typeof cost.cacheHitPerMillion === "number" ? { cacheHitPerMillion: cost.cacheHitPerMillion } : {}),
    ...(typeof cost.cacheWritePerMillion === "number" ? { cacheWritePerMillion: cost.cacheWritePerMillion } : {}),
    ...(typeof cost.label === "string" ? { label: cost.label } : {})
  }));
}

function readTierModels(value: unknown): GenerationTextModelRouting["fast"] | null {
  const candidate = record(value);
  if (!candidate) return null;
  const writer = readTextModelSelection(candidate.writer);
  const writerFallback = readTextModelSelection(candidate.writerFallback);
  const judgment = readTextModelSelection(candidate.judgment);
  const judgmentFallback = readTextModelSelection(candidate.judgmentFallback);
  const stages: GenerationStageRoutes = {};
  if (candidate.stages !== undefined) {
    const rawStages = record(candidate.stages);
    if (!rawStages) return null;
    for (const { id } of GENERATION_MODEL_STAGES) {
      if (rawStages[id] === undefined) continue;
      const raw = record(rawStages[id]);
      const primary = parseDecisionModelSelection(raw?.primary);
      const fallback = readTextModelSelection(raw?.fallback);
      if (!primary || !fallback || (isJevSelection(primary) && !stageSupportsFiniteDecisions(id))) return null;
      stages[id] = { primary, fallback };
    }
  }
  return writer && writerFallback && judgment && judgmentFallback
    ? { writer, writerFallback, judgment, judgmentFallback, ...(candidate.stages !== undefined ? { stages } : {}) }
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
    judgmentFallback: { ...tier.judgmentFallback },
    ...(tier.stages ? { stages: Object.fromEntries(Object.entries(tier.stages).map(([id, route]) => [id, { primary: { ...route.primary }, fallback: { ...route.fallback } }])) } : {})
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

function stagePrimaryDiff(stored: DecisionModelSelection, draft: DecisionModelSelection): Partial<TextModelSelection> | typeof JEV_SELECTION | null {
  if (isJevSelection(stored) || isJevSelection(draft)) return JSON.stringify(stored) === JSON.stringify(draft) ? null : { ...draft };
  return selectionDiff(stored, draft);
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
