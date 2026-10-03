import { AlertTriangle, Loader2, Plus, Save, Smartphone, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { apiGet, apiPut } from "../../api.js";
import { Button } from "../shared/Button.js";
import { readError } from "../shared/formatters.js";
import {
  APP_UPDATE_PLATFORMS,
  APP_UPDATE_POLICIES,
  newReleaseProblem,
  normalizeReleases,
  platformEffects,
  PLATFORM_LABELS,
  POLICY_LABELS,
  releasesDiffer,
  type AppUpdatePlatform,
  type AppUpdatePolicy,
  type AppUpdateRelease,
  type AppUpdates
} from "./appUpdatePolicy.js";

type NewRelease = { platform: AppUpdatePlatform; build: string; version: string; policy: AppUpdatePolicy; message: string };

const EMPTY_NEW_RELEASE: NewRelease = { platform: "android", build: "", version: "", policy: "prompt", message: "" };

/**
 * Store releases and what each asks of older installs. The list is saved whole
 * as one audit revision; the app sees a change within about thirty seconds.
 */
export function AppUpdatesScreen() {
  const [stored, setStored] = useState<AppUpdates | null>(null);
  const [releases, setReleases] = useState<AppUpdateRelease[]>([]);
  const [draft, setDraft] = useState<NewRelease>(EMPTY_NEW_RELEASE);
  const [draftProblem, setDraftProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    void apiGet<AppUpdates>("/api/admin/app-updates")
      .then((value) => {
        setStored(value);
        setReleases(value.releases);
      })
      .catch((loadError) => setError(readError(loadError)));
  }, []);

  const changed = stored != null && releasesDiffer(releases, stored.releases);
  const effects = platformEffects(releases);

  function edit(index: number, patch: Partial<AppUpdateRelease>) {
    setReleases((current) => current.map((release, at) => (at === index ? { ...release, ...patch } : release)));
    setSaved(null);
  }

  function remove(index: number) {
    setReleases((current) => current.filter((_, at) => at !== index));
    setSaved(null);
  }

  function add() {
    const problem = newReleaseProblem(releases, draft);
    setDraftProblem(problem);
    if (problem) return;
    const message = draft.message.trim();
    setReleases((current) =>
      normalizeReleases([
        ...current,
        {
          platform: draft.platform,
          build: Number(draft.build),
          version: draft.version.trim(),
          policy: draft.policy,
          ...(message ? { message } : {})
        }
      ])
    );
    setDraft({ ...EMPTY_NEW_RELEASE, platform: draft.platform });
    setSaved(null);
  }

  async function save() {
    if (!stored || !changed || busy) return;
    setBusy(true);
    try {
      const value = await apiPut<AppUpdates>("/api/admin/app-updates", {
        baseVersion: stored.version,
        releases: normalizeReleases(releases),
        ...(note.trim() ? { note: note.trim() } : {})
      });
      setStored(value);
      setReleases(value.releases);
      setNote("");
      setError(null);
      setSaved(`Saved as release list version ${value.version}. Apps pick it up within about 30 seconds.`);
    } catch (saveError) {
      setError(readError(saveError));
      setSaved(null);
    } finally {
      setBusy(false);
    }
  }

  if (!stored) {
    return (
      <div className="admin-page">
        {error ? <div className="error-banner">{error}</div> : null}
        {!error ? (
          <div className="empty-state">
            <Loader2 className="spin" size={20} aria-hidden /> Loading app releases…
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="admin-page">
      {error ? <div className="error-banner">{error}</div> : null}
      {saved ? <div className="pricing-saved">{saved}</div> : null}
      <div className="pricing-grid">
        <section className="work-section app-updates-card">
          <div className="section-title">
            <Smartphone size={18} aria-hidden />
            <h3>Store releases</h3>
          </div>
          <p className="muted">
            Record each build you publish and choose what it asks of installs older than it. <strong>Silent</strong>{" "}
            shows nothing and leaves it to the store&apos;s auto-update. <strong>Ask</strong> shows a dismissible
            &ldquo;update available&rdquo; once per release. <strong>Require</strong> blocks the app until the reader
            updates. A release&apos;s policy covers every build below it, so one required release keeps those builds
            blocked whatever comes after it.
          </p>

          {effects.length > 0 ? (
            <ul className="app-updates-effects">
              {effects.map((effect) => (
                <li key={effect.platform}>
                  <strong>
                    {PLATFORM_LABELS[effect.platform]} · latest build {effect.latest.build} ({effect.latest.version})
                  </strong>
                  <span>
                    {effect.requiredBelow !== null
                      ? `Builds below ${effect.requiredBelow} must update.`
                      : "No build is blocked."}{" "}
                    {effect.promptBelow !== null
                      ? `Builds ${effect.requiredBelow ?? 1}–${effect.promptBelow - 1} are asked to update.`
                      : ""}{" "}
                    Newer builds see nothing.
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No releases recorded. Every build is left alone.</p>
          )}

          {releases.length > 0 ? (
            <div className="admin-table-scroll">
              <table className="admin-table app-updates-table">
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th className="numeric">Build</th>
                    <th>Version</th>
                    <th>Asks older builds to</th>
                    <th>Message to readers (optional)</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {releases.map((release, index) => (
                    <tr key={`${release.platform}:${release.build}`}>
                      <td>{PLATFORM_LABELS[release.platform]}</td>
                      <td className="numeric">{release.build}</td>
                      <td>{release.version}</td>
                      <td>
                        <select
                          aria-label={`Policy for build ${release.build}`}
                          value={release.policy}
                          onChange={(event) => edit(index, { policy: event.target.value as AppUpdatePolicy })}
                        >
                          {APP_UPDATE_POLICIES.map((policy) => (
                            <option key={policy} value={policy}>
                              {POLICY_LABELS[policy]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          aria-label={`Message for build ${release.build}`}
                          value={release.message ?? ""}
                          maxLength={400}
                          placeholder="Shown on the prompt or the update screen"
                          onChange={(event) => edit(index, { message: event.target.value })}
                        />
                      </td>
                      <td>
                        <Button size="sm" variant="danger" startIcon={<Trash2 />} onClick={() => remove(index)}>
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="app-updates-add">
            <h4>Add a release</h4>
            <div className="app-updates-add-row">
              <label>
                Platform
                <select
                  value={draft.platform}
                  onChange={(event) => setDraft({ ...draft, platform: event.target.value as AppUpdatePlatform })}
                >
                  {APP_UPDATE_PLATFORMS.map((platform) => (
                    <option key={platform} value={platform}>
                      {PLATFORM_LABELS[platform]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Build (versionCode)
                <input
                  inputMode="numeric"
                  value={draft.build}
                  placeholder="7"
                  onChange={(event) => setDraft({ ...draft, build: event.target.value })}
                />
              </label>
              <label>
                Version
                <input
                  value={draft.version}
                  maxLength={40}
                  placeholder="1.2.0"
                  onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                />
              </label>
              <label>
                Asks older builds to
                <select
                  value={draft.policy}
                  onChange={(event) => setDraft({ ...draft, policy: event.target.value as AppUpdatePolicy })}
                >
                  {APP_UPDATE_POLICIES.map((policy) => (
                    <option key={policy} value={policy}>
                      {POLICY_LABELS[policy]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Message to readers (optional)
              <input
                value={draft.message}
                maxLength={400}
                placeholder="e.g. This update fixes purchases on some phones."
                onChange={(event) => setDraft({ ...draft, message: event.target.value })}
              />
            </label>
            {draftProblem ? <p className="app-updates-problem">{draftProblem}</p> : null}
            <Button startIcon={<Plus />} onClick={add}>
              Add to the list
            </Button>
          </div>
        </section>

        <section className="tool-panel app-updates-card">
          <div className="panel-title">
            <Save size={18} aria-hidden />
            <h2>Publish change</h2>
          </div>
          <p className="app-updates-warning">
            <AlertTriangle size={16} aria-hidden />
            <span>
              Set Ask or Require only once the release is at 100% rollout in Play Console and has been live for about a
              day. A reader Play does not offer the build to yet cannot install it, and a required update would lock
              them out.
            </span>
          </p>
          <p className="muted">
            Current version {stored.version}
            {stored.updatedAt ? ` · ${new Date(stored.updatedAt).toLocaleString()}` : " · nothing saved yet"}.
            {stored.note ? ` Last note: ${stored.note}` : ""}
          </p>
          <label>
            Change note
            <input
              value={note}
              maxLength={500}
              placeholder="Why is this changing?"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <Button
            variant="primary"
            fullWidth
            disabled={!changed || busy}
            loading={busy}
            loadingLabel="Saving releases…"
            startIcon={<Save />}
            onClick={() => void save()}
          >
            Save release list
          </Button>
          {changed ? (
            <Button
              fullWidth
              disabled={busy}
              onClick={() => {
                setReleases(stored.releases);
                setSaved(null);
              }}
            >
              Discard changes
            </Button>
          ) : null}
        </section>
      </div>
    </div>
  );
}
