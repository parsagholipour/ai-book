import { useState } from "react";
import { Ban, Share2 } from "lucide-react";
import { apiPost } from "../../api.js";
import { Button } from "../shared/Button.js";
import { readError } from "../shared/formatters.js";
import { count, dateTime, relative } from "./format.js";
import type { AccountModeration, AccountModerationAction, AdminUserDetail } from "./types.js";

/** `ACCOUNT_MODERATION_REASON_MAX` in apps/api/src/accountModeration.ts. */
const REASON_MAX = 1000;

/** Play statuses under which Google may still charge the reader. */
const RENEWING_STATUSES = new Set(["ACTIVE", "GRACE_PERIOD", "PAUSED", "CANCELED"]);

const ACTION_COPY: Record<AccountModerationAction, { label: string; confirm: string; done: string; effect: (live: number) => string }> = {
  suspend: {
    label: "Suspend account…",
    confirm: "Suspend",
    done: "suspended",
    effect: (live) =>
      `Signs them out on every device and refuses every request and sign-in, takes ${shares(live)} down, and stops every book in progress — what was not delivered is refunded, as if they had pressed Stop.`
  },
  unsuspend: {
    label: "Lift suspension…",
    confirm: "Lift suspension",
    done: "unsuspended",
    effect: () =>
      "They can sign in again. Stopped books stay stopped, and shares this account's suspension took down come back as stopped shares they can share again."
  },
  disable_sharing: {
    label: "Turn sharing off…",
    confirm: "Turn sharing off",
    done: "sharing off",
    effect: (live) => `Takes ${shares(live)} down and refuses new shares and remixes from this account. They keep using the app.`
  },
  enable_sharing: {
    label: "Turn sharing on…",
    confirm: "Turn sharing on",
    done: "sharing on",
    effect: () => "They can share and remix again; shares this switch took down come back as stopped shares they can share again."
  }
};

function shares(live: number): string {
  return live === 1 ? "their 1 live share" : `their ${count(live)} live shares`;
}

/**
 * The operator's levers on one account (`POST /api/admin/users/:id/moderation`,
 * apps/api/src/accountModeration.ts): suspend and lift, sharing off and on,
 * each with a reason that is kept beside what it did. A suspension is not a
 * deletion and does not cancel a Google Play subscription, which the panel says
 * whenever the reader has one that may renew.
 */
