export const SELECTED_PROJECT_STORAGE_KEY = "ai-book-maker:selected-project-id";

/**
 * The console's project route.
 *
 * React Router owns reading the id back out (`useParams`); this exists only so
 * the encoding is written once. Ids come out of the router already decoded, so
 * nothing should decode them a second time.
 */
export function projectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export const ADMIN_PATH = "/admin";
/** Kept as a redirect into the dashboard: it was a real URL before the tabs existed. */
export const PRICING_PATH = "/pricing";
