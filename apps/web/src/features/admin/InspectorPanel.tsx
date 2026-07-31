import { useState } from "react";
import { ArrowLeft, Loader2, X } from "lucide-react";
import { BreakdownBars } from "./charts.js";
import { count, dateTime, duration, percent, relative, titleCase, usd } from "./format.js";
import { useAdminProjectDetail, useAdminUserDetail } from "./useAdminData.js";

/**
 * The drill-in.
 *
 * A user opens here, and any of their books opens *inside* the same panel rather
 * than replacing it — the operator question is almost always "this reader, and
 * then that one book of theirs", so the back arrow returns to the account
 * instead of dumping them back at the list.
 */
export function InspectorPanel(props: { userId: string; onClose: () => void }) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const user = useAdminUserDetail(props.userId);
  const project = useAdminProjectDetail(projectId);

  return (
    <section className="work-section inspector">
      <div className="section-title">
        {projectId ? (
          <button className="icon-text-button" type="button" onClick={() => setProjectId(null)}>
            <ArrowLeft size={16} aria-hidden />
            Account
          </button>
        ) : null}
        <h3>{projectId ? project.data?.project.title ?? "Book" : user.data?.user.email ?? "Loading…"}</h3>
        <button className="icon-text-button" type="button" onClick={props.onClose} aria-label="Close inspector">
          <X size={16} aria-hidden />
          Close
        </button>
      </div>

      {user.error ? <div className="error-banner">{user.error}</div> : null}
      {project.error ? <div className="error-banner">{project.error}</div> : null}

      {projectId ? (
        project.data ? (
          <ProjectBody detail={project.data} />
        ) : (
          <Spinner />
        )
      ) : user.data ? (
        <UserBody detail={user.data} onOpenProject={setProjectId} />
      ) : (
        <Spinner />
      )}
    </section>
  );
}

