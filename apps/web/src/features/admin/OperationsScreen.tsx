import { Fragment, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { GeneratedBooksSection } from "./GeneratedBooksSection.js";
import { compactCount, count, duration, percent, usd, usdFine } from "./format.js";
import { useAdminOperations } from "./useAdminData.js";
import type { AdminOperationEconomics, CostUsage, ModelCost, OperationEconomics, UnbilledSpend } from "./types.js";

/**
 * What each billed operation earns against what it costs to serve.
 *
 * The Costs tab groups spend by the call site — an engineering axis. This one
 * groups it by the thing a reader is charged for, so the two numbers that make
 * a margin sit in the same row.
 *
 * Unbilled spend gets its own section rather than a footnote, because it is
 * neither revenue nor cost of revenue: work nobody was charged for cannot be
 * netted against a margin without making every operation look worse than it is,
 * and hiding it would make the page's totals disagree with the Costs tab.
 *
 * Refunded charges are netted out of every credit figure but shown in their own
 * column, because a run count that quietly shrank would be unreadable. Their
 * provider spend stays in `Cost`, so an operation that refunded most of what it
 * charged reports a margin below zero — which is what actually happened.
 */

const RANGES = [7, 30, 90] as const;

const COLUMNS = 8;

export function OperationsScreen() {
  const [days, setDays] = useState<number>(30);
  const operations = useAdminOperations(days);

  return (
    <div className={`admin-page${operations.stale ? " is-stale" : ""}`}>
      <div className="admin-filter-row">
        <SegmentedControl
          label="Time range"
          options={RANGES.map((range) => ({ value: range, label: `${range}d` }))}
          value={days}
          onChange={setDays}
        />
        {operations.stale ? (
          <span className="muted admin-refreshing">
            <Loader2 className="spin" size={14} aria-hidden /> refreshing
          </span>
        ) : null}
      </div>

      {operations.error ? <div className="error-banner">{operations.error}</div> : null}
      {!operations.data ? (
        <div className="empty-state">
          <Loader2 className="spin" size={20} aria-hidden /> Loading operations…
        </div>
      ) : (
        <OperationsBody data={operations.data} days={days} />
      )}
      <GeneratedBooksSection key={days} days={days} />
      {operations.data ? <UnbilledSection unbilled={operations.data.unbilled} /> : null}
    </div>
  );
}

function OperationsBody(props: { data: AdminOperationEconomics; days: number }) {
  const { totals, operations } = props.data;
  const windowLabel = `last ${props.days} days`;

  return (
    <>
      <section className="work-section hero-card">
        <p className="eyebrow">Margin on billed work · {windowLabel}</p>
        <p className="hero-figure">{usd(totals.marginUsd)}</p>
        <p className="muted">
          {usd(totals.revenueUsd)} of credits kept across {count(totals.runs)} operations, against{" "}
          {usdFine(totals.providerUsd)} of provider spend those charges paid for — {percent(totals.marginPercent)}{" "}
          margin.
        </p>
        {totals.refundedCredits > 0 ? (
          <p className="hero-caveat">
            <AlertTriangle size={14} aria-hidden />
            {count(totals.refundedCredits)} credits were returned across {count(totals.refundedRuns)}{" "}
            {totals.refundedRuns === 1 ? "charge" : "charges"}, including partial refunds. Returned credits are not
            counted as revenue; what we paid providers to serve the attempts still is.
          </p>
        ) : null}
        {totals.unbilledUsd > 0 ? (
          <p className="hero-caveat">
            <AlertTriangle size={14} aria-hidden />
            {usdFine(totals.unbilledUsd)} more of provider spend belongs to no charge at all. It is not netted against
            any margin above — see below.
          </p>
        ) : null}
      </section>

      <div className="stat-grid">
        <StatTile label="Charged" value={usd(totals.revenueUsd)} note={`${count(totals.credits)} credits kept`} />
        <StatTile label="Cost to serve" value={usdFine(totals.providerUsd)} note="attributed provider spend" />
        <StatTile
          label="Refunded"
          value={count(totals.refundedCredits)}
          note={`credits over ${count(totals.refundedRuns)} charges`}
          // Bad once a refund undoes more than a fifth of what stuck: below that
          // it is the normal cost of failing a job and refunding it.
          {...(totals.refundedCredits > totals.credits * 0.2 ? { tone: "bad" as const } : {})}
        />
        <StatTile
          label="Unbilled spend"
          value={usdFine(totals.unbilledUsd)}
          note="real cost, no charge behind it"
          {...(totals.unbilledUsd > totals.providerUsd ? { tone: "bad" as const } : {})}
        />
        <StatTile label="Operations" value={count(totals.runs)} note={`${count(operations.length)} kinds`} />
      </div>

      <OperationsTable operations={operations} windowLabel={windowLabel} />
    </>
  );
}

function OperationsTable(props: { operations: OperationEconomics[]; windowLabel: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section className="work-section">
      <div className="section-title">
        <h3>Operations</h3>
      </div>
      <p className="muted chart-subtitle">
        Everything charged for in the {props.windowLabel}, against the provider calls those charges paid for. Runs and
        credits count only charges that stuck; what was refunded has its own column. Open a row for the models that did
        the work.
      </p>
      {props.operations.length === 0 ? (
        <p className="muted">Nothing was charged in this window.</p>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Operation</th>
                <th className="numeric">Runs</th>
                <th className="numeric">Credits</th>
                <th className="numeric">Refunded</th>
                <th className="numeric">Charged</th>
                <th className="numeric">Cost</th>
                <th className="numeric">Cost / run</th>
                <th className="numeric">Margin</th>
              </tr>
            </thead>
            <tbody>
              {props.operations.map((operation) => {
                const isOpen = expanded === operation.key;
                const openable = operation.models.length > 0;
                return (
                  <Fragment key={operation.key}>
                    <tr>
                      <td>
                        {openable ? (
                          <button
                            type="button"
                            className="cost-expander"
                            aria-expanded={isOpen}
                            onClick={() => setExpanded(isOpen ? null : operation.key)}
                          >
                            {isOpen ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
                            <span className="cost-name">{operation.label}</span>
                          </button>
                        ) : (
                          <span className="cost-name cost-indent">{operation.label}</span>
                        )}
                        <span className="muted admin-subtle cost-indent">
                          {openable
                            ? `${operation.models.length} model${operation.models.length === 1 ? "" : "s"} · ${usageSummary(operation)}`
                            : "no provider calls"}
                        </span>
                      </td>
                      <td className="numeric">{count(operation.runs)}</td>
                      <td className="numeric">
                        {count(operation.credits)}
                        {operation.creditsPerRun !== null ? (
                          <span className="muted admin-subtle">{count(operation.creditsPerRun)} each</span>
                        ) : null}
                      </td>
                      <td className="numeric">
                        {operation.refundedRuns === 0 ? (
                          "—"
                        ) : (
                          <>
                            {count(operation.refundedCredits)}
                            <span className="muted admin-subtle">
                              {count(operation.refundedRuns)} {operation.refundedRuns === 1 ? "run" : "runs"}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="numeric">{usd(operation.revenueUsd)}</td>
                      <td className="numeric">{usdFine(operation.providerUsd)}</td>
                      <td className="numeric">
                        {operation.costPerRunUsd === null ? "—" : usdFine(operation.costPerRunUsd)}
                      </td>
                      <td className="numeric">{percent(operation.marginPercent)}</td>
                    </tr>
                    {operation.note ? (
                      <tr className="admin-subrow">
                        <td colSpan={COLUMNS}>
                          {/* The flex lives on a child: a `display: flex` table
                              cell leaves the table layout and stops honouring
                              its own colSpan. */}
                          <span className="operation-note">
                            <AlertTriangle size={13} aria-hidden />
                            {operation.note}
                          </span>
                        </td>
                      </tr>
                    ) : null}
                    {/* Usage spans Credits/Refunded/Charged so the model's own
                        spend still lands under Cost. */}
                    {isOpen
                      ? operation.models.map((model) => <ModelRow key={model.key} model={model} usageSpan={3} />)
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

/**
 * Spend with no charge behind it, kept out of every margin on the page.
 *
 * Netting it into the operations above would spread the operator console's free
 * books across the reader-facing ones; dropping it would make this tab's totals
 * disagree with the Costs tab. So it is shown, with why.
 */
function UnbilledSection(props: { unbilled: UnbilledSpend[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (props.unbilled.length === 0) {
    return null;
  }

  return (
    <section className="work-section">
      <div className="section-title">
        <h3>Spend no charge accounts for</h3>
      </div>
      <p className="muted chart-subtitle">
        Provider calls that could not be tied to anything anyone paid for. Real money, excluded from every margin above.
      </p>
      <div className="admin-table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Reason</th>
              <th className="numeric">Calls</th>
              <th>Usage</th>
              <th className="numeric">Cost</th>
            </tr>
          </thead>
          <tbody>
            {props.unbilled.map((entry) => {
              const isOpen = expanded === entry.key;
              return (
                <Fragment key={entry.key}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className="cost-expander"
                        aria-expanded={isOpen}
                        onClick={() => setExpanded(isOpen ? null : entry.key)}
                      >
                        {isOpen ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
                        <span className="cost-name">{entry.label}</span>
                      </button>
                      <span className="muted admin-subtle cost-indent">{entry.description}</span>
                    </td>
                    <td className="numeric">{count(entry.pricedCalls)}</td>
                    <td>{usageSummary(entry)}</td>
                    <td className="numeric">{usdFine(entry.usd)}</td>
                  </tr>
                  {isOpen
                    ? entry.models.map((model) => (
                        <ModelRow key={model.key} model={model} usageSpan={1} trailing={0} />
                      ))
                    : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * One model under an operation.
 *
 * `usageSpan` and `trailing` exist so the model's cost lands in the parent
 * table's own Cost column rather than wherever the row happens to end — a
 * dollar figure sitting under a "Margin" heading reads as a margin.
 */
function ModelRow(props: { model: ModelCost; usageSpan?: number; trailing?: number }) {
  const trailing = props.trailing ?? 2;
  return (
    <tr className="admin-subrow">
      <td>
        <span className="cost-indent cost-name">{props.model.model}</span>
        <span className="muted admin-subtle cost-indent">{props.model.provider}</span>
      </td>
      <td className="numeric">{count(props.model.pricedCalls)}</td>
      <td colSpan={props.usageSpan ?? 2}>{usageSummary(props.model)}</td>
      <td className="numeric">{usdFine(props.model.usd)}</td>
      {Array.from({ length: trailing }, (_unused, index) => (
        <td key={index} />
      ))}
    </tr>
  );
}

function StatTile(props: { label: string; value: string; note?: string; tone?: "bad" }) {
  return (
    <div className={`stat-tile${props.tone === "bad" ? " is-bad" : ""}`}>
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
  if (usage.images > 0) {
    parts.push(`${count(usage.images)} image${usage.images === 1 ? "" : "s"}`);
  }
  if (usage.audioSeconds > 0) {
    parts.push(`${duration(usage.audioSeconds * 1000)} audio`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}
