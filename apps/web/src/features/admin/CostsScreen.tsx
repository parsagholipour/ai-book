import { Fragment, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { compactCount, count, duration, percent, usd, usdFine } from "./format.js";
import { useAdminCosts } from "./useAdminData.js";
import type { AdminCostBreakdown, CostKind, CostUsage, ModelCost, OperationCost } from "./types.js";

/**
 * What every provider call in the window actually cost, and what bought it.
 *
 * The overview's "where the money goes" answers this one provider deep. This
 * page is the drill-down: operation → the models that served it → tokens,
 * images and seconds of audio beside the dollars.
 *
 * Usage and cost are always summed over the same calls (see the API module's
 * header), which is why the failed / in-flight / unrated counts get their own
 * line rather than being folded into the totals — a model with calls and no
 * cost is a missing rate card, and that is a different problem from an outage.
 */

const RANGES = [7, 30, 90] as const;

const KIND_LABEL: Record<CostKind, string> = { text: "Text", image: "Images", audio: "Narration" };

export function CostsScreen() {
  const [days, setDays] = useState<number>(30);
  const costs = useAdminCosts(days);

  return (
    <div className={`admin-page${costs.stale ? " is-stale" : ""}`}>
      <div className="admin-filter-row">
        <div className="admin-range" role="group" aria-label="Time range">
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              className={`admin-range-option${days === range ? " is-active" : ""}`}
              onClick={() => setDays(range)}
            >
              {range}d
            </button>
          ))}
        </div>
        {costs.stale ? (
          <span className="muted admin-refreshing">
            <Loader2 className="spin" size={14} aria-hidden /> refreshing
          </span>
        ) : null}
      </div>

      {costs.error ? <div className="error-banner">{costs.error}</div> : null}
      {!costs.data ? (
        <div className="empty-state">
          <Loader2 className="spin" size={20} aria-hidden /> Loading costs…
        </div>
      ) : (
        <CostsBody data={costs.data} days={days} />
      )}
    </div>
  );
}

function CostsBody(props: { data: AdminCostBreakdown; days: number }) {
  const { totals, byKind, operations, models } = props.data;
  const windowLabel = `last ${props.days} days`;

  return (
    <>
      <section className="work-section hero-card">
        <p className="eyebrow">Provider spend · settled calls · {windowLabel}</p>
        <p className="hero-figure">{usd(totals.usd)}</p>
        <p className="muted">
          {count(totals.pricedCalls)} priced calls across {count(operations.length)} operations and{" "}
          {count(models.length)} models — {kindSentence(byKind)}.
        </p>
        <UnpricedNote totals={totals} />
      </section>

      <div className="stat-grid">
        {byKind.map((kind) => (
          <StatTile
            key={kind.kind}
            label={KIND_LABEL[kind.kind]}
            value={usdFine(kind.usd)}
            note={`${count(kind.pricedCalls)} calls · ${usageSummary(kind)}`}
          />
        ))}
        <StatTile
          label="Tokens in"
          value={compactCount(totals.promptTokens)}
          note={
            totals.cachedPromptTokens > 0
              ? `${compactCount(totals.cachedPromptTokens)} served from cache`
              : "none served from cache"
          }
        />
        <StatTile label="Tokens out" value={compactCount(totals.outputTokens)} note="billed at the output rate" />
        <StatTile
          label="Cost per call"
          value={usdFine(totals.pricedCalls > 0 ? totals.usd / totals.pricedCalls : 0)}
          note={`averaged over ${count(totals.pricedCalls)} priced calls`}
        />
      </div>

      <OperationsTable operations={operations} totalUsd={totals.usd} windowLabel={windowLabel} />
      <ModelsTable models={models} totalUsd={totals.usd} windowLabel={windowLabel} />
    </>
  );
}

/**
 * Rows open to the models that served the operation, rather than a second table
 * the reader has to join by eye. Collapsed by default: the point of the table is
 * the ranking, and a page that opens with every model expanded buries it.
 */
