import { CalendarDays, Gauge, Loader2, PauseCircle, Save, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { apiGet, apiPut } from "../../api.js";
import { Button } from "../shared/Button.js";
import { readError } from "../shared/formatters.js";
import { usd, usdFine } from "./format.js";

/**
 * The AI spend breaker (`apps/api/src/spendBreaker.ts`): the pause switch, the
 * caps, today's provider spend split by plan, the month's free spend against its
 * ceiling, and who is spending it. The global caps count free spend (free
 * readers plus calls that name no reader); paying readers answer only to their
 * own cap, the paid cap and the pause. Every save is an audit revision; the API
 * acts on it at once in the process that took it and within a minute in any
 * other.
 */

export type SpendState = "normal" | "soft" | "hard" | "monthly" | "paused";

export type PaidSpendState = "normal" | "capped" | "paused";

export type SpendCaps = {
  paused: boolean;
  softDailyCapUsd: number;
  hardDailyCapUsd: number;
  freeMonthlyCapUsd: number;
  paidHardDailyCapUsd: number;
  freeUserDailyCapUsd: number;
  paidUserDailyCapUsd: number;
};

export type SpendControlsView = {
  controls: SpendCaps & { version: number; note: string | null; updatedBy: string | null; updatedAt: string | null };
  defaults: SpendCaps;
  today: {
    day: string;
    resetsAt: string;
    state: SpendState;
    paidState: PaidSpendState;
    freeUsd: number;
    paidUsd: number;
    unattributedUsd: number;
    /** Free plus unattributed: what the soft and hard caps compare. */
    freeSpendUsd: number;
    totalUsd: number;
  };
  month: { month: string; resetsAt: string; freeSpendUsd: number };
  topSpenders: Array<{ userId: string; email: string | null; spendUsd: number; paidPlan: boolean }>;
};

/** Caps as typed: strings, so a half-typed number is not coerced under the operator. */
export type SpendDraft = { paused: boolean } & Record<CapKey, string>;

type CapKey = Exclude<keyof SpendCaps, "paused">;

const CAP_FIELDS: Array<{ key: CapKey; label: string; help: string }> = [
  {
    key: "softDailyCapUsd",
    label: "Soft cap (free spend, per day)",
    help: "Free readers plus calls that name no reader. Past it, free accounts lose Ultra and their welcome credits wait (voice calls and audiobooks are plan-only anyway). Paid plans are untouched."
  },
  {
    key: "hardDailyCapUsd",
    label: "Hard cap (free spend, per day)",
    help: "Past it, free accounts start no new AI work until 00:00 UTC. Paid plans are untouched, and running jobs finish."
  },
  {
    key: "freeMonthlyCapUsd",
    label: "Monthly ceiling (free spend, per UTC month)",
    help: "Past it, free accounts are held as if past the hard cap until the month ends or this is raised. $150 is the AI share of a $200 month with no ads; lower it in a month the ads run."
  },
  {
    key: "paidHardDailyCapUsd",
    label: "Paid cap (paid-plan spend, per day)",
    help: "A catastrophe stop, not a budget: subscriptions pay for this spend. Past it, paying readers start no new AI work until 00:00 UTC."
  },
  { key: "freeUserDailyCapUsd", label: "Per reader, free plan", help: "One account's own spend per day; a credit-pack buyer with no plan counts as free." },
  { key: "paidUserDailyCapUsd", label: "Per reader, paid plan", help: "High on purpose: a Max subscriber can use a week of credits in an afternoon." }
];

export const SPEND_STATE_LABELS: Record<SpendState, string> = {
  normal: "Normal",
  soft: "Soft cap reached — free accounts held to standard work",
  hard: "Hard cap reached — free accounts start no new AI work today",
  monthly: "Monthly ceiling reached — free accounts start no new AI work this month",
  paused: "Paused by the operator — new AI work refused for everyone"
};

export const PAID_SPEND_STATE_LABELS: Record<PaidSpendState, string> = {
  normal: "Normal",
  capped: "Paid cap reached — paying readers start no new AI work today",
  paused: "Paused by the operator — new AI work refused for everyone"
};

export function draftFromControls(controls: SpendCaps): SpendDraft {
  return {
    paused: controls.paused,
    softDailyCapUsd: String(controls.softDailyCapUsd),
    hardDailyCapUsd: String(controls.hardDailyCapUsd),
    freeMonthlyCapUsd: String(controls.freeMonthlyCapUsd),
    paidHardDailyCapUsd: String(controls.paidHardDailyCapUsd),
    freeUserDailyCapUsd: String(controls.freeUserDailyCapUsd),
    paidUserDailyCapUsd: String(controls.paidUserDailyCapUsd)
  };
}

/** The draft as the PUT body, or the first thing wrong with it. */
export function parseSpendDraft(draft: SpendDraft): { caps: SpendCaps } | { problem: string } {
  const caps: Partial<SpendCaps> = { paused: draft.paused };
  for (const field of CAP_FIELDS) {
    const value = Number(draft[field.key].trim());
    if (draft[field.key].trim() === "" || !Number.isFinite(value) || value < 0) {
      return { problem: `${field.label}: enter an amount in dollars, 0 or more.` };
    }
    caps[field.key] = value;
  }
  const parsed = caps as SpendCaps;
  if (parsed.softDailyCapUsd > parsed.hardDailyCapUsd) {
    return { problem: "The soft cap has to be at or below the hard cap." };
  }
  return { caps: parsed };
}

function draftChanged(draft: SpendDraft, controls: SpendCaps): boolean {
  const parsed = parseSpendDraft(draft);
  if ("problem" in parsed) return true;
  return (Object.keys(parsed.caps) as Array<keyof SpendCaps>).some((key) => parsed.caps[key] !== controls[key]);
}

export function SpendControlsScreen() {
  const [view, setView] = useState<SpendControlsView | null>(null);
  const [draft, setDraft] = useState<SpendDraft | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  function show(value: SpendControlsView) {
    setView(value);
    setDraft(draftFromControls(value.controls));
  }

  useEffect(() => {
    void apiGet<SpendControlsView>("/api/admin/spend-controls")
      .then(show)
      .catch((loadError) => setError(readError(loadError)));
  }, []);

  async function save() {
    if (!draft || busy) return;
    const parsed = parseSpendDraft(draft);
    if ("problem" in parsed) {
      setError(parsed.problem);
      return;
    }
    setBusy(true);
    try {
      const value = await apiPut<SpendControlsView>("/api/admin/spend-controls", {
        ...parsed.caps,
        ...(note.trim() ? { note: note.trim() } : {})
      });
      show(value);
      setNote("");
      setError(null);
      setSaved(`Saved as spend controls version ${value.controls.version}.`);
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
      {!view || !draft ? (
        <div className="empty-state">
          <Loader2 className="spin" size={20} aria-hidden /> Loading spend controls…
        </div>
      ) : (
        <SpendControlsPanel
          view={view}
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

export function SpendControlsPanel(props: {
  view: SpendControlsView;
  draft: SpendDraft;
  note: string;
  busy: boolean;
  onDraftChange: (draft: SpendDraft) => void;
  onNoteChange: (note: string) => void;
  onSave: () => void;
}) {
  const { view, draft, note, busy } = props;
  const changed = draftChanged(draft, view.controls);
  const parsed = parseSpendDraft(draft);
  const { today, month, controls } = view;
  const monthShare = controls.freeMonthlyCapUsd > 0 ? Math.round((month.freeSpendUsd / controls.freeMonthlyCapUsd) * 100) : null;
  return (
    <div className="admin-columns-2">
      <section className="work-section safety-settings-card">
        <div className="section-title">
          <Gauge size={18} aria-hidden />
          <h3>Today ({today.day}, UTC)</h3>
        </div>
        <p>
          <strong>{usdFine(today.freeSpendUsd)}</strong> of free spend so far ({usdFine(today.freeUsd)} by free readers,{" "}
          {usdFine(today.unattributedUsd)} unattributed) · soft cap {usd(controls.softDailyCapUsd)} · hard cap{" "}
          {usd(controls.hardDailyCapUsd)}.
        </p>
        <p>
          <strong>{usdFine(today.paidUsd)}</strong> of paid-plan spend · paid cap {usd(controls.paidHardDailyCapUsd)}. Total{" "}
          {usdFine(today.totalUsd)}. Resets at 00:00 UTC.
        </p>
        <p>
          Free accounts:{" "}
          <span className={`job-status-pill ${today.state !== "normal" ? "status-failed" : "status-completed"}`}>
            {SPEND_STATE_LABELS[today.state]}
          </span>
        </p>
        <p>
          Paid plans:{" "}
          <span className={`job-status-pill ${today.paidState !== "normal" ? "status-failed" : "status-completed"}`}>
            {PAID_SPEND_STATE_LABELS[today.paidState]}
          </span>
        </p>
        <div className="section-title">
          <CalendarDays size={18} aria-hidden />
          <h3>This month ({month.month}, UTC)</h3>
        </div>
        <p>
          <strong>{usdFine(month.freeSpendUsd)}</strong> of free spend of the {usd(controls.freeMonthlyCapUsd)} monthly ceiling
          {monthShare === null ? "" : ` (${monthShare}%)`}. Resets on the 1st, 00:00 UTC.
        </p>
        <p className="muted">
          Spend is the sum of priced provider calls (a floor on the real bill). Free spend is readers with no plan at any
          moment of the window plus calls that name no reader; operator-console books count as paid. Queued and running
          jobs are never stopped: they were paid for when they were queued. Provider-console budget caps are the backstop
          for everything this cannot see.
        </p>
        <div className="section-title">
          <Users size={18} aria-hidden />
          <h3>Top spenders today</h3>
        </div>
        {view.topSpenders.length === 0 ? (
          <p className="muted">No reader has spent anything today.</p>
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Reader</th>
                  <th>Plan</th>
                  <th className="numeric">Spend</th>
                </tr>
              </thead>
              <tbody>
                {view.topSpenders.map((spender) => (
                  <tr key={spender.userId}>
                    <td>
                      {spender.email ?? "(no email)"} <small className="muted">{spender.userId}</small>
                    </td>
                    <td>{spender.paidPlan ? "Paid" : "Free"}</td>
                    <td className="numeric">{usdFine(spender.spendUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="tool-panel safety-settings-card">
        <div className="panel-title">
          <PauseCircle size={18} aria-hidden />
          <h2>Controls</h2>
        </div>
        <label className="safety-toggle-row">
          <input
            type="checkbox"
            checked={draft.paused}
            onChange={(event) => props.onDraftChange({ ...draft, paused: event.target.checked })}
          />
          <span>
            <strong>{draft.paused ? "AI work paused" : "AI work running"}</strong>
            <small>
              Paused refuses every new AI action in the app with a calm &ldquo;try again later&rdquo; and the
              reader&apos;s credits untouched.
            </small>
          </span>
        </label>
        {CAP_FIELDS.map((field) => (
          <label key={field.key}>
            {field.label} — default {usd(view.defaults[field.key])}
            <input
              inputMode="decimal"
              value={draft[field.key]}
              onChange={(event) => props.onDraftChange({ ...draft, [field.key]: event.target.value })}
            />
            <small className="muted">{field.help}</small>
          </label>
        ))}
        <label>
          Change note
          <input
            value={note}
            maxLength={500}
            placeholder="Why are the controls changing?"
            onChange={(event) => props.onNoteChange(event.target.value)}
          />
        </label>
        {"problem" in parsed ? <p className="muted">{parsed.problem}</p> : null}
        <p className="muted">
          Current version {view.controls.version}
          {view.controls.updatedAt ? ` · ${new Date(view.controls.updatedAt).toLocaleString()}` : " · built-in defaults"}.
        </p>
        <Button
          variant="primary"
          fullWidth
          disabled={!changed || busy || "problem" in parsed}
          loading={busy}
          loadingLabel="Saving controls…"
          startIcon={<Save />}
          onClick={props.onSave}
        >
          Save controls
        </Button>
      </section>
    </div>
  );
}
