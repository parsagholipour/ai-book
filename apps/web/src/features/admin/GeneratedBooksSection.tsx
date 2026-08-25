import { Fragment, useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "../shared/Button.js";
import { compactCount, count, dateTime, duration, percent, usd, usdFine } from "./format.js";
import type { AdminGeneratedBookDetail, AdminGeneratedBookList, CostKind, CostUsage } from "./types.js";
import { useAdminGeneratedBookDetail, useAdminGeneratedBooks } from "./useAdminData.js";

const COLUMNS = 7;
const PAGE_SIZE = 25;

export function GeneratedBooksSection(props: { days: number }) {
  const [offset, setOffset] = useState(0);
  const [expandedBookId, setExpandedBookId] = useState<string | null>(null);
  const books = useAdminGeneratedBooks({ days: props.days, limit: PAGE_SIZE, offset });
  const detail = useAdminGeneratedBookDetail(expandedBookId);

  useEffect(() => {
    setOffset(0);
    setExpandedBookId(null);
  }, [props.days]);

  function movePage(nextOffset: number) {
    setExpandedBookId(null);
    setOffset(Math.max(0, nextOffset));
  }

  return (
    <GeneratedBooksView
      list={books.data}
      listError={books.error}
      listStale={books.stale}
      expandedBookId={expandedBookId}
      detail={detail.data}
      detailError={detail.error}
      detailLoading={detail.loading}
      onToggle={(bookId) => setExpandedBookId((open) => open === bookId ? null : bookId)}
      onRetryList={() => void books.reload()}
      onRetryDetail={detail.reload}
      onPrevious={() => movePage(offset - PAGE_SIZE)}
      onNext={() => movePage(offset + PAGE_SIZE)}
    />
  );
}

export type GeneratedBooksViewProps = {
  list: AdminGeneratedBookList | null;
  listError: string | null;
  listStale: boolean;
  expandedBookId: string | null;
  detail: AdminGeneratedBookDetail | null;
  detailError: string | null;
  detailLoading: boolean;
  onToggle: (bookId: string) => void;
  onRetryList: () => void;
  onRetryDetail: () => void;
  onPrevious: () => void;
  onNext: () => void;
};

export function GeneratedBooksView(props: GeneratedBooksViewProps) {
  return (
    <section className={`work-section generated-books${props.listStale ? " is-stale" : ""}`}>
      <div className="section-title">
        <h3>Generated books</h3>
        {props.list ? <span className="muted admin-count">{count(props.list.total)} total</span> : null}
      </div>
      <p className="muted chart-subtitle">
        Books completed in this window. Revenue and provider cost include each book&apos;s full lifetime, including later
        edits, images, replans, and audiobook work.
      </p>
      {props.listError ? (
        <div className="error-banner generated-book-list-error">
          <span>{props.listError}</span>
          <button type="button" className="admin-linkish" onClick={props.onRetryList}>Retry</button>
        </div>
      ) : null}
      {!props.list && props.listError ? null : !props.list ? (
        <div className="empty-state">
          <Loader2 className="spin" size={20} aria-hidden /> Loading generated books…
        </div>
      ) : props.list.books.length === 0 ? (
        <p className="muted">No completed books in this window.</p>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Book</th>
                <th>Owner</th>
                <th className="numeric">Pages</th>
                <th className="numeric">Revenue</th>
                <th className="numeric">Provider cost</th>
                <th className="numeric">Margin</th>
                <th>Completed</th>
              </tr>
            </thead>
            <tbody>
              {props.list.books.map((book) => {
                const isOpen = props.expandedBookId === book.id;
                const detailId = `generated-book-detail-${book.id}`;
                return (
                  <Fragment key={book.id}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="cost-expander"
                          aria-expanded={isOpen}
                          aria-controls={detailId}
                          aria-label={`${isOpen ? "Hide" : "Show"} cost breakdown for ${book.title}`}
                          onClick={() => props.onToggle(book.id)}
                        >
                          {isOpen ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
                          <span className="cost-name">{book.title}</span>
                        </button>
                        <span className="muted admin-subtle cost-indent">{book.id}</span>
                      </td>
                      <td>{book.ownerEmail}</td>
                      <td className="numeric">
                        {count(book.pageCount)}
                        <span className="muted admin-subtle">
                          {count(book.imageCount)} {book.imageCount === 1 ? "image" : "images"}
                        </span>
                      </td>
                      <td className="numeric">{usd(book.revenueUsd)}</td>
                      <td className="numeric">{usdFine(book.providerCostUsd)}</td>
                      <td className={`numeric${book.marginUsd < 0 ? " is-debit" : ""}`}>
                        {usdFine(book.marginUsd)}
                        <span className="muted admin-subtle">{percent(book.marginPercent)}</span>
                      </td>
                      <td>{dateTime(book.completedAt)}</td>
                    </tr>
                    {isOpen ? (
                      <tr id={detailId} className="admin-subrow generated-book-detail-row">
                        <td colSpan={COLUMNS}>
                          <GeneratedBookDetailContent
                            bookId={book.id}
                            detail={props.detail}
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

function GeneratedBookDetailContent(props: {
  bookId: string;
  detail: AdminGeneratedBookDetail | null;
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
  if (props.loading || props.detail?.bookId !== props.bookId) {
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

      <div className="section-title generated-book-purpose-title">
        <h4>Purpose and model costs</h4>
        <span className="muted admin-subtle">{callStateSummary(detail.totals)}</span>
      </div>
      {detail.purposes.length === 0 ? (
        <p className="muted">No provider calls are associated with this book.</p>
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

function kindUsage(detail: AdminGeneratedBookDetail, kind: CostKind): CostUsage {
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
