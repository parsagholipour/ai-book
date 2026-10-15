import { count, usd } from "./format.js";
import type { CreditValuation, CurrencyRevenue } from "./types.js";

/**
 * How every credit figure on the page became dollars, stated beside the numbers.
 *
 * The dashboard used to multiply every credit by a flat cent, which read every
 * margin 3.5–4.7× too rosy and counted welcome credits as income. The method
 * sentence comes from the API (`admin/creditValuation.ts`), so the console
 * cannot describe a valuation the server no longer runs.
 */
export function ValuationNote(props: { valuation: CreditValuation | undefined }) {
  const valuation = props.valuation;
  if (!valuation) {
    return null;
  }
  return (
    <details className="muted chart-subtitle">
      <summary>How credits are valued</summary>
      <p>{valuation.method}</p>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Credit from</th>
            <th className="numeric">Earns per credit</th>
            <th className="numeric">Per 1,000</th>
          </tr>
        </thead>
        <tbody>
          {valuation.rates.map((rate) => (
            <tr key={rate.key}>
              <td>{rate.label}</td>
              <td className="numeric">{perCredit(rate.usdPerCredit)}</td>
              <td className="numeric">{usd(rate.usdPerCredit * 1000)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Google's fee is {feePercent(valuation.subscriptionFeeRate)} on subscriptions and{" "}
        {feePercent(valuation.oneTimeFeeRate)} on packs. The pack rate holds only while the developer account is
        enrolled in Play's 15% service-fee tier; otherwise Google keeps 30% and every pack figure here is too high.
      </p>
    </details>
  );
}

/**
 * The window's orders in the buyer's own currency.
 *
 * Never converted: nothing here has an exchange rate, and Play's settlement
 * report is the only true dollar figure for a foreign order. The USD column is
 * the catalog price the order was recorded at, which is what every other cash
 * figure on the page sums.
 */
export function CurrencyRevenueSection(props: { rows: CurrencyRevenue[] | undefined; windowLabel: string }) {
  const rows = props.rows ?? [];
  return (
    <section className="work-section">
      <div className="section-title">
        <h3>Orders by currency</h3>
      </div>
      <p className="muted chart-subtitle">
        What the {props.windowLabel}&apos;s orders cost in the buyer&apos;s own currency, before tax and Google&apos;s fee.
        Not converted to dollars — there is no exchange-rate source; Play&apos;s earnings report is the dollar figure.
        Refunds are taken off each order in proportion.
      </p>
      {rows.length === 0 ? (
        <p className="muted">No orders in this window.</p>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Currency</th>
                <th className="numeric">Orders</th>
                <th className="numeric">Kept</th>
                <th className="numeric">Catalog USD</th>
                <th>Price from</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.currency ?? "unknown"}>
                  <td>{row.currency ?? "Not recorded"}</td>
                  <td className="numeric">
                    {count(row.orders)}
                    {row.refundedOrders > 0 ? (
                      <span className="muted admin-subtle">{count(row.refundedOrders)} refunded</span>
                    ) : null}
                  </td>
                  <td className="numeric">
                    {row.currency === null ? (
                      "—"
                    ) : (
                      <>
                        {localMoney(row.localKept, row.currency)}
                        {row.localKept !== row.localGross ? (
                          <span className="muted admin-subtle">of {localMoney(row.localGross, row.currency)}</span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="numeric">{usd(row.catalogUsd)}</td>
                  <td>{sourceMix(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function sourceMix(row: CurrencyRevenue): string {
  if (row.currency === null) {
    return "an app build that did not report it";
  }
  const parts: string[] = [];
  if (row.sources.client > 0) parts.push(`${count(row.sources.client)} from the app`);
  if (row.sources.playRecurringPrice > 0) parts.push(`${count(row.sources.playRecurringPrice)} from Google's plan price`);
  return parts.join(" · ");
}

function localMoney(amount: number, currency: string): string {
  try {
    return amount.toLocaleString(undefined, { style: "currency", currency });
  } catch {
    // A code the browser does not know is still worth showing as written.
    return `${amount.toLocaleString()} ${currency}`;
  }
}

function perCredit(value: number): string {
  return value === 0 ? "$0" : `$${value.toFixed(5)}`;
}

function feePercent(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}
