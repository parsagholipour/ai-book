import { Fragment, useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { apiUrl } from "../../api.js";
import { Button } from "../shared/Button.js";
import { GeneratedEconomicsDetailContent } from "./GeneratedEconomicsDetail.js";
import { count, dateTime, percent, usd, usdFine } from "./format.js";
import type { AdminGeneratedBookDetail, AdminGeneratedBookList } from "./types.js";
import { useAdminGeneratedBookDetail, useAdminGeneratedBooks } from "./useAdminData.js";

const COLUMNS = 8;
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
    <section className={`work-section generated-artifacts${props.listStale ? " is-stale" : ""}`}>
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
                <th>Download</th>
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
                      <td>
                        <span className="admin-download-links">
                          <a href={apiUrl(`/api/admin/projects/${book.id}/export/pdf`)}>PDF</a>
                          <a href={apiUrl(`/api/admin/projects/${book.id}/export/epub`)}>EPUB</a>
                        </span>
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr id={detailId} className="admin-subrow generated-book-detail-row">
                        <td colSpan={COLUMNS}>
                          <GeneratedEconomicsDetailContent
                            detail={props.detail}
                            detailMatches={props.detail?.bookId === book.id}
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
