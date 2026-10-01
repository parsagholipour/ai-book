import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "../shared/Button.js";
import { count, dateTime, duration, relative, titleCase } from "./format.js";
import {
  probabilityLabel,
  rankedProbabilities,
  readCaptionVerdict,
  readShareSnapshot,
  shareActionAvailability,
  TAKEDOWN_REASON_MAX,
  words
} from "./shareModeration.js";
import type { AdminShare, CaptionVerdict, ModerationAttempt, ModerationReport, ShareModerationAction } from "./types.js";

export type ShareActionHandler = (shareId: string, action: ShareModerationAction, reason?: string) => Promise<boolean>;

/**
 * The shared-book half of a report card: the author's note as the public page
 * shows it, what the moderation gate said about it — every attempt, with Jev's
 * whole distribution rather than only the option it chose — and the three share
 * actions. The report's own Action / Dismiss buttons stay below it for a report
 * that needs no change to the share.
 */
export function ShareReview(props: {
  report: ModerationReport;
  /** The share action in flight on this card, if any. */
  busyAction: ShareModerationAction | null;
  /** Something else on this card is saving. */
  locked: boolean;
  onAction: ShareActionHandler;
}) {
  const [takingDown, setTakingDown] = useState(false);
  const [reason, setReason] = useState("");
  const share = props.report.share ?? null;
  const snapshot = readShareSnapshot(props.report.targetSnapshot);
  // The live record carries the operator's decision; the snapshot is what the gate filed.
  const verdict = readCaptionVerdict(share?.captionVerdict) ?? snapshot.verdict;

  if (!share) {
    return (
      <div className="share-review">
        <p className="muted">This share no longer exists — its book was deleted.</p>
        {snapshot.caption ? <NoteBlock label="Note when reported" text={snapshot.caption} /> : null}
        {verdict ? <VerdictDetail verdict={verdict} /> : null}
      </div>
    );
  }

  const available = shareActionAvailability(share);
  const busy = props.busyAction !== null || props.locked;
  const trimmedReason = reason.trim();

  async function takeDown(shareId: string) {
    if (await props.onAction(shareId, "take_down", trimmedReason)) {
      setTakingDown(false);
      setReason("");
    }
  }

  return (
    <div className="share-review">
      {share.caption ? (
        <NoteBlock label="Author's note" text={share.caption} />
      ) : (
        <p className="muted">No note on this share.</p>
      )}
      {snapshot.caption && snapshot.caption !== share.caption ? (
        <NoteBlock label="Note when reported" text={snapshot.caption} />
      ) : null}

      <ShareFacts share={share} />

      {verdict ? <VerdictDetail verdict={verdict} /> : share.caption ? <p className="muted">No gate record for this note.</p> : null}

      <div className="pricing-actions">
        <Button
          size="sm"
          disabled={busy || !available.approve_caption.enabled}
          title={available.approve_caption.why ?? undefined}
          loading={props.busyAction === "approve_caption"}
          loadingLabel="Approving…"
          onClick={() => void props.onAction(share.id, "approve_caption")}
        >
          Approve caption
        </Button>
        <Button
          size="sm"
          disabled={busy || !available.remove_caption.enabled}
          title={available.remove_caption.why ?? undefined}
          loading={props.busyAction === "remove_caption"}
          loadingLabel="Removing…"
          onClick={() => void props.onAction(share.id, "remove_caption")}
        >
          Remove caption
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={busy || takingDown || !available.take_down.enabled}
          title={available.take_down.why ?? undefined}
          onClick={() => setTakingDown(true)}
        >
          Take down share…
        </Button>
      </div>

      {takingDown ? (
        <form
          className="share-takedown"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmedReason) void takeDown(share.id);
          }}
        >
          <label>
            Reason the author will see
            <textarea
              value={reason}
              rows={3}
              maxLength={TAKEDOWN_REASON_MAX}
              placeholder="Say what broke the rules, in words the author can act on"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <p className="field-hint">
            The public page stops answering and the author sees this in the app. {reason.length}/{TAKEDOWN_REASON_MAX}
          </p>
          <div className="pricing-actions">
            <Button
              type="submit"
              variant="danger"
              size="sm"
              disabled={busy || !trimmedReason}
              loading={props.busyAction === "take_down"}
              loadingLabel="Taking down…"
            >
              Confirm take down
            </Button>
            <Button size="sm" disabled={props.busyAction === "take_down"} onClick={() => setTakingDown(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function ShareFacts(props: { share: AdminShare }) {
  const { share } = props;
  return (
    <ul className="fact-list">
      <li>
        <span>Book page</span>
        <span>
          <a className="share-link" href={share.url} target="_blank" rel="noreferrer noopener">
            /s/{share.slug} <ExternalLink size={12} aria-hidden />
          </a>
        </span>
      </li>
      <li>
        <span>Share</span>
        <span>
          <StatusPill value={share.status} /> ·{" "}
          {share.mode === "full" ? "full book" : `preview${share.previewPages ? ` · ${share.previewPages} pages` : ""}`}
        </span>
      </li>
      <li>
        <span>Caption</span>
        <span>
          <StatusPill value={share.captionStatus} />
        </span>
      </li>
      <li>
        <span>PDF views</span>
        <span>{count(share.viewCount)}</span>
      </li>
      {share.status === "taken_down" && share.takedownReason ? (
        <li>
          <span>Take-down reason</span>
          <span>{share.takedownReason}</span>
        </li>
      ) : null}
    </ul>
  );
}

function VerdictDetail(props: { verdict: CaptionVerdict }) {
  const { verdict } = props;
  return (
    <div className="share-verdict">
      <p className="share-verdict-line">
        <strong>Gate: {verdictSummary(verdict)}</strong>
        {verdict.decidedAt ? (
          <span className="muted" title={dateTime(verdict.decidedAt)}>
            {" "}
            · {relative(verdict.decidedAt)}
          </span>
        ) : null}
      </p>
      {verdict.operator ? (
        <p className="share-verdict-line">
          Operator: {words(verdict.operator.action)}
          {verdict.operator.at ? ` · ${relative(verdict.operator.at)}` : ""}
          {verdict.operator.reason ? ` — “${verdict.operator.reason}”` : ""}
        </p>
      ) : null}
      {verdict.attempts.length === 0 ? (
        <p className="muted">No model answered.</p>
      ) : (
        verdict.attempts.map((attempt, index) => <AttemptDetail key={`${attempt.role}-${index}`} attempt={attempt} />)
      )}
    </div>
  );
}

function verdictSummary(verdict: CaptionVerdict): string {
  const by = verdict.decidedBy ? ` by ${verdict.decidedBy}` : "";
  if (verdict.verdict === "allowed") return `allowed${by}`;
  if (verdict.verdict === "refused") return `refused${verdict.violation ? ` — ${words(verdict.violation)}` : ""}${by}`;
  return `no verdict${verdict.reason ? ` — ${words(verdict.reason)}` : ""}`;
}

function AttemptDetail(props: { attempt: ModerationAttempt }) {
  const { attempt } = props;
  const ranked = rankedProbabilities(attempt.probabilities);
  return (
    <div className="share-attempt">
      <p className="share-attempt-head">
        <strong>{titleCase(attempt.role)}</strong> · {attempt.provider}/{attempt.model} · {duration(attempt.durationMs)}
        {attempt.selectedOption ? (
          <>
            {" "}
            · chose <strong>{words(attempt.selectedOption)}</strong>
          </>
        ) : null}
      </p>
      {attempt.escalationReason ? <p className="muted">Escalated: {words(attempt.escalationReason)}</p> : null}
      {attempt.error ? <p className="share-attempt-error">{attempt.error}</p> : null}
      {ranked.length > 0 ? (
        <ol className="share-probabilities" aria-label={`${titleCase(attempt.role)} attempt probabilities`}>
          {ranked.map((row) => (
            <li key={row.option} className={row.option === attempt.selectedOption ? "is-chosen" : undefined}>
              <span>{words(row.option)}</span>
              <span className="share-probability-bar" aria-hidden>
                <span style={{ width: `${Math.min(100, row.probability * 100)}%` }} />
              </span>
              <span>{probabilityLabel(row.probability)}</span>
            </li>
          ))}
        </ol>
      ) : attempt.selectedOption ? (
        <p className="muted">No distribution returned.</p>
      ) : null}
    </div>
  );
}

function NoteBlock(props: { label: string; text: string }) {
  return (
    <figure className="share-note">
      <figcaption>{props.label}</figcaption>
      <blockquote dir="auto">{props.text}</blockquote>
    </figure>
  );
}

function StatusPill(props: { value: string }) {
  return <span className={`share-pill is-${props.value}`}>{words(props.value)}</span>;
}
