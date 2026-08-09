import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { BreakdownBars, ColumnChart, SERIES_COLORS, TimeChart } from "./charts.js";
import { count, percent, usd, usdShort } from "./format.js";
import { useAdminOverview } from "./useAdminData.js";
import type { AdminOverview } from "./types.js";

const RANGES = [7, 30, 90] as const;

export function OverviewScreen() {
  const [days, setDays] = useState<number>(30);
  const overview = useAdminOverview(days);

  return (
    <div className={`admin-page${overview.stale ? " is-stale" : ""}`}>
      {/* One filter row, above everything it scopes — never per card. */}
      <div className="admin-filter-row">
        <SegmentedControl
          label="Time range"
          options={RANGES.map((range) => ({ value: range, label: `${range}d` }))}
          value={days}
          onChange={setDays}
        />
        {overview.stale ? (
          <span className="muted admin-refreshing">
            <Loader2 className="spin" size={14} aria-hidden /> refreshing
          </span>
        ) : null}
      </div>

      {overview.error ? <div className="error-banner">{overview.error}</div> : null}
      {!overview.data ? (
        <div className="empty-state">
          <Loader2 className="spin" size={20} aria-hidden /> Loading metrics…
        </div>
      ) : (
        <OverviewBody data={overview.data} days={days} />
      )}
    </div>
  );
}

function OverviewBody(props: { data: AdminOverview; days: number }) {
  const { money, people, work, series } = props.data;
  const dates = series.map((point) => point.date);
  const windowLabel = `last ${props.days} days`;

  return (
    <>
      <section className="work-section hero-card">
        <p className="eyebrow">Gross margin · unit basis · {windowLabel}</p>
        {/* Exactly one hero figure on the view. */}
        <p className="hero-figure">{usd(money.unitMarginUsd)}</p>
        <p className="muted">
          {usd(money.creditsDeliveredUsd)} of credits delivered against {usd(money.providerSpendUsd)} of provider
          spend — {percent(money.unitMarginPercent)} margin on the work actually done.
        </p>
        {money.creditsRefunded > 0 ? (
          <p className="hero-caveat">
            <AlertTriangle size={14} aria-hidden />
            {count(money.creditsRefunded)} more credits ({usd(money.creditsRefundedUsd)}) were charged and refunded.
            They are not delivered revenue; the provider spend they caused is still in the figure above.
          </p>
        ) : null}
        {money.unpricedCalls > 0 ? (
          <p className="hero-caveat">
            <AlertTriangle size={14} aria-hidden />
            {count(money.unpricedCalls)} provider calls had no priced rate card and are excluded from spend.
          </p>
        ) : null}
      </section>

      <div className="stat-grid">
        <StatTile label="Cash collected" value={usd(money.cashCollectedUsd)} note={`${windowLabel} · verified purchases`} />
        <StatTile label="Provider spend" value={usd(money.providerSpendUsd)} note="settled calls only" />
        <StatTile
          label="Cash margin"
          value={usd(money.cashMarginUsd)}
          note={`${percent(money.cashMarginPercent)} of cash in`}
        />
        <StatTile
          label="Credits outstanding"
          value={count(money.creditsOutstanding)}
          note={`${usd(money.creditsOutstandingUsd)} owed as service, not income`}
        />
        <StatTile label="Users" value={count(people.totalUsers)} note={`${count(people.newUsers)} new · ${count(people.activeUsers)} active`} />
        <StatTile
          label="Paying"
          value={count(people.payingUsers)}
          note={`${count(people.activeSubscriptions)} live subscriptions`}
        />
        <StatTile
          label="Books completed"
          value={count(work.projectsCompleted)}
          note={`${count(work.projectsCreated)} started · ${count(work.booksInFlight)} in flight`}
        />
        <StatTile
          label="Job failures"
          value={percent(work.jobFailureRate)}
          note={`${count(work.jobsFailed)} of ${count(work.jobsRun)} jobs`}
          {...(work.jobFailureRate !== null && work.jobFailureRate > 10 ? { tone: "bad" as const } : {})}
        />
      </div>

      <TimeChart
        title="Value delivered vs provider spend"
        subtitle="Credits consumed, valued at the credit rate, against what the providers actually billed. The gap is the unit margin."
        dates={dates}
        series={[
          { key: "delivered", label: "Credits delivered", color: SERIES_COLORS[0], values: series.map((p) => p.creditsDeliveredUsd) },
          { key: "provider", label: "Provider spend", color: SERIES_COLORS[1], values: series.map((p) => p.providerUsd) }
        ]}
        format={usdShort}
      />

      {/* Cash lands in lumps an order of magnitude above daily usage, so it gets
          its own axis in its own chart rather than a second scale on the one above. */}
      <ColumnChart
        title="Cash collected"
        subtitle="Verified purchases on the day they were recorded — lumpy by nature, and not the same thing as value delivered."
        dates={dates}
        values={series.map((point) => point.cashUsd)}
        format={usdShort}
      />

      <div className="admin-columns-2">
        <ColumnChart
          title="Books completed"
          dates={dates}
          values={series.map((point) => point.booksCompleted)}
          format={count}
          height={150}
        />
        <ColumnChart
          title="New users"
          dates={dates}
          values={series.map((point) => point.newUsers)}
          format={count}
          height={150}
        />
      </div>

      <div className="admin-columns-2">
        <BreakdownBars
          title="Where the credits go"
          subtitle={`Credits spent in the ${windowLabel}`}
          rows={props.data.creditsByOperation}
          secondaryLabel="charges"
        />
        <BreakdownBars
          title="Where the money goes"
          subtitle={`Provider spend in the ${windowLabel}`}
          rows={props.data.spendByProvider}
          format={usd}
          secondaryLabel="calls"
        />
        <BreakdownBars
          title="Jobs run"
          subtitle={`By type, in the ${windowLabel}`}
          rows={props.data.jobsByType}
          secondaryIsFailure
        />
        <BreakdownBars
          title="Projects by status"
          subtitle="All time, not just this window"
          rows={props.data.projectsByStatus}
        />
      </div>

      <section className="work-section">
        <div className="section-title">
          <h3>Also worth knowing</h3>
        </div>
        <ul className="fact-list">
          <li>
            <span>Voice calls</span>
            <span>
              {count(work.voiceCalls)} calls · {count(work.voiceMinutes)} minutes
            </span>
          </li>
          <li>
            <span>Projects failed</span>
            <span>{count(work.projectsFailed)}</span>
          </li>
          <li>
            <span>Disabled accounts</span>
            <span>{count(people.disabledUsers)}</span>
          </li>
          <li className={work.pendingModerationReports > 0 ? "fact-flag" : ""}>
            <span>Moderation queue</span>
            <span>{count(work.pendingModerationReports)} pending</span>
          </li>
        </ul>
      </section>
    </>
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
