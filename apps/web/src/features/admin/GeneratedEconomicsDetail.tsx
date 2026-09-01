import { AlertTriangle, Loader2 } from "lucide-react";
import { compactCount, count, duration, percent, usd, usdFine } from "./format.js";
import type { CostKind, CostUsage, OperationCost, QaRewriteTriggerCost, QualityGateCost } from "./types.js";

export type GeneratedEconomicsDetail = {
  chargeCount: number;
  refundCount: number;
  grossCredits: number;
  refundedCredits: number;
  netCredits: number;
  revenueUsd: number;
  providerCostUsd: number;
  marginUsd: number;
  marginPercent: number | null;
  totals: CostUsage;
  byKind: Array<CostUsage & { kind: CostKind }>;
  purposes: OperationCost[];
  qualityGates?: QualityGateCost[];
  qaRewriteTriggers?: QaRewriteTriggerCost[];
};

export function GeneratedEconomicsDetailContent(props: {
  detail: GeneratedEconomicsDetail | null;
  detailMatches: boolean;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}) {
  if (props.error) {
    return (
      <div className="error-banner generated-book-detail-state">
        <span>{props.error}</span>
        <button type="button" className="admin-linkish" onClick={props.onRetry}>Retry</button>
      </div>
    );
  }
  if (props.loading || !props.detail || !props.detailMatches) {
    return (
      <div className="generated-book-detail-state muted">
        <Loader2 className="spin" size={16} aria-hidden /> Loading lifetime breakdown…
      </div>
    );
  }

  const detail = props.detail;
  return (
    <div className="generated-book-detail">
      <div className="stat-grid stat-grid-dense generated-book-economics">
        <DetailTile
          label="Charged"
          value={usd(detail.revenueUsd)}
          note={`${count(detail.netCredits)} kept of ${count(detail.grossCredits)} credits · ${count(detail.chargeCount)} charges`}
        />
        <DetailTile
          label="Refunded"
          value={`${count(detail.refundedCredits)} credits`}
          note={`${count(detail.refundCount)} ${detail.refundCount === 1 ? "refund" : "refunds"}`}
        />
        <DetailTile label="Provider cost" value={usdFine(detail.providerCostUsd)} note="settled priced calls" />
        <DetailTile
          label="Margin"
          value={usdFine(detail.marginUsd)}
          note={percent(detail.marginPercent)}
          bad={detail.marginUsd < 0}
        />
      </div>

      <div className="generated-book-kind-grid" aria-label="Provider cost by media type">
        <KindTotal label="Text" usage={kindUsage(detail, "text")} />
        <KindTotal label="Images" usage={kindUsage(detail, "image")} />
        <KindTotal label="Audio" usage={kindUsage(detail, "audio")} />
      </div>

      {detail.totals.unratedCalls > 0 ? (
        <p className="hero-caveat generated-book-warning">
          <AlertTriangle size={14} aria-hidden />
          {count(detail.totals.unratedCalls)} settled {detail.totals.unratedCalls === 1 ? "call has" : "calls have"} real
          usage but no matching rate card, so reported spend is understated.
        </p>
      ) : null}

      {detail.qualityGates ? <QualityGateCosts gates={detail.qualityGates} /> : null}
      {detail.qaRewriteTriggers ? <QaRewriteTriggerCosts triggers={detail.qaRewriteTriggers} /> : null}

      <div className="section-title generated-book-purpose-title">
        <h4>Purpose and model costs</h4>
        <span className="muted admin-subtle">{callStateSummary(detail.totals)}</span>
      </div>
      {detail.purposes.length === 0 ? (
        <p className="muted">No provider calls are associated with this item.</p>
      ) : (
        <div className="admin-table-scroll generated-book-cost-scroll">
          <table className="admin-table generated-book-cost-table">
            <thead>
              <tr>
                <th>Raw purpose</th>
                <th>Provider / model</th>
                <th className="numeric">Calls</th>
                <th>Usage</th>
                <th className="numeric">Cost</th>
              </tr>
            </thead>
            <tbody>
              {detail.purposes.flatMap((purpose) =>
                purpose.models.map((model, index) => (
                  <tr key={`${purpose.key}:${model.key}`}>
                    <td>{index === 0 ? <span className="cost-name">{purpose.key}</span> : null}</td>
                    <td>
                      <span className="cost-name">{model.model}</span>
                      <span className="muted admin-subtle">{model.provider}</span>
                    </td>
                    <td className="numeric">
                      {count(model.calls)}
                      <span className="muted admin-subtle">{callStateSummary(model)}</span>
                    </td>
                    <td>{usageSummary(model)}</td>
                    <td className="numeric">{usdFine(model.usd)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const QA_TRIGGER_LABELS: Record<string, string> = {
  model_review: "Model review",
  claim_grounding: "Claim grounding",
  story_contradiction: "Story contradiction",
  style: "Style",
  local_check: "Local check",
  smart_unslop: "Smart unslop",
  reserved_beat: "Reserved beat",
  brief_repair: "Brief repair"
};

function QaRewriteTriggerCosts(props: { triggers: QaRewriteTriggerCost[] }) {
  const total = props.triggers.reduce((sum, trigger) => sum + trigger.providerCostUsd, 0);
  return (
    <div className="generated-book-quality-gates">
      <div className="section-title generated-book-purpose-title">
        <h4>Page QA rewrite triggers</h4>
        <span className="muted admin-subtle">{usdFine(total)} rewrite spend</span>
      </div>
      <p className="muted generated-book-quality-note">
        Exact trigger combinations; calls and cost are counted once even when a rewrite had multiple causes.
      </p>
      {props.triggers.length === 0 ? (
        <p className="muted">No page QA rewrite calls were recorded.</p>
      ) : (
        <div className="admin-table-scroll generated-book-cost-scroll">
          <table className="admin-table generated-book-quality-table">
            <thead>
              <tr>
                <th>Trigger combination</th>
                <th className="numeric">Calls</th>
                <th className="numeric">Provider cost</th>
              </tr>
            </thead>
            <tbody>
              {props.triggers.map((trigger) => (
                <tr key={trigger.key}>
                  <td>
                    <span className="cost-name">
                      {trigger.reasons.length > 0
                        ? trigger.reasons.map((reason) => QA_TRIGGER_LABELS[reason] ?? reason).join(" + ")
                        : "Legacy / unattributed"}
                    </span>
                  </td>
                  <td className="numeric">{count(trigger.calls)}</td>
                  <td className="numeric">{usdFine(trigger.providerCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function QualityGateCosts(props: { gates: QualityGateCost[] }) {
  const attributableCost = props.gates.reduce(
    (total, gate) => total + (gate.providerCostUsd ?? 0),
    0
  );
  return (
    <div className="generated-book-quality-gates">
      <div className="section-title generated-book-purpose-title">
        <h4>Active quality gates</h4>
        <span className="muted admin-subtle">
          {count(props.gates.length)} active · {usdFine(attributableCost)} directly attributable
        </span>
      </div>
      <p className="muted generated-book-quality-note">
        Enabled for at least one generation run. Costs are lifetime provider spend from calls attributable to one gate.
      </p>
      {props.gates.length === 0 ? (
        <p className="muted">No quality gates were active.</p>
      ) : (
        <div className="admin-table-scroll generated-book-cost-scroll">
          <table className="admin-table generated-book-quality-table">
            <thead>
              <tr>
                <th>Quality gate</th>
                <th className="numeric">Calls</th>
                <th className="numeric">Provider cost</th>
              </tr>
            </thead>
            <tbody>
              {props.gates.map((gate) => (
                <tr key={gate.id}>
                  <td>
                    <span className="cost-name">{gate.label}</span>
                    {gate.costNote ? <span className="muted admin-subtle">{gate.costNote}</span> : null}
                  </td>
                  <td className="numeric">{gate.calls === null ? "—" : count(gate.calls)}</td>
                  <td className="numeric">
                    {gate.providerCostUsd === null ? "Not separate" : usdFine(gate.providerCostUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DetailTile(props: { label: string; value: string; note: string; bad?: boolean }) {
  return (
    <div className={`stat-tile${props.bad ? " is-bad" : ""}`}>
      <span className="stat-label">{props.label}</span>
      <span className="stat-value">{props.value}</span>
      <span className="stat-note">{props.note}</span>
    </div>
  );
}

function KindTotal(props: { label: string; usage: CostUsage }) {
  return (
    <div className="generated-book-kind-total">
      <span className="stat-label">{props.label}</span>
      <span className="cost-name">{usdFine(props.usage.usd)}</span>
      <span className="muted admin-subtle">{usageSummary(props.usage)} · {count(props.usage.calls)} calls</span>
    </div>
  );
}

function kindUsage(detail: GeneratedEconomicsDetail, kind: CostKind): CostUsage {
  return detail.byKind.find((entry) => entry.kind === kind) ?? emptyUsage();
}

function emptyUsage(): CostUsage {
  return {
    calls: 0,
    pricedCalls: 0,
    failedCalls: 0,
    inFlightCalls: 0,
    estimatedCalls: 0,
    unratedCalls: 0,
    usd: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    outputTokens: 0,
    images: 0,
    audioSeconds: 0
  };
}

function usageSummary(usage: CostUsage): string {
  const parts: string[] = [];
  if (usage.promptTokens > 0 || usage.outputTokens > 0) {
    parts.push(`${compactCount(usage.promptTokens)} in`, `${compactCount(usage.outputTokens)} out`);
  }
  if (usage.images > 0) {
    parts.push(`${count(usage.images)} ${usage.images === 1 ? "image" : "images"}`);
  }
  if (usage.audioSeconds > 0) {
    parts.push(`${duration(usage.audioSeconds * 1000)} audio`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function callStateSummary(usage: CostUsage): string {
  const parts = [
    [usage.pricedCalls, "priced"],
    [usage.failedCalls, "failed"],
    [usage.inFlightCalls, "in progress"],
    [usage.estimatedCalls, "estimated"],
    [usage.unratedCalls, "unrated"]
  ] as const;
  return parts.filter(([value]) => value > 0).map(([value, label]) => `${count(value)} ${label}`).join(" · ") || "0 calls";
}
