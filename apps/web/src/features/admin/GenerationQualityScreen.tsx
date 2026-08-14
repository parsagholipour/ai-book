import { Loader2, RotateCcw, Save, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPatch, apiPost } from "../../api.js";
import { Button } from "../shared/Button.js";
import { readError } from "../shared/formatters.js";

type EffortTier = "ultra" | "premium" | "balanced" | "fast";

type QualityFeatureId =
  | "storyExtractAudit"
  | "planCritic"
  | "claimVerifier"
  | "styleExcerpts"
  | "styleAuditor"
  | "pageMapCritic"
  | "writerTools"
  | "bestOfPolish"
  | "planThinkingBoost"
  | "claimRetrieve";

type QualitySettings = Record<QualityFeatureId, EffortTier[]>;

type QualityFeature = {
  id: QualityFeatureId;
  label: string;
  summary: string;
};

type GenerationQuality = {
  version: number;
  settings: QualitySettings;
  usingCompiledDefaults: boolean;
  features: QualityFeature[];
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

const TIER_LABELS: Array<{ id: EffortTier; label: string }> = [
  { id: "ultra", label: "Ultra" },
  { id: "premium", label: "Premium" },
  { id: "balanced", label: "Balanced" },
  { id: "fast", label: "Quick draft" }
];

export function GenerationQualityScreen() {
  const [state, setState] = useState<GenerationQuality | null>(null);
  const [draft, setDraft] = useState<QualitySettings | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    void apiGet<GenerationQuality>("/api/admin/generation-quality")
      .then((value) => {
        setState(value);
        setDraft(cloneSettings(value.settings));
      })
      .catch((loadError) => setError(readError(loadError)));
  }, []);

  const changed = useMemo(() => {
    if (!state || !draft) {
      return false;
    }
    return JSON.stringify(draft) !== JSON.stringify(state.settings);
  }, [draft, state]);

  function toggle(feature: QualityFeatureId, tier: EffortTier) {
    setDraft((current) => {
      if (!current) {
        return current;
      }
      const assigned = current[feature].includes(tier)
        ? current[feature].filter((item) => item !== tier)
        : [...current[feature], tier];
      return { ...current, [feature]: assigned };
    });
    setSaved(null);
  }

  async function save() {
    if (!changed || !draft || busy) {
      return;
    }
    setBusy(true);
    try {
      const value = await apiPatch<GenerationQuality>("/api/admin/generation-quality", {
        ...draft,
        ...(note.trim() ? { note: note.trim() } : {})
      });
      setState(value);
      setDraft(cloneSettings(value.settings));
      setNote("");
      setError(null);
      setSaved(`Saved as generation quality version ${value.version}.`);
    } catch (saveError) {
      setError(readError(saveError));
      setSaved(null);
    } finally {
      setBusy(false);
    }
  }

  async function resetToDefaults() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const value = await apiPost<GenerationQuality>(
        "/api/admin/generation-quality/reset",
        note.trim() ? { note: note.trim() } : {}
      );
      setState(value);
      setDraft(cloneSettings(value.settings));
      setNote("");
      setError(null);
      setSaved(`Reset to compiled defaults as version ${value.version}.`);
    } catch (resetError) {
      setError(readError(resetError));
      setSaved(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-page">
      {error ? <div className="error-banner">{error}</div> : null}
      {saved ? <div className="pricing-saved">{saved}</div> : null}
      {!state || !draft ? (
        <div className="empty-state">
          <Loader2 className="spin" size={20} aria-hidden /> Loading quality gates…
        </div>
      ) : (
        <div className="admin-columns-2">
          <section className="work-section safety-settings-card">
            <div className="section-title">
              <Sparkles size={18} aria-hidden />
              <h3>Generation quality gates</h3>
            </div>
            <p className="muted">
              Each row can run on any subset of Effort tiers. Deselect all four and that feature is
              off for the next page, plan, or map step — live, not stamped at enqueue.
            </p>
            <ul className="quality-gate-list">
              {state.features.map((feature) => {
                const assigned = draft[feature.id] ?? [];
                const off = assigned.length === 0;
                return (
                  <li key={feature.id} className={`quality-gate-row${off ? " is-off" : ""}`}>
                    <div>
                      <strong>
                        {feature.label}
                        {off ? <span className="quality-gate-off">Off</span> : null}
                      </strong>
                      <small>{feature.summary}</small>
                    </div>
                    <fieldset className="quality-gate-tiers" aria-label={feature.label}>
                      {TIER_LABELS.map((tier) => (
                        <label key={tier.id}>
                          <input
                            type="checkbox"
                            checked={assigned.includes(tier.id)}
                            onChange={() => toggle(feature.id, tier.id)}
                          />
                          {tier.label}
                        </label>
                      ))}
                    </fieldset>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="tool-panel safety-settings-card">
            <div className="panel-title">
              <Save size={18} aria-hidden />
              <h2>Publish change</h2>
            </div>
            <p className="muted">
              Current version {state.version}
              {state.usingCompiledDefaults
                ? " · using compiled defaults"
                : state.updatedAt
                  ? ` · ${new Date(state.updatedAt).toLocaleString()}`
                  : ""}
              . Changes apply to the next in-flight page immediately.
            </p>
            <label>
              Change note
              <input
                value={note}
                maxLength={500}
                placeholder="Why is this setting changing?"
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <Button
              variant="primary"
              fullWidth
              disabled={!changed || busy}
              loading={busy}
              loadingLabel="Saving quality gates…"
              startIcon={<Save />}
              onClick={() => void save()}
            >
              Save setting
            </Button>
            <Button
              variant="secondary"
              fullWidth
              disabled={busy}
              startIcon={<RotateCcw />}
              onClick={() => void resetToDefaults()}
            >
              Reset to defaults
            </Button>
          </section>
        </div>
      )}
    </div>
  );
}

function cloneSettings(settings: QualitySettings): QualitySettings {
  return Object.fromEntries(
    Object.entries(settings).map(([id, tiers]) => [id, [...tiers]])
  ) as QualitySettings;
}
