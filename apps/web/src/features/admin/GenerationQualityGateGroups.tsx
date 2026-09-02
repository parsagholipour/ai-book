import type { QualityFeature, ServerFeatureId } from "./GenerationQualityScreen.js";
import { PipelineChip, pipelineTitle } from "./GenerationPipelinePanel.js";
import { QualityTierFieldset, type ServerEffortTier } from "./GenerationQualityControls.js";

/**
 * The gate rows, grouped by the pipeline whose books they change. Split from
 * the screen for the file-size budget; the screen still owns the draft, the
 * claim and the save.
 */

type QualityFeatureGroup = {
  pipeline: string;
  title: string;
  summary: string;
  rows: QualityFeature[];
};

const GROUP_SUMMARIES: Record<string, string> = {
  planning: "Runs before a strategy is chosen, so it reaches every book.",
  "per-page":
    "Only books written page by page: picture books, explicit per-page strategy picks, and books under 12 pages. A checkbox here changes nothing for a composed book.",
  composed:
    "Books of 12 or more pages outside KIDS take this pipeline by default. Its stages are listed below the gates.",
  unknown: "This server sent no pipeline for these rows."
};

/**
 * Rows by the first pipeline the server named for them, in the order the
 * pipelines run — planning, per-page, composed — with rows the server did not
 * place last. A gate that reaches both generation pipelines sits with the
 * per-page group and says so on its row, so nothing appears twice and a
 * checkbox still has exactly one place.
 */
export function groupFeatureRows(rows: QualityFeature[]): QualityFeatureGroup[] {
  const order = ["planning", "per-page", "composed", "unknown"];
  const grouped = new Map<string, QualityFeature[]>();
  for (const row of rows) {
    const pipeline = row.pipelines?.[0] ?? "unknown";
    const bucket = grouped.get(pipeline) ?? [];
    bucket.push(row);
    grouped.set(pipeline, bucket);
  }
  return order
    .filter((pipeline) => grouped.has(pipeline))
    .map((pipeline) => ({
      pipeline,
      title: pipeline === "unknown" ? "Unplaced" : pipelineTitle(pipeline),
      summary: GROUP_SUMMARIES[pipeline] ?? "",
      rows: grouped.get(pipeline) ?? []
    }));
}


export function QualityGateGroups(props: {
  groups: QualityFeatureGroup[];
  draft: Partial<Record<string, ServerEffortTier[]>>;
  busy: boolean;
  onToggle: (feature: ServerFeatureId, tier: ServerEffortTier) => void;
}) {
  return (
    <>
      {props.groups.map((group) => (
        <div key={group.pipeline} className="quality-gate-group">
          <h4>
            <PipelineChip pipeline={group.pipeline} />
            <span>{group.title}</span>
          </h4>
          <p className="muted">{group.summary}</p>
          <ul className="quality-gate-list">
            {group.rows.map((feature) => {
              const assigned = props.draft[feature.id] ?? [];
              const off = assigned.length === 0;
              return (
                <li key={feature.id} className={`quality-gate-row${off ? " is-off" : ""}`}>
                  <div>
                    <strong>
                      {feature.label}
                      {feature.stage ? <span className="quality-gate-stage">{feature.stage}</span> : null}
                      {off ? <span className="quality-gate-off">Off</span> : null}
                    </strong>
                    <small>{feature.summary}</small>
                    {feature.pipelines && feature.pipelines.length > 1 ? (
                      <small>
                        Also reaches: {feature.pipelines.filter((pipeline) => pipeline !== group.pipeline).map(pipelineTitle).join(", ")}
                      </small>
                    ) : null}
                  </div>
                  <QualityTierFieldset
                    label={feature.label}
                    assigned={assigned}
                    disabled={props.busy}
                    onToggle={(tier) => props.onToggle(feature.id, tier)}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}
