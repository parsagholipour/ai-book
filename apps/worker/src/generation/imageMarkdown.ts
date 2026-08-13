import { unwrapWholePageMarkdownFence } from "@book-maker/core";

/**
 * Reading and rewriting the image lines in a page's markdown.
 *
 * These live in `generation/` rather than beside the insertion handler because
 * two handlers need them — `applyImageInsertion` adds and replaces pictures,
 * `applyImageLayout` moves and removes them — and a handler may not import a
 * sibling handler. `applyImageInsertion` re-exports them so nothing that
 * already imported them from there had to move.
 *
 * Everything here is a pure string function: the callers own the reads, the
 * writes and the snapshots, which is what lets a batch of edits be applied to
 * one page's markdown in memory and written exactly once.
 */

/** Escapes a marker for use inside a RegExp. */
function escapeMarker(marker: string): string {
  return marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Append the image line after the page's prose, blank-line separated. A page
 * whose whole body is one fence-wrapped block is unwrapped first: appended
 * after the closing ``` the compiler's own unwrap no longer matches and the
 * fence turns the prose into a literal code block in both exports. But the
 * compiler's pattern spans the first opener to the LAST closer, so a page that
 * merely starts and ends with distinct fences would "unwrap" to a body whose
 * interior fence lines swap prose and code in both exports — and the callers
 * SAVE this result to `Page.markdown`, making that permanent. Such a page is
 * left exactly as written: a plain append after it compiles correctly.
 */
export function markdownWithAppendedImage(markdown: string, imageLine: string): string {
  const trimmed = markdown.trim();
  const unwrapped = unwrapWholePageMarkdownFence(trimmed);
  const base = unwrapped.includes("```") ? trimmed : unwrapped;
  return base ? `${base}\n\n${imageLine}` : imageLine;
}

/**
 * The mirror of {@link markdownWithAppendedImage}: the image line above the
 * prose.
 *
 * A leading ATX heading keeps its place and the picture goes under it. That is
 * not cosmetic — `sanitizePageMarkdown` strips a page's leading heading only
 * when it is still line one, so an image line put above it would resurrect a
 * duplicated title on that page in every compiled book.
 */
export function markdownWithPrependedImage(markdown: string, imageLine: string): string {
  const trimmed = markdown.trim();
  const unwrapped = unwrapWholePageMarkdownFence(trimmed);
  const base = unwrapped.includes("```") ? trimmed : unwrapped;
  if (!base) {
    return imageLine;
  }
  const lines = base.split(/\r?\n/);
  const heading = lines[0]?.match(/^#{1,6}\s+\S/) ? lines[0] : null;
  if (!heading) {
    return `${imageLine}\n\n${base}`;
  }
  const rest = lines.slice(1).join("\n").replace(/^\s*\n/, "");
  return rest ? `${heading}\n\n${imageLine}\n\n${rest}` : `${heading}\n\n${imageLine}`;
}

/**
 * Swaps the line carrying `replaceMarker` for the new image line, in place —
 * a replacement keeps the old picture's spot. Null when no line carries the
 * marker, which is the caller's cue to append instead.
 */
export function markdownWithReplacedImage(markdown: string, replaceMarker: string, imageLine: string): string | null {
  const markerLine = new RegExp(`^.*${escapeMarker(replaceMarker)}.*$`, "m");
  return markerLine.test(markdown) ? markdown.replace(markerLine, imageLine) : null;
}

/** Deletes the line carrying `replaceMarker`. Null when no line carries it. */
export function markdownWithRemovedImage(markdown: string, replaceMarker: string): string | null {
  const markerLine = new RegExp(`^.*${escapeMarker(replaceMarker)}.*$\\n?`, "m");
  if (!markerLine.test(markdown)) {
    return null;
  }
  return markdown.replace(markerLine, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** The exact markdown line that carries `replaceMarker`, so a move can paste it. */
export function extractMarkdownImageLine(markdown: string, replaceMarker: string): string | null {
  const markerLine = new RegExp(`^.*${escapeMarker(replaceMarker)}.*$`, "m");
  return markdown.match(markerLine)?.[0] ?? null;
}

/**
 * Moves the line carrying `marker` to the top or bottom of its own page. Null
 * when no line carries it, and the markdown unchanged when it is already
 * there — which the caller reports rather than writing a no-op revision.
 */
export function markdownWithMovedImage(
  markdown: string,
  marker: string,
  position: "top" | "bottom"
): string | null {
  const line = extractMarkdownImageLine(markdown, marker);
  const without = markdownWithRemovedImage(markdown, marker);
  if (!line || without === null) {
    return null;
  }
  return position === "top"
    ? markdownWithPrependedImage(without, line)
    : markdownWithAppendedImage(without, line);
}

/**
 * Alt text from the subject. `]` or `)` breaks the exporters' image-markdown
 * regex and the image silently vanishes from both exports, and the exact
 * "Illustration for page N" shape is rejected by `findBookLikeMarkdownIssues`
 * as a generation artifact — both degrade to the localized generic label.
 */
export function imageAltFromSubject(subject: string, fallbackLabel: string): string {
  const stripped = subject
    .replace(/[[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  if (!stripped || /^illustration for page \d+$/i.test(stripped)) {
    return fallbackLabel;
  }
  return stripped;
}
