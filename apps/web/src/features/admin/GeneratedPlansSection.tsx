import { Fragment, useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "../shared/Button.js";
import { GeneratedEconomicsDetailContent } from "./GeneratedEconomicsDetail.js";
import { count, dateTime, percent, usd, usdFine } from "./format.js";
import type { AdminGeneratedPlanDetail, AdminGeneratedPlanList } from "./types.js";
import { useAdminGeneratedPlanDetail, useAdminGeneratedPlans } from "./useAdminData.js";

const COLUMNS = 7;
const PAGE_SIZE = 25;

export function GeneratedPlansSection(props: { days: number }) {
  const [offset, setOffset] = useState(0);
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null);
  const plans = useAdminGeneratedPlans({ days: props.days, limit: PAGE_SIZE, offset });
  const detail = useAdminGeneratedPlanDetail(expandedPlanId);

  useEffect(() => {
    setOffset(0);
    setExpandedPlanId(null);
  }, [props.days]);

  function movePage(nextOffset: number) {
    setExpandedPlanId(null);
    setOffset(Math.max(0, nextOffset));
  }

  return (
    <GeneratedPlansView
      list={plans.data}
      listError={plans.error}
      listStale={plans.stale}
      expandedPlanId={expandedPlanId}
      detail={detail.data}
      detailError={detail.error}
      detailLoading={detail.loading}
      onToggle={(planId) => setExpandedPlanId((open) => open === planId ? null : planId)}
      onRetryList={() => void plans.reload()}
      onRetryDetail={detail.reload}
      onPrevious={() => movePage(offset - PAGE_SIZE)}
      onNext={() => movePage(offset + PAGE_SIZE)}
    />
  );
}

export type GeneratedPlansViewProps = {
  list: AdminGeneratedPlanList | null;
  listError: string | null;
  listStale: boolean;
  expandedPlanId: string | null;
  detail: AdminGeneratedPlanDetail | null;
  detailError: string | null;
  detailLoading: boolean;
  onToggle: (planId: string) => void;
  onRetryList: () => void;
  onRetryDetail: () => void;
  onPrevious: () => void;
  onNext: () => void;
};

export function GeneratedPlansView(props: GeneratedPlansViewProps) {
  return (
    <section className={`work-section generated-artifacts${props.listStale ? " is-stale" : ""}`}>
      <div className="section-title">
        <h3>Generated plans</h3>
        {props.list ? <span className="muted admin-count">{count(props.list.total)} total</span> : null}
      </div>
      <p className="muted chart-subtitle">
        Plans generated in this window. Revenue and provider cost cover plan generation only; a book later generated
        from the plan is intentionally excluded.
      </p>
      {props.listError ? (
        <div className="error-banner generated-book-list-error">
          <span>{props.listError}</span>
          <button type="button" className="admin-linkish" onClick={props.onRetryList}>Retry</button>
        </div>
      ) : null}
      {!props.list && props.listError ? null : !props.list ? (
        <div className="empty-state">
          <Loader2 className="spin" size={20} aria-hidden /> Loading generated plans…
        </div>
      ) : props.list.plans.length === 0 ? (
        <p className="muted">No generated plans in this window.</p>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Owner</th>
                <th className="numeric">Target pages</th>
                <th className="numeric">Revenue</th>
                <th className="numeric">Provider cost</th>
                <th className="numeric">Margin</th>
                <th>Generated</th>
              </tr>
            </thead>
            <tbody>
              {props.list.plans.map((plan) => {
                const isOpen = props.expandedPlanId === plan.id;
                const detailId = `generated-plan-detail-${plan.id}`;
                return (
                  <Fragment key={plan.id}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="cost-expander"
                          aria-expanded={isOpen}
                          aria-controls={detailId}
                          aria-label={`${isOpen ? "Hide" : "Show"} cost breakdown for ${plan.title}`}
                          onClick={() => props.onToggle(plan.id)}
                        >
                          {isOpen ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
                          <span className="cost-name">{plan.title}</span>
                        </button>
                        <span className="muted admin-subtle cost-indent">{plan.id}</span>
                      </td>
                      <td>{plan.ownerEmail}</td>
                      <td className="numeric">
                        {count(plan.targetPages)}
                        <span className="muted admin-subtle">v{plan.version} · {statusLabel(plan.status)}</span>
                      </td>
                      <td className="numeric">{usd(plan.revenueUsd)}</td>
                      <td className="numeric">{usdFine(plan.providerCostUsd)}</td>
                      <td className={`numeric${plan.marginUsd < 0 ? " is-debit" : ""}`}>
                        {usdFine(plan.marginUsd)}
                        <span className="muted admin-subtle">{percent(plan.marginPercent)}</span>
                      </td>
                      <td>{dateTime(plan.generatedAt)}</td>
                    </tr>
                    {isOpen ? (
                      <tr id={detailId} className="admin-subrow generated-book-detail-row">
                        <td colSpan={COLUMNS}>
                          <GeneratedEconomicsDetailContent
                            detail={props.detail}
                            detailMatches={props.detail?.planId === plan.id}
                            error={props.detailError}
                            loading={props.detailLoading}
                            onRetry={props.onRetryDetail}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {props.list && props.list.total > props.list.limit ? (
        <div className="admin-pager">
          <Button
            size="sm"
            disabled={props.listStale || props.list.offset === 0}
            onClick={props.onPrevious}
            startIcon={<ChevronLeft />}
          >
            Previous
          </Button>
          <span className="muted">
            {props.list.offset + 1}–{Math.min(props.list.offset + props.list.limit, props.list.total)} of{" "}
            {count(props.list.total)}
          </span>
          <Button
            size="sm"
            disabled={props.listStale || props.list.offset + props.list.limit >= props.list.total}
            onClick={props.onNext}
            endIcon={<ChevronRight />}
          >
            Next
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function statusLabel(status: string): string {
  return status.toLowerCase().replaceAll("_", " ");
}
