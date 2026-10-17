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
  unknown: "This server sent no pipeline for these rows.",
  shelved:
    "Measured and switched off on every tier; the code stays for a later experiment, so these are not offered per tier. A revision an experiment script writes can still turn one on, and its row then says where.",
  removed:
    "The stage these switched no longer exists. A stored revision may still list one; it runs nowhere, and each row says when and why it went."
};

/** The tiers a shelved row's stored revision still runs it on, or that it runs nowhere. */
export function shelvedRowState(assigned: readonly string[]): string {
  return assigned.length === 0 ? "Off on every tier." : `Still on in the stored revision for: ${assigned.join(", ")}.`;
}

/**
 * Rows by the first pipeline the server named for them, in the order the
 * pipelines run — planning, per-page, composed — with rows the server did not
 * place after them, then shelved rows and last the removed ones, each in a group of their own. A gate that reaches both generation pipelines sits with the
 * per-page group and says so on its row, so nothing appears twice and a
 * checkbox still has exactly one place.
 */
export function groupFeatureRows(rows: QualityFeature[]): QualityFeatureGroup[] {
  const order = ["planning", "per-page", "composed", "unknown", "shelved", "removed"];
  const grouped = new Map<string, QualityFeature[]>();
  for (const row of rows) {
    const pipeline = row.retired ? "removed" : row.shelved ? "shelved" : row.pipelines?.[0] ?? "unknown";
    const bucket = grouped.get(pipeline) ?? [];
    bucket.push(row);
    grouped.set(pipeline, bucket);
  }
  return order
    .filter((pipeline) => grouped.has(pipeline))
    .map((pipeline) => ({
      pipeline,
      title: pipeline === "unknown" ? "Unplaced" : pipeline === "shelved" ? "Shelved" : pipeline === "removed" ? "Removed" : pipelineTitle(pipeline),
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
            {group.pipeline === "shelved" || group.pipeline === "removed" ? null : <PipelineChip pipeline={group.pipeline} />}
            <span>{group.title}</span>
          </h4>
          <p className="muted">{group.summary}</p>
          <ul className="quality-gate-list">
            {group.rows.map((feature) => {
              const assigned = props.draft[feature.id] ?? [];
              const off = assigned.length === 0;
              if (feature.retired) {
                return (
                  <li key={feature.id} className="quality-gate-row is-off">
                    <div>
                      <strong>
                        {feature.label}
                        {feature.stage ? <span className="quality-gate-stage">{feature.stage}</span> : null}
                        <span className="quality-gate-off">Removed</span>
                      </strong>
                      <small>{feature.summary}</small>
                    </div>
                  </li>
                );
              }
              if (feature.shelved) {
                return (
                  <li key={feature.id} className="quality-gate-row is-off">
                    <div>
                      <strong>
                        {feature.label}
                        {feature.stage ? <span className="quality-gate-stage">{feature.stage}</span> : null}
                        <span className="quality-gate-off">Shelved</span>
                      </strong>
                      <small>{feature.summary}</small>
                      <small>
                        {feature.pipelines?.length ? `Reaches: ${feature.pipelines.map(pipelineTitle).join(", ")}. ` : ""}
                        {shelvedRowState(assigned)}
                      </small>
                    </div>
                  </li>
                );
              }
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
