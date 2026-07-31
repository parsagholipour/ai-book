import { useState } from "react";
import { AlertTriangle, Loader2, TrendingUp } from "lucide-react";
import { PRICING_FIELD_GROUPS } from "./pricingFields.js";
import type { CreditPricingKey, CreditPricingValues } from "./types.js";
import { revenueAt, useProfitDrivers, type PricingDrivers } from "./useProfitDrivers.js";

const RANGES = [30, 90, 365] as const;

const LABELS: Record<string, string> = Object.fromEntries(
  PRICING_FIELD_GROUPS.flatMap((group) => group.fields.map((field) => [field.key, field.label]))
);

/**
 * What the prices being edited would actually have earned.
 *
 * Not a hypothetical: it replays real charged work from the window — this many
 * books of this many pages, these voice minutes, these edits — against the
 * numbers in the form above, and pairs the result with what the providers
 * really billed over the same days. So the answer is "these prices would have
 * turned last quarter into $X", not "a typical book might cost $Y".
 */
export function ProfitSection(props: {
  draftValues: CreditPricingValues | null;
  savedValues: CreditPricingValues | null;
  creditUsdValue: number;
}) {
  const [days, setDays] = useState<number>(90);
  const report = useProfitDrivers(days);

  return (
    <section className="work-section profit-section">
      <div className="section-title">
        <TrendingUp size={18} aria-hidden />
        <h3>Projected profit</h3>
        <div className="admin-range profit-range" role="group" aria-label="Projection window">
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              className={`admin-range-option${days === range ? " is-active" : ""}`}
              onClick={() => setDays(range)}
            >
              {range === 365 ? "1y" : `${range}d`}
            </button>
          ))}
        </div>
      </div>

      {report.error ? <div className="error-banner">{report.error}</div> : null}

      {!report.data ? (
        <div className="empty-state">
          <Loader2 className="spin" size={18} aria-hidden /> Loading the work to price…
        </div>
      ) : report.data.coverage.chargedCredits === 0 ? (
        <p className="muted">
          Nothing was charged in the last {days} days, so there is no real work to re-price. Pick a longer window.
        </p>
      ) : (
        <ProfitBody
          report={report.data}
          draftValues={props.draftValues}
          savedValues={props.savedValues}
          creditUsdValue={props.creditUsdValue}
          days={days}
          stale={report.stale}
        />
      )}
    </section>
  );
}

function ProfitBody(props: {
  report: NonNullable<ReturnType<typeof useProfitDrivers>["data"]>;
  draftValues: CreditPricingValues | null;
  savedValues: CreditPricingValues | null;
  creditUsdValue: number;
  days: number;
  stale: boolean;
}) {
  const { drivers, providerUsd } = props.report;
  const proposed = props.draftValues ? outcome(drivers, props.draftValues, props.creditUsdValue, providerUsd) : null;
  const current = props.savedValues ? outcome(drivers, props.savedValues, props.creditUsdValue, providerUsd) : null;
  const delta = proposed && current ? proposed.profitUsd - current.profitUsd : null;
  const changed = Boolean(delta !== null && Math.abs(delta) >= 0.005);

  return (
    <div className={props.stale ? "is-stale" : ""}>
      <p className="muted chart-subtitle">
        {fmtInt(props.report.books)} books · {fmtInt(props.report.voiceMinutes)} voice minutes ·{" "}
        {fmtInt(props.report.edits)} edits actually charged in the last {props.days} days, re-priced at the values
        above and set against the {money(providerUsd)} the providers really billed.
      </p>

      {!proposed ? (
        <p className="pricing-invalid">Fix the invalid prices above to see the projection.</p>
      ) : (
        <>
          <div className="profit-headline">
            <div>
              <span className="stat-label">Gross profit at these prices</span>
              <span className={`profit-figure${proposed.profitUsd < 0 ? " is-loss" : ""}`}>
                {money(proposed.profitUsd)}
              </span>
              <span className="stat-note">
                {money(proposed.revenueUsd)} revenue − {money(providerUsd)} provider cost ·{" "}
                {proposed.marginPercent === null ? "—" : `${proposed.marginPercent}%`} margin
              </span>
            </div>
            {current ? (
              <div className="profit-compare">
                <span className="stat-label">vs prices in force</span>
                <span className={`profit-delta${!changed ? " is-flat" : delta! > 0 ? " is-up" : " is-down"}`}>
                  {!changed ? "no change" : `${delta! > 0 ? "+" : "−"}${money(Math.abs(delta!))}`}
                </span>
                <span className="stat-note">
                  currently {money(current.profitUsd)} ·{" "}
                  {current.marginPercent === null ? "—" : `${current.marginPercent}%`} margin
                </span>
              </div>
            ) : null}
          </div>

          <div className="stat-grid compact profit-tiles">
            <Tile label="Revenue" value={money(proposed.revenueUsd)} note={`${fmtInt(proposed.credits)} credits`} />
            <Tile label="Provider cost" value={money(providerUsd)} note="actually billed, settled calls" />
            <Tile
              label="Profit per book"
              value={props.report.books > 0 ? money(proposed.profitUsd / props.report.books) : "—"}
              note={`across ${fmtInt(props.report.books)} books`}
            />
            <Tile
              label="Cost recovered"
              value={proposed.revenueUsd > 0 ? `${Math.round((providerUsd / proposed.revenueUsd) * 1000) / 10}%` : "—"}
              note="of revenue goes to providers"
            />
          </div>

          <ContributionTable
            drivers={drivers}
            values={props.draftValues!}
            creditUsdValue={props.creditUsdValue}
            totalCredits={proposed.credits}
          />
        </>
      )}

      <CoverageNote coverage={props.report.coverage} days={props.days} />
    </div>
  );
}

