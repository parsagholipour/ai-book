export const SELECTED_PROJECT_STORAGE_KEY = "ai-book-maker:selected-project-id";

export function projectIdFromCurrentPath(): string | null {
  return projectIdFromPath(window.location.pathname);
}

export function projectIdFromPath(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)\/?$/.exec(pathname);
  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}

export function syncProjectPath(projectId: string | null): void {
  const nextPath = projectId ? `/projects/${encodeURIComponent(projectId)}` : "/";
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (currentPath !== nextPath) {
    window.history.pushState(null, "", nextPath);
  }
}
