import { ShieldCheck } from "lucide-react";
import type { ProjectQuality, QualityFinding } from "../../api.js";

/**
 * The book's quality verdict for the operator, in the two halves the app
 * draws apart: what the reader is shown (findings of a type with measured
 * precision, each quoted on its page) and the diagnostics the compile also
 * measured — the repair pass's targets and the operator's to judge. A report
 * graded before the split has no console half, and says so.
 */
const STATE_LABELS: Record<ProjectQuality["state"], string> = {
  pending: "No verdict yet",
  passed: "Passed",
  review_recommended: "Review recommended",
  blocked: "Blocked"
};

function FindingList(props: { findings: QualityFinding[]; empty: string }) {
  if (props.findings.length === 0) return <p className="muted">{props.empty}</p>;
  return (
    <ul className="quality-findings">
      {props.findings.map((finding, position) => (
        <li key={`${finding.code}-${position}`}>
          <div>
            <code>{finding.code}</code> <span className={`quality-severity is-${finding.severity}`}>{finding.severity}</span>{" "}
            <span className="muted">{finding.source}</span>
            {finding.affectedPageIndexes.length > 0 ? <span className="muted"> · pages {finding.affectedPageIndexes.join(", ")}</span> : null}
          </div>
          <p>{finding.message}</p>
          {finding.evidence?.map((item) => (
            <blockquote key={`${item.pageIndex}-${item.excerpt}`}>p.{item.pageIndex}: “{item.excerpt}”</blockquote>
          ))}
        </li>
      ))}
    </ul>
  );
}

export function QualitySection(props: { quality: ProjectQuality | undefined }) {
  const quality = props.quality;
  if (!quality || quality.state === "pending") return null;
  const split = quality.readerPolicy !== undefined;
  return (
    <section className="work-section quality-section">
      <div className="section-title">
        <ShieldCheck size={18} aria-hidden />
        <h3>Quality verdict</h3>
      </div>
      <p>
        <b>{STATE_LABELS[quality.state]}</b>
        {quality.score !== null ? <span className="muted"> · score {quality.score}</span> : null}
        {split ? <span className="muted"> · graded by {quality.readerPolicy}</span> : <span className="muted"> · graded before the reader/diagnostics split</span>}
      </p>
      <h4>{split ? "Shown to the reader" : "Every finding (shown to the reader)"}</h4>
      <FindingList findings={quality.issues} empty="Nothing is shown to the reader." />
      {split ? (
        <>
          <h4>Diagnostics (console only)</h4>
          <FindingList findings={quality.diagnosticIssues ?? []} empty="The compile filed no diagnostics." />
        </>
      ) : null}
    </section>
  );
}