function OperationsTable(props: { operations: OperationCost[]; totalUsd: number; windowLabel: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section className="work-section">
      <div className="section-title">
        <h3>Cost by operation</h3>
      </div>
      <p className="muted chart-subtitle">
        Every AI call in the {props.windowLabel}, grouped by what it was for. Open a row for the providers and models
        that served it.
      </p>
      {props.operations.length === 0 ? (
        <p className="muted">No provider calls in this window.</p>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Operation</th>
                <th className="numeric">Calls</th>
                <th>Usage</th>
                <th className="numeric">Cost</th>
                <th className="numeric">Share</th>
              </tr>
            </thead>
            <tbody>
              {props.operations.map((operation) => {
                const isOpen = expanded === operation.key;
                return (
                  <Fragment key={operation.key}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="cost-expander"
                          aria-expanded={isOpen}
                          onClick={() => setExpanded(isOpen ? null : operation.key)}
                        >
                          {isOpen ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
                          <span className="cost-name">{operation.label}</span>
                        </button>
                        <span className="muted admin-subtle cost-indent">
                          <span className="cost-kind">{KIND_LABEL[operation.kind]}</span>
                          {operation.models.length} model{operation.models.length === 1 ? "" : "s"}
                          {unpricedSuffix(operation)}
                        </span>
                      </td>
                      <td className="numeric">{count(operation.pricedCalls)}</td>
                      <td>{usageSummary(operation)}</td>
                      <td className="numeric">{usdFine(operation.usd)}</td>
                      <td className="numeric">{shareLabel(operation.usd, props.totalUsd)}</td>
                    </tr>
                    {isOpen
                      ? operation.models.map((model) => (
                          <tr key={model.key} className="admin-subrow">
                            <td>
                              <span className="cost-indent cost-name">{model.model}</span>
                              <span className="muted admin-subtle cost-indent">{model.provider}</span>
                            </td>
                            <td className="numeric">{count(model.pricedCalls)}</td>
                            <td>{usageSummary(model)}</td>
                            <td className="numeric">{usdFine(model.usd)}</td>
                            <td className="numeric">{shareLabel(model.usd, operation.usd)}</td>
                          </tr>
                        ))
                      : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ModelsTable(props: { models: ModelCost[]; totalUsd: number; windowLabel: string }) {
  return (
    <section className="work-section">
      <div className="section-title">
        <h3>Cost by provider and model</h3>
      </div>
      <p className="muted chart-subtitle">
        Every model that billed us in the {props.windowLabel}, with what it produced. A model used for two kinds of work
        is two rows, because tokens and images are not the same unit.
      </p>
      {props.models.length === 0 ? (
        <p className="muted">No provider calls in this window.</p>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Model</th>
                <th className="numeric">Calls</th>
                <th className="numeric">Tokens in</th>
                <th className="numeric">Cached</th>
                <th className="numeric">Tokens out</th>
                <th className="numeric">Images</th>
                <th className="numeric">Audio</th>
                <th className="numeric">Cost</th>
              </tr>
            </thead>
            <tbody>
              {props.models.map((model) => (
                <tr key={model.key}>
                  <td>
                    <span className="cost-name">{model.model}</span>
                    <span className="muted admin-subtle">
                      <span className="cost-kind">{KIND_LABEL[model.kind]}</span>
                      {model.provider}
                      {unpricedSuffix(model)}
                    </span>
                  </td>
                  <td className="numeric">{count(model.pricedCalls)}</td>
                  <td className="numeric">{orDash(model.promptTokens, compactCount)}</td>
                  <td className="numeric">{orDash(model.cachedPromptTokens, compactCount)}</td>
                  <td className="numeric">{orDash(model.outputTokens, compactCount)}</td>
                  <td className="numeric">{orDash(model.images, count)}</td>
                  <td className="numeric">{model.audioSeconds > 0 ? duration(model.audioSeconds * 1000) : "—"}</td>
                  <td className="numeric">
                    {usdFine(model.usd)}
                    <span className="muted admin-subtle">{shareLabel(model.usd, props.totalUsd)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * The calls that cost nothing, and why — never rolled into one "unpriced" tally.
 * A retry storm and a model nobody wrote a rate card for look identical in a
 * single number, and only one of them means this page is understating spend.
 * That one gets the warning colour; the rest are a footnote.
 */
function UnpricedNote(props: { totals: CostUsage }) {
  const { unratedCalls, estimatedCalls, failedCalls, inFlightCalls } = props.totals;
  if (unratedCalls + estimatedCalls + failedCalls + inFlightCalls === 0) {
    return null;
  }
  const parts = [
    unratedCalls > 0 ? `${count(unratedCalls)} on models with no rate card` : null,
    estimatedCalls > 0 ? `${count(estimatedCalls)} with estimated token counts` : null,
    failedCalls > 0 ? `${count(failedCalls)} failed` : null,
    inFlightCalls > 0 ? `${count(inFlightCalls)} still running` : null
  ].filter((part): part is string => part !== null);

  return (
    <p className={unratedCalls > 0 ? "hero-caveat" : "muted admin-subtle"}>
      {unratedCalls > 0 ? <AlertTriangle size={14} aria-hidden /> : null}
      {parts.join(" · ")} — excluded from every figure above.
      {unratedCalls > 0 ? " Real spend is higher by whatever those cost." : ""}
    </p>
  );
}

function StatTile(props: { label: string; value: string; note?: string }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{props.label}</span>
      <span className="stat-value">{props.value}</span>
      {props.note ? <span className="stat-note">{props.note}</span> : null}
    </div>
  );
}

/** Every measure that has a value, so a mixed row never hides half its usage. */
function usageSummary(usage: CostUsage): string {
  const parts: string[] = [];
  if (usage.promptTokens > 0 || usage.outputTokens > 0) {
    parts.push(`${compactCount(usage.promptTokens)} in`, `${compactCount(usage.outputTokens)} out`);
  }
  if (usage.cachedPromptTokens > 0) {
    parts.push(`${compactCount(usage.cachedPromptTokens)} cached`);
  }
  if (usage.images > 0) {
    parts.push(`${count(usage.images)} image${usage.images === 1 ? "" : "s"}`);
  }
  if (usage.audioSeconds > 0) {
    parts.push(`${duration(usage.audioSeconds * 1000)} audio`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function kindSentence(byKind: Array<CostUsage & { kind: CostKind }>): string {
  if (byKind.length === 0) {
    return "nothing billed yet";
  }
  return byKind.map((kind) => `${usdFine(kind.usd)} ${KIND_LABEL[kind.kind].toLowerCase()}`).join(", ");
}

/**
 * Every call this row logged that carries no cost, whatever the reason. The
 * hero note is where the reasons are broken out; here it is only a flag that
 * the row's dollars cover fewer calls than the ones it made.
 */
function unpricedSuffix(usage: CostUsage): string {
  const unpriced = usage.calls - usage.pricedCalls;
  return unpriced > 0 ? ` · ${count(unpriced)} unpriced` : "";
}

/**
 * A row that cost real money never rounds to a flat `0%` — that reads as "this
 * was free", which is the one thing it is not. Below a tenth of a percent it
 * says so as a bound instead.
 */
function shareLabel(part: number, whole: number): string {
  if (whole <= 0) {
    return percent(null);
  }
  const share = (part / whole) * 100;
  return share > 0 && share < 0.05 ? "<0.1%" : percent(Math.round(share * 10) / 10);
}

function orDash(value: number, format: (value: number) => string): string {
  return value > 0 ? format(value) : "—";
}
