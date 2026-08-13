import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Where a book's illustrations live on disk, and the one shape a manuscript may
 * name them in.
 *
 * The PDF and the EPUB both walk the compiled markdown turning
 * `/assets/images/<projectId>/<filename>` into a file, and they used to do it
 * with a copy of this function each. The copies disagreed: the PDF path checked
 * that the result stayed inside `imageStorageDir` before using it, the EPUB path
 * did not — and the filename group matches slashes, so
 * `![x](/assets/images/p/../../../../etc/passwd)` resolved to a real server file
 * and was packaged into the reader's download as an illustration. Manuscript
 * text is user-supplied (imports, exact-replacement edits), so that was an
 * arbitrary file read with the file handed straight to the requester.
 *
 * One resolver, containment enforced here, so a caller cannot forget it.
 *
 * Containment alone only says "somewhere under the storage directory", and that
 * directory holds every project's illustrations. `projectId` is the second half:
 * a manuscript is user text, so a book whose markdown names
 * `/assets/images/<someone-elses-project>/page-3.png` was reading another
 * reader's illustration out of shared storage — the PDF stopped at the renderer's
 * per-project allowlist, but the EPUB read the file itself and packaged it into
 * the download. Pass it whenever the compile knows which book it is compiling;
 * omitting it keeps the whole storage directory in scope, which is only right
 * for a render belonging to no project (the fixture corpus).
 */

export type BookImageAsset = {
  /** Absolute path on disk. Guaranteed to be `<imageStorageDir>/<projectId>/<filename>`. */
  localPath: string;
  /**
   * The same file as the renderer addresses it — `projectId/filename`, relative
   * to `imageStorageDir` and percent-encoded per segment.
   */
  assetPath: string;
};

const ASSET_URL_RE = /\/assets\/images\/([^/]+)\/([^)\s]+)/;

/**
 * The one shape an inline image takes in book markdown: `![alt](src)`, with the
 * alt in group 1 and the src in group 2. Both exporters walk the compiled
 * markdown with it, and the API uses it to ask whether a page already carries an
 * inline illustration.
 *
 * A factory rather than a shared const because the flag is `g`: a global RegExp
 * carries `lastIndex` between `exec`/`test` calls, so one module's half-finished
 * scan would silently skip matches in another's. Every caller gets a fresh
 * instance.
 */
export function imageMarkdownRe(): RegExp {
  return /!\[([^\]]*)\]\(([^)]+)\)/g;
}

export function resolveBookImageAsset(
  src: string,
  options: { imageStorageDir: string; publicApiBase: string; projectId?: string | undefined }
): BookImageAsset | null {
  let pathPart = src.trim();
  if (pathPart.startsWith(options.publicApiBase)) {
    pathPart = pathPart.slice(options.publicApiBase.length);
  }

  const match = ASSET_URL_RE.exec(pathPart);
  const projectId = match?.[1];
  const filename = match?.[2];
  if (!projectId || !filename) {
    return null;
  }

  // Decoded before it touches the filesystem, because that is what the API's own
  // asset route does with these two segments — and therefore what the traversal
  // check has to be applied to. `%2F..%2F` is a path separator.
  const root = resolve(options.imageStorageDir);
  const localPath = resolve(join(root, decodePathSegment(projectId), decodePathSegment(filename)));
  const relativePath = relative(root, localPath);
  if (!relativePath || isAbsolute(relativePath)) {
    return null;
  }

  // Exactly the `<projectId>/<filename>` shape `GET /assets/images/:projectId/:filename`
  // serves. Containment alone would already stop `..` climbing out of the storage
  // directory; insisting on the two segments also keeps the book from reading
  // anything in there that is not an illustration — another compile's temporary
  // render document, say.
  const segments = relativePath.split(sep);
  if (segments.length !== 2 || segments.some((segment) => !segment || segment === "..")) {
    return null;
  }
  // Compared after decoding and resolving, so `%70roj-2` and `proj-1/../proj-2`
  // are the same claim as `proj-2` — this is the directory the file was actually
  // read from, not the text the manuscript wrote.
  if (options.projectId !== undefined && segments[0] !== options.projectId) {
    return null;
  }
  return { localPath, assetPath: segments.map(encodeURIComponent).join("/") };
}

/** A filename that is not valid percent-encoding (`100%.png`) is its own name. */
function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
