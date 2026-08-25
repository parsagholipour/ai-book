import { Loader2, RotateCcw, Save, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  QUALITY_EFFORT_TIERS,
  type QualityEffortTier,
  type QualityFeatureId
} from "@book-maker/core/qualityGates";
import { apiGet, apiPatch, apiPost } from "../../api.js";
import { Button } from "../shared/Button.js";
import { labelCase, readError } from "../shared/formatters.js";
import type {
  GenerationTextModelOption,
  GenerationTextModelRouting
} from "@book-maker/core/generationTextModelRouting";
import {
  GenerationModelRoutingSection,
  cloneGenerationModelRouting,
  generationModelRoutingClaim,
  readGenerationModelOptions,
  readGenerationModelRouting,
  rebaseGenerationModelRouting,
  type GenerationModelRoutingPatch
} from "./GenerationModelRouting.js";

/** An id core describes, or one only the server knows about yet — see `featureRows`. */
type ServerFeatureId = QualityFeatureId | (string & {});

/** An effort tier this console labels, or one observed from a newer server. */
export type ServerEffortTier = QualityEffortTier | (string & {});

/**
 * The whole map a save has to carry, keyed by the ids core actually compiles.
 *
 * The eleven ids and the four known tiers used to be restated here as `string`,
 * and nothing could check either copy: the console typechecked happily while
 * every PATCH 400'd. Core's barrel drags puppeteer and `node:fs` into a browser
 * bundle, so this takes the real unions through the `./qualityGates` subpath —
 * that module imports one type and nothing else, which is what makes it safe to
 * take alone. The string fallbacks are deliberate: the API also exposes future
 * feature ids and tier strings when they have the tier-list shape this console
 * can safely render.
 */
type QualitySettings = Record<QualityFeatureId, ServerEffortTier[]> &
  Partial<Record<string, ServerEffortTier[]>>;

/**
 * What one Save posts: the features it claims, the note it carries, or both.
 *
 * Every feature key is optional on the server — a body names the features it
 * means and the merge leaves the rest as the stored revision has them — so this
 * is a partial map rather than `QualitySettings`, and `note` sits beside the
 * features rather than under a key of its own.
 */
type QualitySavePatch = {
  [feature: string]: ServerEffortTier[] | GenerationModelRoutingPatch | string | undefined;
  models?: GenerationModelRoutingPatch;
  note?: string;
};

type QualityFeature = {
  id: ServerFeatureId;
  label: string;
  summary: string;
};

