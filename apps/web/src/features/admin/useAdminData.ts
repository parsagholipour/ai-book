import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPatch } from "../../api.js";
import { readError } from "../shared/formatters.js";
import type {
  AdminCostBreakdown,
  AdminOperationEconomics,
  AdminOverview,
  AdminProjectDetail,
  AdminUserDetail,
  AdminUserList,
  AdminUserSort,
  ModerationReport
} from "./types.js";

/**
 * One fetch-with-state helper for every admin panel.
 *
 * `stale` is the reason this exists rather than a `loading` boolean per screen:
 * on a refetch the previous render is held at reduced opacity instead of being
 * replaced by a skeleton, so changing the time range does not make the page
 * jump and reflow under the reader.
 */
function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const load = useCallback(async () => {
    if (!path) {
      setData(null);
      return;
    }
    setStale(true);
    try {
      setData(await apiGet<T>(path));
      setError(null);
    } catch (loadError) {
      setError(readError(loadError));
    } finally {
      setStale(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, stale, reload: load, setData };
}

export function useAdminOverview(days: number) {
  return useResource<AdminOverview>(`/api/admin/overview?days=${days}`);
}

export function useAdminCosts(days: number) {
  return useResource<AdminCostBreakdown>(`/api/admin/costs?days=${days}`);
}

export function useAdminOperations(days: number) {
  return useResource<AdminOperationEconomics>(`/api/admin/operations?days=${days}`);
}

export function useAdminUsers(options: { query: string; sort: AdminUserSort; limit: number; offset: number }) {
  const params = new URLSearchParams({
    sort: options.sort,
    limit: String(options.limit),
    offset: String(options.offset)
  });
  if (options.query.trim()) {
    params.set("query", options.query.trim());
  }
  return useResource<AdminUserList>(`/api/admin/users?${params.toString()}`);
}

export function useAdminUserDetail(userId: string | null) {
  return useResource<AdminUserDetail>(userId ? `/api/admin/users/${encodeURIComponent(userId)}` : null);
}

export function useAdminProjectDetail(projectId: string | null) {
  return useResource<AdminProjectDetail>(projectId ? `/api/admin/projects/${encodeURIComponent(projectId)}` : null);
}

export function useModerationReports() {
  const resource = useResource<{ reports: ModerationReport[] }>("/api/admin/moderation/reports");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function review(id: string, status: string, reviewNotes: string) {
    setSaving(id);
    try {
      await apiPatch(`/api/admin/moderation/reports/${encodeURIComponent(id)}`, {
        status: status.toLowerCase(),
        ...(reviewNotes.trim() ? { reviewNotes: reviewNotes.trim() } : {})
      });
      setError(null);
      await resource.reload();
    } catch (reviewError) {
      setError(readError(reviewError));
    } finally {
      setSaving(null);
    }
  }

  return { ...resource, error: error ?? resource.error, saving, review };
}

/** Debounce so a search box does not fire a query per keystroke. */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