export function AccountModerationPanel(props: { detail: AdminUserDetail; onChanged: () => Promise<void> | void }) {
  const { user, moderation, subscriptions } = props.detail;
  const [open, setOpen] = useState<AccountModerationAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const deleted = user.status === "DISABLED";
  const operatorAccount = user.id === "local-admin";
  const renewing = subscriptions.some((subscription) => RENEWING_STATUSES.has(subscription.status));
  const actions: AccountModerationAction[] = [
    moderation.suspended ? "unsuspend" : "suspend",
    moderation.sharingDisabled ? "enable_sharing" : "disable_sharing"
  ];
  const trimmed = reason.trim();

  async function submit(action: AccountModerationAction) {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<{ effects: unknown }>(`/api/admin/users/${encodeURIComponent(user.id)}/moderation`, {
        action,
        reason: trimmed
      });
      setNotice(`Account ${ACTION_COPY[action].done}: ${effectsSummary(result.effects) || "nothing else to change"}.`);
      setOpen(null);
      setReason("");
      await props.onChanged();
    } catch (actionError) {
      setError(readError(actionError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="work-section">
      <div className="section-title">
        <h3>Account moderation</h3>
        <span className="muted admin-count">{count(moderation.actions.length)} actions</span>
      </div>

      <ul className="fact-list">
        <li className={moderation.suspended ? "fact-flag" : ""}>
          <span>Account</span>
          <span>{deleted ? "deleted (tombstone)" : moderation.suspended ? "suspended" : "active"}</span>
        </li>
        <li className={moderation.sharingDisabled ? "fact-flag" : ""}>
          <span>Sharing</span>
          <span>
            {moderation.sharingDisabled
              ? `off${moderation.sharingDisabledAt ? ` since ${relative(moderation.sharingDisabledAt)}` : ""}`
              : "on"}
          </span>
        </li>
        <li>
          <span>Live shares</span>
          <span>{count(moderation.liveShares)}</span>
        </li>
      </ul>

      {renewing && !deleted ? (
        <p className="hero-caveat">
          Their Google Play subscription is not cancelled by a suspension: it keeps renewing until they cancel it in Play or
          the account is deleted, and each renewal still grants its credits. Cancel or refund it in Play Console if it should
          stop.
        </p>
      ) : null}

      {deleted || operatorAccount ? (
        <p className="muted">
          {deleted ? "A deleted account has nothing left to suspend." : "The console's own account cannot be moderated."}
        </p>
      ) : (
        <div className="pricing-actions">
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === "suspend" || action === "disable_sharing" ? "danger" : "secondary"}
              disabled={busy || open !== null}
              startIcon={action === "suspend" || action === "unsuspend" ? <Ban /> : <Share2 />}
              onClick={() => {
                setOpen(action);
                setNotice(null);
                setError(null);
              }}
            >
              {ACTION_COPY[action].label}
            </Button>
          ))}
        </div>
      )}

      {open ? (
        <form
          className="share-takedown"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed) void submit(open);
          }}
        >
          <p className="field-hint">{ACTION_COPY[open].effect(moderation.liveShares)}</p>
          <label>
            Why (kept with the action; the reader never sees it)
            <textarea
              value={reason}
              rows={3}
              maxLength={REASON_MAX}
              placeholder="What they did, and where you saw it"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="pricing-actions">
            <Button
              type="submit"
              size="sm"
              variant={open === "suspend" || open === "disable_sharing" ? "danger" : "primary"}
              disabled={busy || !trimmed}
              loading={busy}
              loadingLabel="Saving…"
            >
              {ACTION_COPY[open].confirm}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}
      {notice ? (
        <p className="muted" role="status">
          {notice}
        </p>
      ) : null}

      {moderation.actions.length > 0 ? <ActionHistory actions={moderation.actions} /> : null}
    </section>
  );
}

function ActionHistory(props: { actions: AccountModeration["actions"] }) {
  return (
    <ul className="fact-list">
      {props.actions.map((entry) => (
        <li key={entry.id}>
          <span title={dateTime(entry.createdAt)}>
            {ACTION_COPY[entry.action]?.done ?? entry.action} · {relative(entry.createdAt)}
          </span>
          <span>
            “{entry.reason}”
            {effectsSummary(entry.effects) ? <span className="muted"> — {effectsSummary(entry.effects)}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "2 sessions signed out, 1 share taken down, 3 books stopped" from a JSON column, read field by field. */
export function effectsSummary(effects: unknown): string {
  const record = effects && typeof effects === "object" && !Array.isArray(effects) ? (effects as Record<string, unknown>) : {};
  const number = (key: string) => (typeof record[key] === "number" ? (record[key] as number) : 0);
  const listed = (key: string) => (Array.isArray(record[key]) ? (record[key] as unknown[]).length : 0);
  const plural = (value: number, one: string, many: string) => `${count(value)} ${value === 1 ? one : many}`;
  return [
    number("sessionsRevoked") ? plural(number("sessionsRevoked"), "session signed out", "sessions signed out") : null,
    listed("sharesTakenDown") ? plural(listed("sharesTakenDown"), "share taken down", "shares taken down") : null,
    listed("sharesRestored") ? plural(listed("sharesRestored"), "share restored as stopped", "shares restored as stopped") : null,
    number("projectsStopped") ? plural(number("projectsStopped"), "book stopped", "books stopped") : null,
    number("stopFailures") ? plural(number("stopFailures"), "book could not be stopped", "books could not be stopped") : null
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}
