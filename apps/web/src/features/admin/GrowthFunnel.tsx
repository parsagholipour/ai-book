import { count, percent, usd, usdFine } from "./format.js";
import { GrowthMonetization } from "./GrowthMonetization.js";
import type { ProductFunnel } from "./types.js";

const TRIGGER_LABELS: Record<string, string> = {
  credits_needed: "Not enough credits",
  image_limit: "Out of illustrated books",
  page_limit: "Book longer than the free limit",
  export: "Export or Word file",
  message_limit: "Daily message limit",
  add_credits: "Add credits button",
  plans: "Browsing plans",
  made_with_credit: "Remove the Tomeza credit",
  first_book: "First book is ready",
  other: "Other"
};

function share(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

function minutes(value: number | null): string {
  if (value === null) return "—";
  if (value < 120) return `${value} min`;
  return `${Math.round(value / 6) / 10} h`;
}

/**
 * The readers who signed up in the window, followed to now: did they get a
 * book, see a paywall, pay, come back — and what they cost.
 */
export function GrowthFunnel(props: { growth: ProductFunnel; windowLabel: string }) {
  const { cohort, timeToFirstBook, paywall, purchasesBySku, retention, cost } = props.growth;
  const steps: Array<[string, number]> = [
    ["Signed up", cohort.signups],
    ["Started a chat", cohort.startedChat],
    ["Got a plan", cohort.builtPlan],
    ["Started a book", cohort.startedBook],
    ["Got a finished book", cohort.deliveredBook],
    ["Started a second book", cohort.secondBook],
    ["Paid", cohort.paid]
  ];
  const refused = cohort.welcome.RECENT_IP + cohort.welcome.NO_IP;
  return (
    <>
      <section className="work-section">
        <div className="section-title">
          <h3>Growth funnel</h3>
          <span className="muted">readers who signed up in the {props.windowLabel}</span>
        </div>
        <ul className="fact-list">
          {steps.map(([label, value]) => (
            <li key={label}>
              <span>{label}</span>
              <span>
                {count(value)}
                {label === "Signed up" ? "" : ` · ${percent(share(value, cohort.signups))}`}
              </span>
            </li>
          ))}
          <li className={refused > 0 ? "fact-flag" : ""}>
            <span>Welcome credits refused</span>
            <span>
              {count(cohort.welcome.RECENT_IP)} same network · {count(cohort.welcome.NO_IP)} no address
            </span>
          </li>
          <li>
            <span>Signup to first book</span>
            <span>
              {minutes(timeToFirstBook.medianMinutes)} median · {minutes(timeToFirstBook.p90Minutes)} p90 (
              {count(timeToFirstBook.samples)} readers)
            </span>
          </li>
          {retention.map((row) => (
            <li key={row.day}>
              <span>Came back on day {row.day}+</span>
              <span>
                {count(row.retained)} of {count(row.eligible)} · {percent(share(row.retained, row.eligible))}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="work-section">
        <div className="section-title">
          <h3>Paywalls and purchases</h3>
          <span className="muted">in the {props.windowLabel}</span>
        </div>
        <ul className="fact-list">
          {paywall.length === 0 ? (
            <li>
              <span>Paywalls shown</span>
              <span>none yet</span>
            </li>
          ) : (
            paywall.map((row) => (
              <li key={row.trigger}>
                <span>{TRIGGER_LABELS[row.trigger] ?? row.trigger}</span>
                <span>
                  {count(row.views)} views · {count(row.viewers)} readers · {count(row.paidWithin7Days)} paid within 7 days (
                  {percent(share(row.paidWithin7Days, row.viewers))})
                </span>
              </li>
            ))
          )}
          {purchasesBySku.map((row) => (
            <li key={row.sku}>
              <span>{row.sku.replace(/^tomeza\./, "")}</span>
              <span>
                {count(row.payments)} payments · {count(row.buyers)} buyers · {usd(row.netUsd)} net ({usd(row.cashUsd)} before
                Google's fee)
              </span>
            </li>
          ))}
        </ul>
      </section>
      <GrowthMonetization growth={props.growth} windowLabel={props.windowLabel} />
      <section className="work-section">
        <div className="section-title">
          <h3>Provider cost per reader</h3>
          <span className="muted">logged provider spend</span>
        </div>
        <ul className="fact-list">
          <li>
            <span>Per signup (to date)</span>
            <span>{cost.perSignupUsd === null ? "—" : usdFine(cost.perSignupUsd)}</span>
          </li>
          <li>
            <span>Per active reader</span>
            <span>
              {cost.perActiveUserUsd === null ? "—" : usdFine(cost.perActiveUserUsd)} · {count(cost.activeUsers)} active
            </span>
          </li>
          {cost.perDeliveredBook.map((row) => (
            <li key={row.tier}>
              <span>Per finished {row.tier} book</span>
              <span>
                {usdFine(row.avgUsd)} · {count(row.books)} books
              </span>
            </li>
          ))}
          <li>
            <span>Not tied to a book</span>
            <span>{usd(cost.unattributedUsd)}</span>
          </li>
        </ul>
      </section>
    </>
  );
}
