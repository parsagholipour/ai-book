import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../shared/Button.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { dateTime, relative, titleCase } from "./format.js";
import { useModerationReports } from "./useAdminData.js";
import type { ModerationReport } from "./types.js";

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
              onReview={(status, notes) => void reports.review(report.id, status, notes)}
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
  onReview: (status: string, notes: string) => void;
}) {
  const [notes, setNotes] = useState(props.report.reviewNotes ?? "");
  const { report } = props;
  const settled = report.status !== "pending";

  return (
    <section className={`work-section report-card${settled ? " is-settled" : ""}`}>
      <div className="section-title">
        <h3>{titleCase(report.reason)}</h3>
        <span className={`report-pill is-${report.status}`}>{report.status}</span>
      </div>

      <ul className="fact-list">
        <li>
          <span>Target</span>
          <span>
            {report.targetType === "project" ? report.projectTitle ?? "Untitled book" : `Image · ${report.imageAssetId ?? "unknown"}`}
          </span>
        </li>
        <li>
          <span>Reported by</span>
          <span>{report.reporterEmail ?? "anonymous"}</span>
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
              disabled={props.busy}
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
