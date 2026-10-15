import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Link } from "react-router";
import { Button } from "../shared/Button.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { dateTime, relative, titleCase } from "./format.js";
import { ReportSnapshotView } from "./ReportSnapshot.js";
import { readShareSnapshot, sharesWithHeldBookText, type ShareSnapshot } from "./shareModeration.js";
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
 * Shared books land here three ways: a reader's report from the public page,
 * the caption gate filing its own review when it had no verdict on an author's
 * note, and the sexual-content screen filing one when it could not decide part
 * of the book's text (`book_text_review` — the share is live meanwhile). All
 * carry the live share, which `ShareReview` acts on. Pending child-safety and
 * sexual-content reports and held book texts email the owner until settled
 * (the `safety_reports` alert), so the banner counts them.
 *
 * Every other AI surface the app shows — a chat reply in either chat, a book
 * plan, a drawn character picture, a Writing Studio suggestion — files a
 * snapshot of what the reader saw, which `ReportSnapshotView` renders whole.
 */
export function ModerationScreen() {
  const reports = useModerationReports();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("pending");

  const all = reports.data?.reports ?? [];
  const visible = filter === "all" ? all : all.filter((report) => report.status === filter);
  const pendingCount = all.filter((report) => report.status === "pending").length;
  const heldBookText = sharesWithHeldBookText(all);
  const urgent = urgentCounts(all);

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
      {urgent ? (
        <p className="hero-caveat">
          <AlertTriangle size={14} aria-hidden /> {urgent} waiting. These alert the owner by email until each is
          actioned, dismissed or marked reviewed.
        </p>
      ) : null}

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
              heldBookText={report.bookShareId ? heldBookText.has(report.bookShareId) : false}
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
  heldBookText: boolean;
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
        <h3>
          {snapshot?.kind === "caption_review"
            ? "Note held for review"
            : snapshot?.kind === "book_text_review"
              ? "Shared book text held for review"
              : titleCase(report.reason)}
        </h3>
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
        {report.owner ? (
          <li>
            <span>Book's account</span>
            <span>
              {/* Where it can be suspended, or its sharing turned off. */}
              <Link className="share-link" to={`/admin/users?user=${encodeURIComponent(report.owner.id)}`}>
                {report.owner.email}
              </Link>
            </span>
          </li>
        ) : null}
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

      <ReportSnapshotView report={report} />

      {isShare ? (
        <ShareReview
          report={report}
          busyAction={props.busyShareAction}
          locked={props.busy}
          onAction={props.onShareAction}
          heldBookText={props.heldBookText}
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

/** "1 child-safety report, 2 held book texts" — the pending reports the `safety_reports` alert counts — or null. */
export function urgentCounts(reports: readonly ModerationReport[]): string | null {
  const pending = reports.filter((report) => report.status === "pending");
  const childSafety = pending.filter((report) => report.reason === "child_safety").length;
  const sexual = pending.filter((report) => report.reason === "sexual_content").length;
  const heldText = pending.filter(
    (report) => report.targetType === "book_share" && readShareSnapshot(report.targetSnapshot).kind === "book_text_review"
  ).length;
  const parts = [
    childSafety ? `${childSafety} child-safety ${childSafety === 1 ? "report" : "reports"}` : null,
    sexual ? `${sexual} sexual-content ${sexual === 1 ? "report" : "reports"}` : null,
    heldText ? `${heldText} held book ${heldText === 1 ? "text" : "texts"}` : null
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

function targetLabel(report: ModerationReport, snapshot: ShareSnapshot | null): string {
  if (snapshot) return `Shared book · ${report.projectTitle ?? snapshot.title ?? "Untitled book"}`;
  if (report.targetType === "project") return report.projectTitle ?? "Untitled book";
  if (report.targetType === "voice_call") return `Voice call · ${report.projectTitle ?? "saved character"}`;
  if (report.targetType === "chat_message") return `Chat reply · ${report.projectTitle ?? "Untitled book"}`;
  if (report.targetType === "creation_chat_message") return `Creation chat reply · ${snapshotText(report, "chatTitle") ?? "New book"}`;
  if (report.targetType === "book_plan") return `Book plan · ${report.projectTitle ?? "Untitled book"}`;
  if (report.targetType === "character_image") return `Character picture · ${snapshotText(report, "characterName") ?? "saved character"}`;
  if (report.targetType === "studio_suggestion") return `Writing Studio suggestion · ${report.projectTitle ?? "Untitled book"}`;
  if (report.targetType === "image_asset") return `Image · ${report.imageAssetId ?? "unknown"}`;
  return `${titleCase(report.targetType)} · ${report.projectTitle ?? "unknown"}`;
}

function snapshotText(report: ModerationReport, key: string): string | null {
  const snapshot = report.targetSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function reporterLabel(report: ModerationReport, snapshot: ShareSnapshot | null): string {
  if (report.reporterEmail) return report.reporterEmail;
  if (snapshot?.kind === "caption_review") return "Caption gate (no verdict)";
  if (snapshot?.kind === "book_text_review") return "Sexual-content screen (no verdict on part of the book)";
  if (snapshot?.kind === "public_report") return "Anonymous reader, public page";
  return "anonymous";
}
