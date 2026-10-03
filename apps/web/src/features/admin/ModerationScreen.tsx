import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../shared/Button.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { dateTime, relative, titleCase } from "./format.js";
import { readShareSnapshot, type ShareSnapshot } from "./shareModeration.js";
import { ShareReview, type ShareActionHandler } from "./ShareReview.js";
import { useModerationReports } from "./useAdminData.js";
import type { ModerationReport, ShareModerationAction } from "./types.js";

const FILTERS = ["pending", "reviewed", "actioned", "dismissed", "all"] as const;
const DECISIONS = [
  { value: "actioned", label: "Action" },
  { value: "dismissed", label: "Dismiss" },
  { value: "reviewed", label: "Mark reviewed" }
] as const;

/**
 * The reader-reported content queue.
 *
 * `GET`/`PATCH /api/admin/moderation/reports` have existed since the safety work
 * landed but had no interface, so reports could only be actioned with curl.
 *
 * Shared books land here two ways: a reader's report from the public page, and
 * the caption gate filing its own review when it had no verdict on an author's
 * note. Both carry the live share, which `ShareReview` acts on.
 */
export function ModerationScreen() {
  const reports = useModerationReports();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("pending");

  const all = reports.data?.reports ?? [];
  const visible = filter === "all" ? all : all.filter((report) => report.status === filter);
  const pendingCount = all.filter((report) => report.status === "pending").length;

  return (
    <div className={`admin-page${reports.stale ? " is-stale" : ""}`}>
      <div className="admin-filter-row">
        <SegmentedControl
          label="Filter by status"
          options={FILTERS.map((option) => ({
            value: option,
            label: option === "pending" && pendingCount > 0 ? `Pending (${pendingCount})` : titleCase(option)
          }))}
          value={filter}
          onChange={setFilter}
        />
      </div>

      {reports.error ? <div className="error-banner">{reports.error}</div> : null}

      {!reports.data ? (
        <div className="empty-state">
          <Loader2 className="spin" size={20} aria-hidden /> Loading reports…
        </div>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          {filter === "pending" ? "Nothing waiting on a decision." : `No ${filter} reports.`}
        </div>
      ) : (
        <div className="moderation-list">
          {visible.map((report) => (
            <ReportCard
              key={report.id}
              report={report}
              busy={reports.saving?.id === report.id}
              busyDecision={reports.saving?.id === report.id ? reports.saving.status : null}
              busyShareAction={reports.sharing?.id === report.id ? reports.sharing.action : null}
              onReview={(status, notes) => void reports.review(report.id, status, notes)}
              onShareAction={(shareId, action, reason) => reports.moderateShare(report.id, shareId, action, reason)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReportCard(props: {
  report: ModerationReport;
  busy: boolean;
  busyDecision: string | null;
  busyShareAction: ShareModerationAction | null;
  onReview: (status: string, notes: string) => void;
  onShareAction: ShareActionHandler;
}) {
  const [notes, setNotes] = useState(props.report.reviewNotes ?? "");
  const { report } = props;
  const settled = report.status !== "pending";
  const isShare = report.targetType === "book_share";
  const snapshot = isShare ? readShareSnapshot(report.targetSnapshot) : null;
  const saving = props.busy || props.busyShareAction !== null;

  return (
    <section className={`work-section report-card${settled ? " is-settled" : ""}`}>
      <div className="section-title">
        <h3>{snapshot?.kind === "caption_review" ? "Note held for review" : titleCase(report.reason)}</h3>
        <span className={`report-pill is-${report.status}`}>{report.status}</span>
      </div>

      <ul className="fact-list">
        <li>
          <span>Target</span>
          <span>{targetLabel(report, snapshot)}</span>
        </li>
        <li>
          <span>Reported by</span>
          <span>{reporterLabel(report, snapshot)}</span>
        </li>
        <li>
          <span>Received</span>
          <span title={dateTime(report.createdAt)}>{relative(report.createdAt)}</span>
        </li>
        {report.reviewedAt ? (
          <li>
            <span>Reviewed</span>
            <span>{relative(report.reviewedAt)}</span>
          </li>
        ) : null}
      </ul>

      {report.comment ? <p className="report-comment">“{report.comment}”</p> : null}

      {isShare ? (
        <ShareReview
          report={report}
          busyAction={props.busyShareAction}
          locked={props.busy}
          onAction={props.onShareAction}
        />
      ) : null}

      <label>
        Review notes
        <input
          value={notes}
          placeholder="What you decided and why"
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>

      <div className="pricing-actions">
        {DECISIONS.map((decision) => {
          const loading = props.busyDecision === decision.value;
          return (
            <Button
              key={decision.value}
              variant={decision.value === "actioned" ? "danger" : "secondary"}
              size="sm"
              disabled={saving}
              loading={loading}
              loadingLabel={`${decision.label}…`}
              onClick={() => props.onReview(decision.value, notes)}
            >
              {decision.label}
            </Button>
          );
        })}
      </div>
    </section>
  );
}

function targetLabel(report: ModerationReport, snapshot: ShareSnapshot | null): string {
  if (snapshot) return `Shared book · ${report.projectTitle ?? snapshot.title ?? "Untitled book"}`;
  if (report.targetType === "project") return report.projectTitle ?? "Untitled book";
  if (report.targetType === "voice_call") return `Voice call · ${report.projectTitle ?? "saved character"}`;
  if (report.targetType === "chat_message") return `Chat reply · ${report.projectTitle ?? "Untitled book"}`;
  return `Image · ${report.imageAssetId ?? "unknown"}`;
}

function reporterLabel(report: ModerationReport, snapshot: ShareSnapshot | null): string {
  if (report.reporterEmail) return report.reporterEmail;
  if (snapshot?.kind === "caption_review") return "Caption gate (no verdict)";
  if (snapshot?.kind === "public_report") return "Anonymous reader, public page";
  return "anonymous";
}