function UserBody(props: {
  detail: NonNullable<ReturnType<typeof useAdminUserDetail>["data"]>;
  onOpenProject: (projectId: string) => void;
}) {
  const { credits, user } = props.detail;
  const cash = props.detail.purchases.reduce((total, purchase) => total + (purchase.amountUsd ?? 0), 0);

  return (
    <>
      <div className="stat-grid compact">
        <MiniStat label="Credits available" value={count(credits.available)} note={`${count(credits.reserved)} reserved`} />
        <MiniStat label="Lifetime spent" value={count(credits.lifetimeSpent)} note={`${count(credits.lifetimeGranted)} granted`} />
        <MiniStat label="Money spent" value={usd(cash)} note={`${count(props.detail.purchases.length)} purchases`} />
        <MiniStat label="Joined" value={relative(user.createdAt)} note={user.status.toLowerCase()} />
      </div>

      {props.detail.deletionRequests.length > 0 ? (
        <p className="hero-caveat">
          Account deletion requested {relative(props.detail.deletionRequests[0]!.requestedAt)} —{" "}
          {props.detail.deletionRequests[0]!.status.toLowerCase()}
        </p>
      ) : null}

      <div className="admin-columns-2">
        <BreakdownBars
          title="What they spend on"
          rows={props.detail.spendByOperation}
          emptyLabel="No settled charges yet."
        />
        <section className="work-section">
          <div className="section-title">
            <h3>Billing</h3>
          </div>
          {props.detail.subscriptions.length === 0 && props.detail.purchases.length === 0 ? (
            <p className="muted">No purchases or subscriptions.</p>
          ) : (
            <ul className="fact-list">
              {props.detail.subscriptions.map((subscription) => (
                <li key={subscription.id}>
                  <span>Subscription · {subscription.status.toLowerCase()}</span>
                  <span>
                    {count(subscription.creditsPerPeriod)} credits/period
                    {subscription.currentPeriodEnd ? ` · renews ${relative(subscription.currentPeriodEnd)}` : ""}
                  </span>
                </li>
              ))}
              {props.detail.purchases.slice(0, 8).map((purchase) => (
                <li key={purchase.id}>
                  <span>
                    {purchase.status.toLowerCase()} · {relative(purchase.purchasedAt)}
                  </span>
                  <span>
                    {purchase.amountUsd === null ? "—" : usd(purchase.amountUsd)} · {count(purchase.creditsGranted)} credits
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="work-section">
        <div className="section-title">
          <h3>Books</h3>
          <span className="muted admin-count">{count(props.detail.projects.length)} shown</span>
        </div>
        {props.detail.projects.length === 0 ? (
          <p className="muted">No books yet.</p>
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Status</th>
                  <th className="numeric">Pages</th>
                  <th className="numeric">Credits</th>
                  <th className="numeric">Provider cost</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {props.detail.projects.map((project) => (
                  <tr key={project.id} className="admin-row" onClick={() => props.onOpenProject(project.id)}>
                    <td>
                      <button type="button" className="admin-linkish">
                        {project.title}
                      </button>
                    </td>
                    <td>{titleCase(project.status)}</td>
                    <td className="numeric">
                      {count(project.pages)}
                      <span className="muted">/{count(project.targetPages)}</span>
                    </td>
                    <td className="numeric">{count(project.creditsCharged)}</td>
                    <td className="numeric">{usd(project.providerUsd)}</td>
                    <td>{relative(project.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <LedgerTable rows={props.detail.ledger} />
    </>
  );
}

function ProjectBody(props: { detail: NonNullable<ReturnType<typeof useAdminProjectDetail>["data"]> }) {
  const { economics, project } = props.detail;

  return (
    <>
      <div className="stat-grid compact">
        <MiniStat label="Revenue" value={usd(economics.revenueUsd)} note={`${count(economics.creditsCharged)} credits`} />
        <MiniStat label="Provider cost" value={usd(economics.providerUsd)} note={`${count(economics.unpricedCalls)} unpriced calls`} />
        <MiniStat label="Margin" value={usd(economics.marginUsd)} note={percent(economics.marginPercent)} />
        <MiniStat
          label="Content"
          value={`${count(project.pages)}/${count(project.targetPages)}`}
          note={`${count(project.images)} images · ${project.language}`}
        />
      </div>

      <div className="admin-columns-2">
        <BreakdownBars
          title="Provider spend by purpose"
          subtitle="Matches the purpose key in the project's run logs"
          rows={props.detail.spendByPurpose}
          format={usd}
          secondaryLabel="calls"
          emptyLabel="No priced provider calls."
        />
        <section className="work-section">
          <div className="section-title">
            <h3>Jobs</h3>
          </div>
          {props.detail.jobs.length === 0 ? (
            <p className="muted">No jobs recorded.</p>
          ) : (
            <ul className="fact-list job-list">
              {props.detail.jobs.slice(0, 12).map((job) => (
                <li key={job.id} className={job.status === "FAILED" ? "fact-flag" : ""}>
                  <span title={job.error ?? undefined}>
                    {job.type} · {job.status.toLowerCase()}
                  </span>
                  <span>{duration(job.durationMs)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <LedgerTable rows={props.detail.ledger} />
    </>
  );
}

function LedgerTable(props: {
  rows: Array<{
    id: string;
    operation: string;
    entryType: string;
    status: string;
    amountCredits: number;
    pricingVersion: number | null;
    createdAt: string;
  }>;
}) {
  return (
    <section className="work-section">
      <div className="section-title">
        <h3>Credit ledger</h3>
        <span className="muted admin-count">{count(props.rows.length)} most recent</span>
      </div>
      {props.rows.length === 0 ? (
        <p className="muted">No ledger entries.</p>
      ) : (
        <div className="admin-table-scroll ledger-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Operation</th>
                <th>Type</th>
                <th className="numeric">Credits</th>
                <th className="numeric" title="Which price list this amount was charged under">
                  Prices
                </th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row) => (
                <tr key={row.id}>
                  <td>{dateTime(row.createdAt)}</td>
                  <td>{titleCase(row.operation)}</td>
                  <td>
                    {row.entryType.toLowerCase()}
                    <span className="muted"> · {row.status.toLowerCase()}</span>
                  </td>
                  <td className={`numeric${row.amountCredits < 0 ? " is-debit" : ""}`}>
                    {row.amountCredits > 0 ? "+" : ""}
                    {count(row.amountCredits)}
                  </td>
                  <td className="numeric muted">{row.pricingVersion === null ? "—" : `v${row.pricingVersion}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MiniStat(props: { label: string; value: string; note?: string }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{props.label}</span>
      <span className="stat-value">{props.value}</span>
      {props.note ? <span className="stat-note">{props.note}</span> : null}
    </div>
  );
}

function Spinner() {
  return (
    <div className="empty-state">
      <Loader2 className="spin" size={20} aria-hidden /> Loading…
    </div>
  );
}
