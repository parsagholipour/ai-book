/**
 * How a stored chat attachment is handed back to its owner.
 *
 * The stored `mimeType` is not the server's word: `PATCH /creation-drafts/:id`
 * writes the draft payload the client sends, attachments included, so a client
 * can name any type for bytes it uploaded. Echoed as-is, `text/html` (or an SVG,
 * or XHTML) would be rendered by a browser that opened the URL, on the API's
 * own origin. So the type is read through an allowlist of what the upload route
 * itself accepts — anything else is `application/octet-stream` — and every
 * response is `nosniff` and a download (`Content-Disposition: attachment`).
 * Neither header changes what the app does: it draws photos with
 * `Image.network`, which ignores the disposition, and saves documents through
 * its own download path with the type the attachment record carries.
 */

const SERVED_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/bmp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/epub+zip",
  "application/rtf",
  "application/json",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values"
]);

/** The `Content-Type` a stored attachment is served as: its own type when allowlisted, bytes otherwise. */
export function servedAttachmentType(mimeType: string): string {
  const essence = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return SERVED_ATTACHMENT_TYPES.has(essence) ? essence : "application/octet-stream";
}

/**
 * `attachment` with an ASCII `filename` for old clients and the exact name as
 * RFC 5987 `filename*`. Quotes, backslashes, control characters (CR/LF among
 * them) and anything outside printable ASCII never reach the quoted form.
 */
export function attachmentContentDisposition(name: string): string {
  // A lone surrogate would make `encodeURIComponent` throw; with the `u` flag
  // only an unpaired half matches the range.
  const withoutControls = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\ud800-\udfff]/gu, "_").trim();
  const ascii = withoutControls.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").trim() || "attachment";
  const encoded = encodeURIComponent(withoutControls || "attachment").replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
