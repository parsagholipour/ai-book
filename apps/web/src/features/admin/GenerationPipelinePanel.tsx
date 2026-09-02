import { GitBranch } from "lucide-react";

/**
 * The pipelines behind the quality gates: what "Auto" resolves to for each
 * category and page band, the strategies and the pipeline each writes by, and
 * every stage of both pipelines with the purposes it spends under and the
 * gates that switch it. All of it comes from the server's `pipelines` block;
 * the console restates none of the ladder.
 */

export type PipelineStrategy = {
  id: string;
  label: string;
  executionMode: string;
  pipeline: string;
  strengthScore: number;
  recommendedPageRange: { min: number; max: number };
  researchDepth: number | null;
};

export type PipelineStageCopy = {
  id: string;
  label: string;
  summary: string;
  purposes: string[];
  lane: string;
  calls: string;
  gates: string[];
};

export type GenerationPipelines = {
  strategies: PipelineStrategy[];
  routing: { pageBands: number[]; rows: Array<{ category: string; strategyIds: string[] }> };
  stages: Record<string, PipelineStageCopy[]>;
};

const PIPELINE_TITLES: Record<string, string> = {
  planning: "Every book (planning)",
  "per-page": "Per-page pipeline",
  composed: "Composed chapters"
};

export function pipelineTitle(pipeline: string): string {
  return PIPELINE_TITLES[pipeline] ?? pipeline;
}

export function PipelineChip(props: { pipeline: string }) {
  return <span className={`pipeline-chip pipeline-chip-${props.pipeline}`}>{pipelineTitle(props.pipeline)}</span>;
}

function shortStrategyLabel(strategy: PipelineStrategy | undefined, id: string): string {
  if (!strategy) return id;
  return strategy.label.replace(/ generation$/i, "");
}

export function GenerationPipelinePanel(props: { pipelines: GenerationPipelines; gateLabels: Map<string, string> }) {
  const strategies = new Map(props.pipelines.strategies.map((strategy) => [strategy.id, strategy]));
  const stageOrder = ["planning", "per-page", "composed"].filter((pipeline) => props.pipelines.stages[pipeline]);
  return (
    <section className="work-section safety-settings-card generation-pipeline-panel">
      <div className="section-title">
        <GitBranch size={18} aria-hidden />
        <h3>Which pipeline writes which book</h3>
      </div>
      <p className="muted">
        A gate only changes the books its pipeline writes. "Auto" resolves by category and page count, sampled
        below through the real router with an empty prompt; a prompt carrying research words can move a book onto
        the research variant. An explicit strategy on a project wins when the page count fits its range.
      </p>
      <div className="admin-table-scroll">
        <table className="admin-table pipeline-routing-table">
          <thead>
            <tr>
              <th>Category</th>
              {props.pipelines.routing.pageBands.map((pages) => (
                <th key={pages} className="numeric">{pages} pages</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.pipelines.routing.rows.map((row) => (
              <tr key={row.category}>
                <td><span className="cost-name">{row.category}</span></td>
                {row.strategyIds.map((id, index) => {
                  const strategy = strategies.get(id);
                  return (
                    <td key={`${row.category}:${index}`} className={`pipeline-cell pipeline-cell-${strategy?.pipeline ?? "unknown"}`}>
                      <span>{shortStrategyLabel(strategy, id)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pipeline-strategies">
        {props.pipelines.strategies.map((strategy) => (
          <div key={strategy.id} className="pipeline-strategy">
            <strong>{strategy.label}</strong>
            <span className="muted admin-subtle">
              <code>{strategy.id}</code> · {strategy.executionMode} · {strategy.recommendedPageRange.min}–{strategy.recommendedPageRange.max} pages
              {strategy.researchDepth ? ` · research depth ${strategy.researchDepth}` : ""}
            </span>
            <PipelineChip pipeline={strategy.pipeline} />
          </div>
        ))}
      </div>

      <div className="pipeline-stage-columns">
        {stageOrder.map((pipeline) => (
          <div key={pipeline} className="pipeline-stage-column">
            <h4>
              <PipelineChip pipeline={pipeline} />
            </h4>
            <ol>
              {(props.pipelines.stages[pipeline] ?? []).map((stage) => (
                <li key={stage.id} className="pipeline-stage">
                  <strong>{stage.label}</strong>
                  <small>{stage.summary}</small>
                  <div className="pipeline-stage-meta">
                    <span><b>Lane</b> {stage.lane}</span>
                    <span><b>Calls</b> {stage.calls}</span>
                  </div>
                  <div className="pipeline-stage-meta">
                    <span><b>Purposes</b> {stage.purposes.map((purpose) => <code key={purpose}>{purpose}</code>)}</span>
                  </div>
                  <div className="pipeline-stage-meta">
                    <span>
                      <b>Gates</b>{" "}
                      {stage.gates.length === 0
                        ? <em>none, always runs</em>
                        : stage.gates.map((gate) => <span key={gate} className="pipeline-gate-chip">{props.gateLabels.get(gate) ?? gate}</span>)}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

export function readGenerationPipelines(value: unknown): GenerationPipelines | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const strategies = Array.isArray(record.strategies) ? (record.strategies as PipelineStrategy[]) : null;
  const routing = record.routing && typeof record.routing === "object" ? (record.routing as GenerationPipelines["routing"]) : null;
  const stages = record.stages && typeof record.stages === "object" ? (record.stages as GenerationPipelines["stages"]) : null;
  if (!strategies || !routing || !Array.isArray(routing.pageBands) || !Array.isArray(routing.rows) || !stages) {
    return null;
  }
  return { strategies, routing, stages };
}