export type GenerationQuality = {
  version: number;
  settings: QualitySettings;
  models: GenerationTextModelRouting;
  modelOptions: GenerationTextModelOption[];
  usingCompiledDefaults: boolean;
  features: QualityFeature[];
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

/** Keyed rather than listed, so a tier core renames stops compiling here. */
const TIER_LABELS: Record<QualityEffortTier, string> = {
  ultra: "Ultra",
  premium: "Premium",
  balanced: "Balanced",
  fast: "Quick draft"
};

export function GenerationQualityScreen() {
  const [state, setState] = useState<GenerationQuality | null>(null);
  const [draft, setDraft] = useState<QualitySettings | null>(null);
  const [modelDraft, setModelDraft] = useState<GenerationTextModelRouting | null>(null);
  const [note, setNote] = useState("");
  const [busyAction, setBusyAction] = useState<"save" | "gates-reset" | "models-reset" | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    void apiGet<GenerationQuality>("/api/admin/generation-quality")
      .then((value) => {
        setState(value);
        setDraft(cloneSettings(value.settings));
        setModelDraft(cloneGenerationModelRouting(value.models));
      })
      .catch((loadError) => setError(readError(loadError)));
  }, []);

  const rows = useMemo(() => (state ? featureRows(state) : []), [state]);

  const claim = useMemo(() => {
    if (!state || !draft || !modelDraft) {
      return null;
    }
    return qualitySaveClaim(state.settings, draft, note, state.models, modelDraft);
  }, [draft, modelDraft, note, state]);

  function toggle(feature: ServerFeatureId, tier: ServerEffortTier) {
    // State does not commit until React finishes the current interaction. The
    // ref closes that small window too, so a second event cannot mutate the
    // snapshot after Save or Reset has started carrying it to the server.
    if (busyRef.current) {
      return;
    }
    setDraft((current) => {
      if (!current) {
        return current;
      }
      const tiers = current[feature] ?? [];
      const assigned = toggleQualityTier(tiers, tier);
      return { ...current, [feature]: assigned };
    });
    setSaved(null);
  }

  async function save() {
    // `state` and `draft` are what a non-null claim is built from; naming them
    // here is what lets the conflict path below rebase against them.
    if (!claim || !state || !draft || !modelDraft || !beginRequest("save")) {
      return;
    }
    try {
      const value = await apiPatch<GenerationQuality>("/api/admin/generation-quality", claim);
      // The stored revision is what the next claim diffs against, so both halves
      // move to the merge the server answered with — which may carry another
      // operator's boxes as well as ours. Re-basing only the draft would leave
      // the next save claiming their change back out.
      setState(value);
      setDraft(cloneSettings(value.settings));
      setModelDraft(cloneGenerationModelRouting(value.models));
      setNote("");
      setError(null);
      setSaved(`Saved as generation quality version ${value.version}.`);
    } catch (saveError) {
      setSaved(null);
      // A lost revision number is the one refusal this screen can act on rather
      // than merely report — see `recoverQualitySave`. Either way the claim is
      // left standing: nothing here re-posts it on the operator's behalf.
      const recovery = await recoverQualitySave({
        error: saveError,
        loaded: state,
        draft,
        modelDraft,
        note,
        reload: () => apiGet<GenerationQuality>("/api/admin/generation-quality")
      });
      if (recovery.kind === "rebase") {
        setState(recovery.state);
        setDraft(recovery.draft);
        setModelDraft(recovery.modelDraft);
      }
      setError(recovery.error);
    } finally {
      endRequest();
    }
  }

  async function resetQuality(kind: "gates" | "models") {
    if (!beginRequest(kind === "gates" ? "gates-reset" : "models-reset")) {
      return;
    }
    try {
      const path =
        kind === "gates" ? "/api/admin/generation-quality/reset" : "/api/admin/generation-quality/models/reset";
      const value = await apiPost<GenerationQuality>(path, note.trim() ? { note: note.trim() } : {});
      setState(value);
      setDraft(cloneSettings(value.settings));
      setModelDraft(cloneGenerationModelRouting(value.models));
      setNote("");
      setError(null);
      setSaved(
        kind === "gates"
          ? `Reset to compiled defaults as version ${value.version}.`
          : `Reset model routing as version ${value.version}.`
      );
    } catch (resetError) {
      setError(qualityResetFailure(resetError, kind === "gates" ? "Reset quality gates" : "Reset model routing"));
      setSaved(null);
    } finally {
      endRequest();
    }
  }

  function beginRequest(action: "save" | "gates-reset" | "models-reset"): boolean {
    if (busyRef.current) {
      return false;
    }
    busyRef.current = true;
    setBusyAction(action);
    return true;
  }

  function endRequest() {
    busyRef.current = false;
    setBusyAction(null);
  }

  const busy = busyAction !== null;

  return (
    <div className="admin-page">
      {error ? <div className="error-banner">{error}</div> : null}
      {saved ? <div className="pricing-saved">{saved}</div> : null}
      {!state || !draft || !modelDraft ? (
        <div className="empty-state">
          <Loader2 className="spin" size={20} aria-hidden /> Loading quality gates…
        </div>
      ) : (
        <div className="quality-admin-layout">
          <GenerationModelRoutingSection
            models={modelDraft}
            options={state.modelOptions}
            disabled={busy}
            onChange={(models) => {
              if (busyRef.current) return;
              setModelDraft(models);
              setSaved(null);
            }}
          />
          <section className="work-section safety-settings-card">
            <div className="section-title">
              <Sparkles size={18} aria-hidden />
              <h3>Generation quality gates</h3>
            </div>
            <p className="muted">
              Each row can run on any subset of Effort tiers. Deselect every tier and that feature
              is off for the next page, plan, or map step — live, not stamped at enqueue.
            </p>
            <ul className="quality-gate-list">
              {rows.map((feature) => {
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
                    <QualityTierFieldset
                      label={feature.label}
                      assigned={assigned}
                      disabled={busy}
                      onToggle={(tier) => toggle(feature.id, tier)}
                    />
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
              . Successful saves affect calls started afterward; running calls and their retries keep their original model.
            </p>
            {state.note ? (
              <p className="muted">
                Note on version {state.version}: “{state.note}”
              </p>
            ) : null}
            <label>
              Change note
              <input
                value={note}
                maxLength={500}
                disabled={busy}
                placeholder="Why is this setting changing?"
                onChange={(event) => {
                  if (busyRef.current) {
                    return;
                  }
                  setNote(event.target.value);
                  setSaved(null);
                }}
              />
            </label>
            <Button
              variant="primary"
              fullWidth
              disabled={!claim || busy}
              loading={busyAction === "save"}
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
              loading={busyAction === "gates-reset"}
              loadingLabel="Resetting quality gates…"
              startIcon={<RotateCcw />}
              onClick={() => void resetQuality("gates")}
            >
              Reset quality gates
            </Button>
            <Button
              variant="secondary"
              fullWidth
              disabled={busy}
              loading={busyAction === "models-reset"}
              loadingLabel="Resetting model routing…"
              startIcon={<RotateCcw />}
              onClick={() => void resetQuality("models")}
            >
              Reset model routing
            </Button>
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * What Save would post — the features whose lists moved, and the note — or
 * `null` when the form is claiming nothing.
 *
 * **A partial body is the mechanism, not a saving of bytes.** Every feature key
 * is optional on the server so a save can name the features it means:
 * `mergeQualityFeatureSettings` reads the stored revision for every id the body
 * leaves out, and the P2002 replay re-merges onto whoever won the version
 * number. Posting all eleven keys the moment any box moved — which this used to
 * do — makes both inert and reverts every box another operator unchecked since
 * this page loaded, which is the lost update the optional keys exist to
 * prevent. So a feature nobody touched is *absent*, not re-asserted.
 *
 * The comparison is the server's: presence, never truthiness, so `[]` is a real
 * "this feature is off" claim rather than an absent one.
 *
 * A note with no feature keys is a real save on the server — an operator
 * writing down why the gates that stand should stand — and a body claiming
 * neither a feature nor a note is refused. Both halves are restated here, off
 * the same trimmed value the server decides on: a note blank once trimmed
 * leaves the button inert, because sending it would mint a revision carrying a
 * null note, which is the untouched form wearing a hat.
 *
 * A box toggled and toggled back is still a save the operator meant to make,
 * and the server honours one — but only this console can still *say* so where
 * the list actually moved. Re-checking a tier appends it, so unless it was
 * already last the round trip differs by order and is claimed, order and all.
 * Where it lands byte-identical there is nothing left to claim: asserting the
 * loaded value is precisely the overwrite above, and this console cannot tell
 * its own no-op from a stale one. That gesture saves on its note, and without
 * one the button stays inert.
 */
export function qualitySaveClaim(
  stored: QualitySettings,
  draft: QualitySettings,
  note: string,
  storedModels: GenerationTextModelRouting,
  draftModels: GenerationTextModelRouting
): QualitySavePatch | null {
  const trimmed = note.trim();
  const moved: QualitySavePatch = {};
  for (const id of Object.keys(draft)) {
    const assigned = draft[id];
    if (assigned !== undefined && !sameAssignment(assigned, stored[id])) {
      moved[id] = [...assigned];
    }
  }
  const models = generationModelRoutingClaim(storedModels, draftModels);
  if (models) moved.models = models;
  if (Object.keys(moved).length === 0 && !trimmed) {
    return null;
  }
  return {
    ...moved,
    ...(trimmed ? { note: trimmed } : {})
  };
}

/** A feature the loaded revision never carried is moved by definition. */
function sameAssignment(assigned: ServerEffortTier[], stored: ServerEffortTier[] | undefined): boolean {
  return (
    stored !== undefined &&
    assigned.length === stored.length &&
    assigned.every((tier, index) => tier === stored[index])
  );
}

/**
 * Either the banner alone, or the banner and the revision the rows move to.
 */
export type QualitySaveRecovery =
  | { kind: "report"; error: string }
  | {
      kind: "rebase";
      state: GenerationQuality;
      draft: QualitySettings;
      modelDraft: GenerationTextModelRouting;
      error: string;
    };

/**
 * What this screen does with a save the server refused.
 *
 * **A lost revision number is the one refusal worth recovering from rather than
 * reporting.** The body carried only the features this operator moved, so the
 * same claim laid over the newer head keeps both operators' work — that is what
 * the server's own replay does one number earlier, and what the optional feature
 * keys were built for. Which leaves three ways to answer it, and this is the
 * middle one:
 *
 * - Re-post the claim automatically. Least friction, and it does resolve — but
 *   it settles a genuine concurrent edit without ever mentioning it, on a screen
 *   whose gates take effect on the next in-flight page. It is also a third write
 *   into a table that has just refused two, and if it loses again the operator
 *   reads a banner anyway, one revision further behind.
 * - Reload and start over. Honest about the conflict and the only option that
 *   loses the operator's unsaved boxes, which is worse than the stale screen it
 *   replaces.
 * - Reload, rebase, and leave the claim standing — this. The gates nobody
 *   claimed take the winner's values, so the rows stop lying; the boxes this
 *   operator moved stay exactly as they left them, so pressing Save posts the
 *   identical partial body and the merge keeps both. The retry stays a gesture
 *   the operator makes, because they are entitled to know a revision landed
 *   underneath them before they store one on top of it.
 *
 * The reload is what makes the conflict recoverable, so a reload that fails
 * falls back to the honest half of the same sentence rather than pretending the
 * rows below are current.
 *
 * **A recovery may not hide the failure it is recovering from.** This is the
 * only thing standing between a refused save and the banner the operator reads:
 * `save()` clears the confirmation before calling it and clears the spinner
 * after, so a rejection here left the screen showing neither — the operator
 * pressed Save and it looked like nothing happened. So it resolves whatever the
 * reload does. A reply of the wrong shape is *read* rather than merely survived
 * — see `readQualityHead` — because a head this screen cannot render is one it
 * must not seat either, and the rows render from it long after this function has
 * returned; the catch beneath that is the floor, not the plan, and it answers a
 * reload that rejects with the same sentence.
 */
export async function recoverQualitySave(input: {
  error: unknown;
  loaded: GenerationQuality;
  draft: QualitySettings;
  modelDraft: GenerationTextModelRouting;
  note: string;
  reload: () => Promise<GenerationQuality>;
}): Promise<QualitySaveRecovery> {
  const conflict = qualitySaveConflict(input.error);
  if (!conflict) {
    return { kind: "report", error: readError(input.error) };
  }
  // What this screen says whenever it could not move the rows, whether the
  // reload rejected or answered with something it cannot render. The claim is
  // untouched in both, so the version named is the one the save merged onto and
  // the instruction is the same.
  const unmoved: QualitySaveRecovery = {
    kind: "report",
    error: qualityConflictNotice({
      version: conflict.currentVersion,
      reloaded: false,
      movedUnderneath: [],
      stillClaiming: true
    })
  };
  try {
    const head = readQualityHead(await input.reload());
    if (!head) {
      return unmoved;
    }
    const rebased = rebaseQualityDraft(head.settings, input.loaded.settings, input.draft);
    const rebasedModels = rebaseGenerationModelRouting(
      head.models,
      input.loaded.models,
      input.modelDraft
    );
    const described = new Map(featureRows(head).map((row) => [row.id, row.label]));
    return {
      kind: "rebase",
      state: head,
      draft: rebased.settings,
      modelDraft: rebasedModels,
      error: qualityConflictNotice({
        version: head.version,
        reloaded: true,
        movedUnderneath: rebased.movedUnderneath.map((id) => described.get(id) ?? id),
        // Asked rather than assumed: the winner may have stored the very box this
        // operator was claiming, which leaves nothing to press Save for.
        stillClaiming: qualitySaveClaim(head.settings, rebased.settings, input.note, head.models, rebasedModels) !== null
      })
    };
  } catch {
    /* the reload rejected, or a head that got past the read still broke */
  }
  return unmoved;
}

/**
 * The revision a refused save merged onto, or `null` for a failure this screen
 * cannot recover from.
 *
 * `apiPatch` throws the response body and drops the status, so the body's shape
 * is the only discriminator left here — and it is a clean one:
 * `withRevisionConflictReply` is the single answer on this route that sends a
 * number beside its `error`, where the 400s carry a sentence alone and
 * Fastify's own 500 carries `statusCode`/`message`. The sentence beside the
 * number is deliberately not shown: it tells the operator to reload, which is a
 * step this screen now takes for them.
 *
 * Wrapped in an object rather than returned bare, because `currentVersion` is
 * `0` on the first save a fresh install ever races — a truthiness test on the
 * number would read that conflict as no conflict at all.
 */
export function qualitySaveConflict(error: unknown): { currentVersion: number } | null {
  if (!(error instanceof Error)) {
    return null;
  }
  try {
    const parsed = JSON.parse(error.message) as { currentVersion?: unknown } | null;
    const version = parsed?.currentVersion;
    return typeof version === "number" && Number.isFinite(version)
      ? { currentVersion: version }
      : null;
  } catch {
    /* plain text error */
  }
  return null;
}

/**
 * The reloaded revision, or `null` for a reply this screen cannot render.
 *
 * `apiGet` hands back whatever parsed, and the recovery's reload is where a body
 * of the wrong shape meets this file: a proxy's error page, a version-skewed
 * replica, a half-migrated response. Reading it is not the same as catching what
 * it breaks. The three halves the screen *indexes and iterates* decide a whole
 * revision, and a body failing any of them is refused rather than half-used —
 * because a head that merely happens not to throw in the recovery is seated as
 * `state`, and the rows render off it afterwards, outside every catch. A
 * `settings` value arriving as `"ultra"` spreads into five one-letter tiers that
 * the next Save posts back; a `version` that is not a number reaches the banner
 * as a lie and the render as an object child. Neither is survivable by trying.
 *
 * What the screen only *prints* is coerced instead. A missing `updatedAt` is a
 * revision whose time nobody knows, which is what `null` already means in these
 * three fields — refusing the reload over it would throw away a rebase that
 * works.
 */
export function readQualityHead(value: unknown): GenerationQuality | null {
  if (!isRecord(value)) {
    return null;
  }
  const version = value.version;
  const settings = readQualitySettings(value.settings);
  const features = readFeatureCopy(value.features);
  const models = readGenerationModelRouting(value.models);
  const modelOptions = readGenerationModelOptions(value.modelOptions);
  if (typeof version !== "number" || !Number.isFinite(version) || !settings || !features || !models || !modelOptions) {
    return null;
  }
  return {
    version,
    settings,
    models,
    modelOptions,
    usingCompiledDefaults: value.usingCompiledDefaults === true,
    features,
    note: readNullableText(value.note),
    updatedBy: readNullableText(value.updatedBy),
    updatedAt: readNullableText(value.updatedAt)
  };
}

function readQualitySettings(value: unknown): QualitySettings | null {
  if (!isRecord(value)) {
    return null;
  }
  const settings = {} as QualitySettings;
  for (const [id, assigned] of Object.entries(value)) {
    if (!Array.isArray(assigned)) {
      return null;
    }
    const tiers: unknown[] = assigned;
    if (!tiers.every((tier) => typeof tier === "string")) {
      return null;
    }
    // A tier string this build has no name for is kept, for the same reason an
    // id with no copy still gets a row: dropping it would post a newer server's
    // value back out the next time this feature is claimed.
    settings[id] = tiers as ServerEffortTier[];
  }
  return settings;
}

function readFeatureCopy(value: unknown): QualityFeature[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries: unknown[] = value;
  const features: QualityFeature[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      return null;
    }
    const { id, label, summary } = entry;
    if (typeof id !== "string" || typeof label !== "string" || typeof summary !== "string") {
      return null;
    }
    features.push({ id, label, summary });
  }
  return features;
}

function readNullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The stored revision, wearing this operator's unsaved boxes.
 *
 * A gate the operator moved keeps their value; every other gate takes the head's,
 * so the rows stop showing a revision that is no longer stored. The test for
 * "moved" is `qualitySaveClaim`'s own, which is what makes the rebase claim-
 * preserving: every feature the refused body named is still named, with the same
 * tiers, and the only ones that drop out are those the winner happened to store
 * at exactly that value — where there is genuinely nothing left to say.
 *
 * The head decides the baseline feature set. The only extra keys admitted are
 * ones the operator actually claimed: a rolling deployment can answer the
 * reload from an older replica that omits a feature this console loaded, and
 * dropping that key would drop the refused edit with it. Taking every draft key
 * instead would revive untouched stale-only features, so the union is bounded
 * by the same assignment comparison that built the claim.
 *
 * A feature the head carries that this console never loaded is *not* a gate
 * that moved underneath the operator — it is a build they have not seen — so it
 * is seated silently rather than reported as someone else's edit. Likewise, an
 * absent head value is version skew, not evidence that another operator moved
 * the gate.
 */
export function rebaseQualityDraft(
  head: QualitySettings,
  stale: QualitySettings,
  draft: QualitySettings
): { settings: QualitySettings; movedUnderneath: ServerFeatureId[] } {
  const settings = {} as QualitySettings;
  const movedUnderneath: ServerFeatureId[] = [];
  const headIds = new Set(Object.keys(head));
  const ids = new Set(headIds);
  for (const id of Object.keys(draft)) {
    const claimed = draft[id];
    if (claimed !== undefined && !sameAssignment(claimed, stale[id])) {
      ids.add(id);
    }
  }
  for (const id of ids) {
    const stored = head[id] ?? [];
    const claimed = draft[id];
    const loaded = stale[id];
    const keepsClaim = claimed !== undefined && !sameAssignment(claimed, loaded);
    settings[id] = keepsClaim ? [...claimed] : [...stored];
    if (headIds.has(id) && loaded !== undefined && !sameAssignment(stored, loaded)) {
      movedUnderneath.push(id);
    }
  }
  return { settings, movedUnderneath };
}

/** What the operator is told after a save lost the revision number. */
export type QualityConflictNotice = {
  /** The revision the rows now show — or, unreloaded, the one the save merged onto. */
  version: number;
  /**
   * False when the reload yielded no revision — it rejected, or answered with a
   * body this screen cannot render — so the rows on screen are still the stale
   * ones. The two differ in cause and not in anything the operator can do about
   * it, which is why one sentence covers both.
   */
  reloaded: boolean;
  /** Labels of the gates that moved underneath this operator. */
  movedUnderneath: string[];
  /** Whether the rebased boxes still claim anything, so Save is a button worth naming. */
  stillClaiming: boolean;
};

/**
 * The sentence the banner carries, and it names only what this screen can do.
 *
 * The server's own is "Reload and apply your change again", written for any
 * client: correct for a curl, wrong here twice over, since this screen offers no
 * reload button and no longer needs one. What it does instead is reload for
 * them, so the instruction left is to press the Save that is already sitting
 * there with their claim intact — and where the winner turns out to have stored
 * that claim already, the honest instruction is none at all.
 */
export function qualityConflictNotice(notice: QualityConflictNotice): string {
  if (!notice.reloaded) {
    return (
      "Another operator saved generation-quality settings first, past the version " +
      `${notice.version} this save merged onto. Your unsaved changes are still here — press ` +
      "Save setting to lay them over the stored revision. Reloading it failed, so the gates " +
      "you did not touch may be out of date."
    );
  }
  if (!notice.stillClaiming) {
    return (
      `Another operator saved version ${notice.version} first, and it already carries the ` +
      "change you were making. These rows now show it, and there is nothing left to save."
    );
  }
  const moved = notice.movedUnderneath.length
    ? ` They changed ${notice.movedUnderneath.join(", ")}.`
    : "";
  return (
    `Another operator saved version ${notice.version} first.${moved} These rows now show that ` +
    "revision, with your unsaved changes kept on top — press Save setting to store them."
  );
}

/**
 * A reset that lost the revision number, which needs neither the reload nor the
 * version.
 *
 * Every other save claims the features it moved and merges onto whatever is
 * stored; a reset claims all of them at the compiled default, so pressing it
 * again asserts precisely the same thing over whoever won. There is no draft to
 * rebase and no head worth naming — only a gesture to repeat.
 */
const RESET_CONFLICT_NOTICE =
  "Another operator saved generation-quality settings first, so this reset was refused. " +
  "Press Reset to defaults again to reset the revision they stored.";

/** The reset lane's whole recovery: the same detection, a different remedy. */
export function qualityResetFailure(error: unknown, action = "Reset quality gates"): string {
  return qualitySaveConflict(error)
    ? RESET_CONFLICT_NOTICE.replace("Reset to defaults", action)
    : readError(error);
}

/**
 * One row per key the save has to carry, in the order the server sent them.
 *
 * `settings` decides *which* features exist, because it carries every known id
 * plus any compatible future id preserved from the stored revision; `features`
 * only supplies the copy. Keying the screen off `features` instead
 * looked equivalent and is not — that array is hand-maintained in core and its
 * own compiler does not check it against `QUALITY_FEATURE_IDS` either, so an id
 * added without copy would have rendered no row at all, leaving a live gate an
 * operator cannot see and so cannot turn off. A derived label is worse than a
 * written one and better than no row.
 */
export function featureRows(state: GenerationQuality): QualityFeature[] {
  const described = new Map(state.features.map((feature) => [feature.id, feature]));
  return Object.keys(state.settings).map((id) => described.get(id) ?? undescribedFeature(id));
}

function undescribedFeature(id: ServerFeatureId): QualityFeature {
  return {
    id,
    label: labelCase(id.replace(/([a-z0-9])([A-Z])/g, "$1 $2")),
    summary: `Live on the server as "${id}", with no description shipped for it yet.`
  };
}

function cloneSettings(settings: QualitySettings): QualitySettings {
  return Object.fromEntries(
    Object.entries(settings).map(([id, tiers]) => [id, [...(tiers ?? [])]])
  ) as QualitySettings;
}

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
