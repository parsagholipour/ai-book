import { Loader2, Save, ShieldCheck, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { apiGet, apiPatch } from "../../api.js";
import { Button } from "../shared/Button.js";
import { readError } from "../shared/formatters.js";

export type SafetySettings = {
  version: number;
  copyrightRestrictionsEnabled: boolean;
  /** ON unless a revision turned it off; an API from before the switch omits it, which reads as ON. */
  sexualContentFilterEnabled?: boolean;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

export type SafetyDraft = { copyrightRestrictionsEnabled: boolean; sexualContentFilterEnabled: boolean };

export function draftFromSettings(settings: SafetySettings): SafetyDraft {
  return {
    copyrightRestrictionsEnabled: settings.copyrightRestrictionsEnabled,
    sexualContentFilterEnabled: settings.sexualContentFilterEnabled !== false
  };
}

export function safetyDraftChanged(settings: SafetySettings, draft: SafetyDraft): boolean {
  const saved = draftFromSettings(settings);
  return (
    saved.copyrightRestrictionsEnabled !== draft.copyrightRestrictionsEnabled ||
    saved.sexualContentFilterEnabled !== draft.sexualContentFilterEnabled
  );
}

/** The PATCH body: both switches, so a save is the whole revision the operator is looking at. */
export function safetySettingsPatch(draft: SafetyDraft, note: string): Record<string, unknown> {
  return { ...draft, ...(note.trim() ? { note: note.trim() } : {}) };
}

export function SafetySettingsScreen() {
  const [settings, setSettings] = useState<SafetySettings | null>(null);
  const [draft, setDraft] = useState<SafetyDraft>({ copyrightRestrictionsEnabled: false, sexualContentFilterEnabled: true });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    void apiGet<SafetySettings>("/api/admin/safety-settings")
      .then((value) => {
        setSettings(value);
        setDraft(draftFromSettings(value));
      })
      .catch((loadError) => setError(readError(loadError)));
  }, []);

  async function save() {
    if (!settings || !safetyDraftChanged(settings, draft) || busy) return;
    setBusy(true);
    try {
      const value = await apiPatch<SafetySettings>("/api/admin/safety-settings", safetySettingsPatch(draft, note));
      setSettings(value);
      setDraft(draftFromSettings(value));
      setNote("");
      setError(null);
      setSaved(`Saved as safety settings version ${value.version}.`);
    } catch (saveError) {
      setError(readError(saveError));
      setSaved(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-page">
      {error ? <div className="error-banner">{error}</div> : null}
      {saved ? <div className="pricing-saved">{saved}</div> : null}
      {!settings ? (
        <div className="empty-state">
          <Loader2 className="spin" size={20} aria-hidden /> Loading safety settings…
        </div>
      ) : (
        <SafetySettingsPanel
          settings={settings}
          draft={draft}
          note={note}
          busy={busy}
          onDraftChange={(next) => {
            setDraft(next);
            setSaved(null);
          }}
          onNoteChange={setNote}
          onSave={() => void save()}
        />
      )}
    </div>
  );
}

export function SafetySettingsPanel(props: {
  settings: SafetySettings;
  draft: SafetyDraft;
  note: string;
  busy: boolean;
  onDraftChange: (draft: SafetyDraft) => void;
  onNoteChange: (note: string) => void;
  onSave: () => void;
}) {
  const { settings, draft, busy } = props;
  const changed = safetyDraftChanged(settings, draft);
  return (
    <div className="admin-columns-2">
      <div>
        <section className="work-section safety-settings-card">
          <div className="section-title">
            <ShieldAlert size={18} aria-hidden />
            <h3>Sexual-content filter</h3>
          </div>
          <p className="muted">
            When on, every AI writing prompt is told never to write sexually explicit content or anything sexual or
            romantic involving anyone under 18, and book requests, chat edits and public shares are screened for it.
          </p>
          <label className="safety-toggle-row">
            <input
              type="checkbox"
              checked={draft.sexualContentFilterEnabled}
              onChange={(event) => props.onDraftChange({ ...draft, sexualContentFilterEnabled: event.target.checked })}
            />
            <span>
              <strong>{draft.sexualContentFilterEnabled ? "Filter on" : "Filter off"}</strong>
              <small>
                On by default. Workers pick a change up within a minute. The child-sexual-abuse-material name check
                stays on either way.
              </small>
            </span>
          </label>
        </section>

        <section className="work-section safety-settings-card">
          <div className="section-title">
            <ShieldCheck size={18} aria-hidden />
            <h3>Copyright restrictions</h3>
          </div>
          <p className="muted">
            When enabled, top-level generation requests that explicitly ask Tomeza to reproduce, continue, or
            closely substitute for protected works are refused. Ambiguous requests default to allowed.
          </p>
          <label className="safety-toggle-row">
            <input
              type="checkbox"
              checked={draft.copyrightRestrictionsEnabled}
              onChange={(event) => props.onDraftChange({ ...draft, copyrightRestrictionsEnabled: event.target.checked })}
            />
            <span>
              <strong>{draft.copyrightRestrictionsEnabled ? "Restrictions enabled" : "Restrictions disabled"}</strong>
              <small>
                The critical illegal-harm and deceptive official-document gate stays active independently.
              </small>
            </span>
          </label>
        </section>
      </div>

      <section className="tool-panel safety-settings-card">
        <div className="panel-title">
          <Save size={18} aria-hidden />
          <h2>Publish change</h2>
        </div>
        <p className="muted">
          Current version {settings.version}
          {settings.updatedAt ? ` · ${new Date(settings.updatedAt).toLocaleString()}` : " · built-in default"}.
          Changes apply to new requests immediately and are retained as an audit revision.
        </p>
        <label>
          Change note
          <input
            value={props.note}
            maxLength={500}
            placeholder="Why is this setting changing?"
            onChange={(event) => props.onNoteChange(event.target.value)}
          />
        </label>
        <Button
          variant="primary"
          fullWidth
          disabled={!changed || busy}
          loading={busy}
          loadingLabel="Saving setting…"
          startIcon={<Save />}
          onClick={props.onSave}
        >
          Save setting
        </Button>
      </section>
    </div>
  );
}
