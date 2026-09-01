import {
  PAGE_REVIEW_PROMPT_MODES,
  PAGE_REVIEW_PROMPT_MODE_DEFAULTS,
  QUALITY_EFFORT_TIERS,
  type PageReviewPromptMode,
  type PageReviewPromptModes,
  type QualityEffortTier
} from "@book-maker/core/qualityGates";

/** An effort tier this console labels, or one observed from a newer server. */
export type ServerEffortTier = QualityEffortTier | (string & {});

/** Keyed rather than listed, so a tier core renames stops compiling here. */
const TIER_LABELS: Record<QualityEffortTier, string> = {
  ultra: "Ultra",
  premium: "Premium",
  balanced: "Balanced",
  fast: "Quick draft"
};

/** The known choices plus any active tier string observed from a newer server. */
export function qualityTierChoices(
  assigned: readonly ServerEffortTier[]
): Array<{ tier: ServerEffortTier; label: string }> {
  const choices: Array<{ tier: ServerEffortTier; label: string }> = QUALITY_EFFORT_TIERS.map(
    (tier) => ({ tier, label: TIER_LABELS[tier] })
  );
  const seen = new Set<string>(QUALITY_EFFORT_TIERS);
  for (const tier of assigned) {
    if (!seen.has(tier)) {
      seen.add(tier);
      choices.push({ tier, label: `Unknown tier · ${tier}` });
    }
  }
  return choices;
}

/** Presence is the toggle: removing an unknown tier makes it postable to this build again. */
export function toggleQualityTier(
  assigned: readonly ServerEffortTier[],
  tier: ServerEffortTier
): ServerEffortTier[] {
  return assigned.includes(tier)
    ? assigned.filter((item) => item !== tier)
    : [...assigned, tier];
}

/** Kept small and exported so forward-compatible tier rendering has a direct UI regression test. */
export function QualityTierFieldset({
  label,
  assigned,
  disabled = false,
  onToggle
}: {
  label: string;
  assigned: ServerEffortTier[];
  disabled?: boolean;
  onToggle: (tier: ServerEffortTier) => void;
}) {
  return (
    <fieldset className="quality-gate-tiers" aria-label={label} disabled={disabled}>
      {qualityTierChoices(assigned).map((choice) => (
        <label key={choice.tier}>
          <input
            type="checkbox"
            checked={assigned.includes(choice.tier)}
            onChange={() => onToggle(choice.tier)}
          />
          {choice.label}
        </label>
      ))}
    </fieldset>
  );
}

export function PageReviewPromptModeControls({
  modes,
  disabled = false,
  onChange
}: {
  modes: PageReviewPromptModes;
  disabled?: boolean;
  onChange: (tier: QualityEffortTier, mode: PageReviewPromptMode) => void;
}) {
  return (
    <fieldset className="quality-review-prompt-modes" disabled={disabled}>
      <legend>Model page review prompt mode</legend>
      <small>Compact keeps the current page assignment and adjacent continuity while shortening repeated context.</small>
      {QUALITY_EFFORT_TIERS.map((tier) => (
        <label key={tier}>
          {TIER_LABELS[tier]}
          <select
            aria-label={`${TIER_LABELS[tier]} model page review mode`}
            value={modes[tier]}
            onChange={(event) => onChange(tier, event.target.value as PageReviewPromptMode)}
          >
            <option value="normal">Normal</option>
            <option value="compact">Compact</option>
          </select>
        </label>
      ))}
    </fieldset>
  );
}

export function readPageReviewPromptModes(value: unknown): PageReviewPromptModes {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return Object.fromEntries(
    QUALITY_EFFORT_TIERS.map((tier) => {
      const mode = record[tier];
      return [
        tier,
        typeof mode === "string" && (PAGE_REVIEW_PROMPT_MODES as readonly string[]).includes(mode)
          ? mode
          : PAGE_REVIEW_PROMPT_MODE_DEFAULTS[tier]
      ];
    })
  ) as PageReviewPromptModes;
}

/** Keep local edits while adopting every prompt-mode change that landed underneath them. */
export function rebasePageReviewPromptModes(
  head: PageReviewPromptModes,
  loaded: PageReviewPromptModes,
  draft: PageReviewPromptModes
): PageReviewPromptModes {
  return Object.fromEntries(
    QUALITY_EFFORT_TIERS.map((tier) => [
      tier,
      draft[tier] === loaded[tier] ? head[tier] : draft[tier]
    ])
  ) as PageReviewPromptModes;
}
