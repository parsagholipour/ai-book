import { useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { Button } from "../shared/Button.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { count, relative, usd } from "./format.js";
import { InspectorPanel } from "./InspectorPanel.js";
import { useAdminUsers, useDebounced } from "./useAdminData.js";
import type { AdminUserSort } from "./types.js";

const PAGE_SIZE = 25;

const SORTS: Array<{ value: AdminUserSort; label: string }> = [
  { value: "recent", label: "Newest" },
  { value: "spend", label: "Credits spent" },
  { value: "cash", label: "Money spent" },
  { value: "credits", label: "Credits held" },
  { value: "projects", label: "Books" }
];

export function UsersScreen() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AdminUserSort>("recent");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const debouncedQuery = useDebounced(query);
  const users = useAdminUsers({ query: debouncedQuery, sort, limit: PAGE_SIZE, offset });

  const total = users.data?.total ?? 0;
  const shown = users.data?.users ?? [];

  return (
    <div className={`admin-page${users.stale ? " is-stale" : ""}`}>
      <div className="admin-filter-row">
        <label className="admin-search">
          <Search size={15} aria-hidden />
          <input
            value={query}
            placeholder="Search email or name"
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(0);
            }}
          />
        </label>
        <SegmentedControl
          label="Sort by"
          options={SORTS}
          value={sort}
          onChange={(value) => {
            setSort(value);
            setOffset(0);
          }}
        />
      </div>

      {users.error ? <div className="error-banner">{users.error}</div> : null}

      <section className="work-section">
        <div className="section-title">
          <h3>Users</h3>
          <span className="muted admin-count">{count(total)} total</span>
        </div>
        {!users.data ? (
          <div className="empty-state">
            <Loader2 className="spin" size={20} aria-hidden /> Loading users…
          </div>
        ) : shown.length === 0 ? (
          <p className="muted">No users match that search.</p>
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="numeric">Credits</th>
                  <th className="numeric">Spent</th>
                  <th className="numeric">Paid</th>
                  <th className="numeric">Books</th>
                  <th>Plan</th>
                  <th>Last charge</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((user) => (
                  <tr
                    key={user.id}
                    className={`admin-row${selected === user.id ? " is-selected" : ""}`}
                    onClick={() => setSelected(user.id)}
                  >
                    <td>
                      <button type="button" className="admin-linkish">
                        {user.email}
                      </button>
                      <span className="muted admin-subtle">
                        joined {relative(user.createdAt)}
                        {user.status !== "ACTIVE" ? ` · ${user.status.toLowerCase()}` : ""}
                      </span>
                    </td>
                    <td className="numeric">{count(user.availableCredits)}</td>
                    <td className="numeric">{count(user.lifetimeSpent)}</td>
                    <td className="numeric">{usd(user.cashUsd)}</td>
                    <td className="numeric">
                      {count(user.booksCompleted)}
                      <span className="muted">/{count(user.projects)}</span>
                    </td>
                    <td>{user.subscriptionStatus ? user.subscriptionStatus.toLowerCase() : "—"}</td>
                    <td>{relative(user.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE_SIZE ? (
          <div className="admin-pager">
            <Button
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              startIcon={<ChevronLeft />}
            >
              Previous
            </Button>
            <span className="muted">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {count(total)}
            </span>
            <Button
              size="sm"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              endIcon={<ChevronRight />}
            >
              Next
            </Button>
          </div>
        ) : null}
      </section>

      {selected ? <InspectorPanel userId={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
