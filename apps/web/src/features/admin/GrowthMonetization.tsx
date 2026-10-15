import { count, percent, usd } from "./format.js";
import type { ProductFunnel } from "./types.js";

/** Mirrors `PURCHASE_FAILURE_REASONS` in apps/api/src/productEventNames.ts. */
const FAILURE_LABELS: Record<string, string> = {
  store_unavailable: "Google Play unavailable or unpriced",
  account_unavailable: "Billing account unreadable",
  launch_failed: "Checkout did not open",
  play_error: "Google Play error",
  already_owned: "Already owned",
  no_token: "No purchase token",
  refused: "Refused by the server",
  other: "Other"
};

const SURFACE_LABELS: Record<string, string> = {
  credits_needed: "Not enough credits",
  image_limit: "Out of illustrated books",
  page_limit: "Long book",
  export: "Export",
  message_limit: "Message limit",
  add_credits: "Add credits",
  plans: "Plans",
  made_with_credit: "Tomeza credit",
  first_book: "First book ready",
  other: "Other"
};

function share(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

function skuLabel(sku: string): string {
  return sku.replace(/^tomeza\./, "");
}

function money(value: number, currency: string | null): string {
  const amount = value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === null ? "no local price" : `${currency} ${amount}`;
}

/**
 * Checkouts, installs, intro conversion, churn and cash by signup country —
 * the parts of the growth funnel read from the app's events and the billing
 * rows (`growthAcquisition.ts`, `growthMonetization.ts`).
 */
export function GrowthMonetization(props: { growth: ProductFunnel; windowLabel: string }) {
  const { checkout, introConversion, churn, revenueByCountry, installSources } = props.growth;
  const intro = introConversion.reduce(
    (total, row) => ({ intros: total.intros + row.intros, due: total.due + row.due, renewed: total.renewed + row.renewed }),
    { intros: 0, due: 0, renewed: 0 }
  );
  return (
    <>
      <section className="work-section">
        <div className="section-title">
          <h3>Checkouts</h3>
          <span className="muted">started in the {props.windowLabel}, from app builds that report them</span>
        </div>
        <ul className="fact-list">
          {checkout.bySku.length === 0 ? (
            <li>
              <span>Checkouts started</span>
              <span>none yet</span>
            </li>
          ) : (
            checkout.bySku.map((row) => (
              <li key={row.sku}>
                <span>{skuLabel(row.sku)}</span>
                <span>
                  {count(row.started)} started{row.introStarted > 0 ? ` (${count(row.introStarted)} intro)` : ""} ·{" "}
                  {count(row.cancelled)} cancelled · {count(row.failed)} failed · {count(row.paidWithin1Day)} of{" "}
                  {count(row.starters)} readers paid within a day ({percent(share(row.paidWithin1Day, row.starters))})
                </span>
              </li>
            ))
          )}
          {checkout.failures.map((row) => (
            <li key={`failure-${row.reason}`} className="fact-flag">
              <span>Failed: {FAILURE_LABELS[row.reason] ?? row.reason}</span>
              <span>{count(row.events)}</span>
            </li>
          ))}
          {checkout.bySurface.length > 0 ? (
            <li>
              <span>Started from</span>
              <span>
                {checkout.bySurface.map((row) => `${SURFACE_LABELS[row.surface] ?? row.surface} ${count(row.started)}`).join(" · ")}
              </span>
            </li>
          ) : null}
        </ul>
      </section>
      <section className="work-section">
        <div className="section-title">
          <h3>Subscriptions</h3>
          <span className="muted">paid plans; intro offers paid in the {props.windowLabel}</span>
        </div>
        <ul className="fact-list">
          <li>
            <span>Intro → full price</span>
            <span>
              {intro.intros === 0
                ? "no intro offers yet"
                : `${count(intro.renewed)} of ${count(intro.due)} due paid full price (${percent(share(intro.renewed, intro.due))}) · ${count(
                    intro.intros - intro.due
                  )} still in their intro`}
            </span>
          </li>
          {churn.map((row) => (
            <li key={row.month} className={row.ended > 0 ? "fact-flag" : ""}>
              <span>
                {row.month}
                {row.partial ? " (so far)" : ""}
              </span>
              <span>
                {count(row.activeAtStart)} subscribed at start · {count(row.ended)} ended (
                {percent(share(row.ended, row.activeAtStart))} churn{row.refunded > 0 ? `, ${count(row.refunded)} refunded` : ""}) ·{" "}
                {count(row.started)} new
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="work-section">
        <div className="section-title">
          <h3>Revenue by signup country</h3>
          <span className="muted">payments in the {props.windowLabel}, net of Google's fee</span>
        </div>
        <ul className="fact-list">
          {revenueByCountry.length === 0 ? (
            <li>
              <span>Payments</span>
              <span>none yet</span>
            </li>
          ) : (
            revenueByCountry.map((row) => (
              <li key={row.country ?? "unknown"}>
                <span>{row.country ?? "Unknown country"}</span>
                <span>
                  {usd(row.netUsd)} net ({usd(row.collectedUsd)} before the fee) · {count(row.orders)} orders ·{" "}
                  {count(row.buyers)} buyers · {row.byCurrency.map((local) => money(local.localKept, local.currency)).join(" · ")}
                </span>
              </li>
            ))
          )}
        </ul>
      </section>
      <section className="work-section">
        <div className="section-title">
          <h3>Install sources</h3>
          <span className="muted">Play install referrer, first install a reader signed in to in the {props.windowLabel}</span>
        </div>
        <ul className="fact-list">
          {installSources.length === 0 ? (
            <li>
              <span>Installs reported</span>
              <span>none yet</span>
            </li>
          ) : (
            installSources.map((row) => (
              <li key={`${row.source}/${row.medium}`}>
                <span>
                  {row.source} / {row.medium}
                </span>
                <span>
                  {count(row.readers)} readers ({count(row.newAccounts)} new accounts) · {count(row.installs)} installs ·{" "}
                  {count(row.fromShares)} from shares · {count(row.paid)} paid
                </span>
              </li>
            ))
          )}
        </ul>
      </section>
    </>
  );
}
