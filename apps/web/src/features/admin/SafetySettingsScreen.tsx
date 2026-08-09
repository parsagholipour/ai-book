import { Loader2, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { apiGet, apiPatch } from "../../api.js";
import { Button } from "../shared/Button.js";
import { readError } from "../shared/formatters.js";

type SafetySettings = {
  version: number;
  copyrightRestrictionsEnabled: boolean;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

export function SafetySettingsScreen() {
  const [settings, setSettings] = useState<SafetySettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    void apiGet<SafetySettings>("/api/admin/safety-settings")
      .then((value) => {
        setSettings(value);
        setEnabled(value.copyrightRestrictionsEnabled);
      })
      .catch((loadError) => setError(readError(loadError)));
  }, []);

  const changed = settings != null && enabled !== settings.copyrightRestrictionsEnabled;

  async function save() {
    if (!changed || busy) return;
    setBusy(true);
    try {
      const value = await apiPatch<SafetySettings>("/api/admin/safety-settings", {
        copyrightRestrictionsEnabled: enabled,
        ...(note.trim() ? { note: note.trim() } : {})
      });
      setSettings(value);
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
        <div className="admin-columns-2">
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
                checked={enabled}
                onChange={(event) => {
                  setEnabled(event.target.checked);
                  setSaved(null);
                }}
              />
              <span>
                <strong>{enabled ? "Restrictions enabled" : "Restrictions disabled"}</strong>
                <small>
                  The critical illegal-harm and deceptive official-document gate stays active independently.
                </small>
              </span>
            </label>
          </section>

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
              loadingLabel="Saving setting…"
              startIcon={<Save />}
              onClick={() => void save()}
            >
              Save setting
            </Button>
          </section>
        </div>
      )}
    </div>
  );
}