function ContributionTable(props: {
  drivers: PricingDrivers;
  values: CreditPricingValues;
  creditUsdValue: number;
  totalCredits: number;
}) {
  const rows = (Object.keys(props.drivers) as CreditPricingKey[])
    .map((key) => ({
      key,
      label: LABELS[key] ?? key,
      quantity: props.drivers[key],
      unit: props.values[key],
      credits: props.drivers[key] * props.values[key]
    }))
    .filter((row) => row.quantity > 0)
    .sort((left, right) => right.credits - left.credits);

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="admin-table-scroll">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Priced item</th>
            <th className="numeric">Charged</th>
            <th className="numeric">Your price</th>
            <th className="numeric">Credits</th>
            <th className="numeric">Revenue</th>
            <th className="numeric">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{row.label}</td>
              <td className="numeric">{fmtInt(row.quantity)}×</td>
              <td className="numeric">{fmtInt(row.unit)}</td>
              <td className="numeric">{fmtInt(row.credits)}</td>
              <td className="numeric">{money(row.credits * props.creditUsdValue)}</td>
              <td className="numeric muted">
                {props.totalCredits > 0 ? `${Math.round((row.credits / props.totalCredits) * 100)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CoverageNote(props: {
  coverage: { chargedCredits: number; modelledCredits: number; accuracyPercent: number | null };
  days: number;
}) {
  const accuracy = props.coverage.accuracyPercent;
  // Within a few points is expected — books get edited after they are charged.
  // Further out means the replay is missing something and should be said so.
  const off = accuracy !== null && Math.abs(accuracy - 100) > 10;

  return (
    <p className={off ? "hero-caveat" : "muted profit-coverage"}>
      {off ? <AlertTriangle size={14} aria-hidden /> : null}
      Re-pricing this work at the current list reproduces {fmtInt(props.coverage.modelledCredits)} of the{" "}
      {fmtInt(props.coverage.chargedCredits)} credits actually charged
      {accuracy === null ? "" : ` (${accuracy}%)`}
      {off
        ? " — far enough off that some charges are not modelled here, so treat the projection as a rough guide."
        : ". The small gap is books edited after they were charged."}
    </p>
  );
}

function outcome(drivers: PricingDrivers, values: CreditPricingValues, creditUsdValue: number, providerUsd: number) {
  const credits = revenueAt(drivers, values);
  const revenueUsd = Math.round(credits * creditUsdValue * 100) / 100;
  const profitUsd = Math.round((revenueUsd - providerUsd) * 100) / 100;
  return {
    credits,
    revenueUsd,
    profitUsd,
    marginPercent: revenueUsd > 0 ? Math.round((profitUsd / revenueUsd) * 1000) / 10 : null
  };
}

function Tile(props: { label: string; value: string; note: string }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{props.label}</span>
      <span className="stat-value">{props.value}</span>
      <span className="stat-note">{props.note}</span>
    </div>
  );
}

function money(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtInt(value: number): string {
  return Math.round(value).toLocaleString();
}
