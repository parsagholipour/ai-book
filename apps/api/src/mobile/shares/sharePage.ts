/**
 * The public share page, rendered on the server as plain HTML — no React, not
 * the console bundle. Every value that came from a person (the title, the
 * author's name, the note) is escaped here and nowhere else, and the page runs
 * no inline script: `share.js` and the vendored pdf.js are served from `/s/_/`
 * under a `script-src 'self'` policy, and read what they need from `data-`
 * attributes.
 *
 * The Open Graph tags are what a WhatsApp, X or Instagram preview shows: the
 * cover, the title, and the note only when moderation allowed it.
 */

export const ANDROID_APP_PACKAGE = "com.tomeza.tomeza";
export const SHARE_ASSET_VERSION = "1";

export type SharePageInput = {
  slug: string;
  publicApiUrl: string;
  title: string;
  subtitle: string | null;
  /** Already resolved: the author's name only when they chose to show it. */
  byline: string;
  kind: "generated" | "written";
  /** The note, only when its status is ALLOWED. */
  caption: string | null;
  mode: "preview" | "full";
  /** The reading pages the preview shows and the book holds, when known. */
  visiblePages: number | null;
  readingPages: number | null;
  /** False while the book's PDF is being rebuilt after an edit. */
  available: boolean;
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function absolute(publicApiUrl: string, path: string): string {
  return `${publicApiUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * The Play Store listing, carrying the share as the install referrer. The app
 * reads it once per install (`parseInstallReferrer`, apps/mobile
 * `lib/features/attribution/`) to offer this share's remix and attribute the
 * install, so both keys are a wire contract with installed builds.
 */
export function playStoreUrl(slug: string): string {
  const referrer = encodeURIComponent(`utm_source=share&utm_content=${slug}`);
  return `https://play.google.com/store/apps/details?id=${ANDROID_APP_PACKAGE}&referrer=${referrer}`;
}

/**
 * The Android intent URL: opens `tomeza://remix/<slug>` in the app when it is
 * installed, and the Play Store listing when it is not. No deep-link SDK.
 */
export function remixIntentUrl(slug: string): string {
  const fallback = encodeURIComponent(playStoreUrl(slug));
  return `intent://remix/${encodeURIComponent(slug)}#Intent;scheme=tomeza;package=${ANDROID_APP_PACKAGE};S.browser_fallback_url=${fallback};end`;
}

const KIND_LINE = { generated: "Created with AI on Tomeza", written: "Written on Tomeza" } as const;

const REPORT_REASONS: ReadonlyArray<[string, string]> = [
  ["offensive", "Offensive"],
  ["hate_or_harassment", "Hate or harassment"],
  ["sexual_content", "Sexual content"],
  ["violence_or_self_harm", "Violence or self-harm"],
  ["child_safety", "Child safety"],
  ["deceptive_or_misleading", "Spam or scam"],
  ["privacy_or_copyright", "Privacy or copyright"],
  ["other", "Something else"]
];

function head(options: { title: string; description: string; url?: string; image?: string }): string {
  const title = escapeHtml(options.title);
  const description = escapeHtml(options.description);
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="theme-color" content="#0F6B5C">',
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    '<meta property="og:site_name" content="Tomeza">',
    '<meta property="og:type" content="book">',
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    ...(options.url ? [`<meta property="og:url" content="${escapeHtml(options.url)}">`] : []),
    ...(options.image
      ? [
          `<meta property="og:image" content="${escapeHtml(options.image)}">`,
          '<meta property="og:image:type" content="image/jpeg">',
          `<meta name="twitter:image" content="${escapeHtml(options.image)}">`
        ]
      : []),
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<link rel="stylesheet" href="/s/_/share.css?v=${SHARE_ASSET_VERSION}">`,
    '<link rel="icon" href="/s/_/icon.svg" type="image/svg+xml">'
  ].join("\n    ");
}

export function renderSharePage(input: SharePageInput): string {
  const path = `/s/${encodeURIComponent(input.slug)}`;
  const kindLine = KIND_LINE[input.kind];
  const description = input.caption ?? `${input.byline} · ${kindLine}`;
  const previewNote =
    input.mode === "preview" && input.visiblePages !== null && input.readingPages !== null
      ? `<p class="meta-line">Preview · ${input.visiblePages} of ${input.readingPages} pages</p>`
      : "";
  const caption = input.caption
    ? `<blockquote class="caption" dir="auto">${escapeHtml(input.caption).replace(/\n/g, "<br>")}</blockquote>`
    : "";
  const subtitle = input.subtitle ? `<p class="subtitle" dir="auto">${escapeHtml(input.subtitle)}</p>` : "";
  const privateEnd =
    input.mode === "preview"
      ? `<section class="private-end" id="private-end" hidden>
        <p class="private-title">The rest of this book is private</p>
        <p class="private-body">The author shared the first pages. Make your own book on Tomeza in a few minutes.</p>
      </section>`
      : "";
  const reasons = REPORT_REASONS.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("");
  return `<!doctype html>
<html lang="en">
  <head>
    ${head({
      title: input.title,
      description,
      url: absolute(input.publicApiUrl, path),
      image: absolute(input.publicApiUrl, `${path}/cover.jpg`)
    })}
  </head>
  <body>
    <main id="share" class="share"
      data-pdf="${escapeHtml(`${path}/book.pdf`)}"
      data-available="${input.available ? "true" : "false"}"
      data-mode="${input.mode}"
      data-report="${escapeHtml(`${path}/report`)}">
      <header class="book-head">
        <img class="cover" src="${escapeHtml(`${path}/cover.jpg`)}" alt="" width="96" height="144">
        <div class="book-text">
          <h1 dir="auto">${escapeHtml(input.title)}</h1>
          ${subtitle}
          <p class="byline" dir="auto">${escapeHtml(input.byline)}</p>
          <p class="meta-line">${kindLine}</p>
          ${previewNote}
        </div>
      </header>
      ${caption}
      <a class="cta" id="remix" href="${escapeHtml(playStoreUrl(input.slug))}" data-intent="${escapeHtml(remixIntentUrl(input.slug))}">Make a book like this</a>
      <section class="viewer" id="viewer" aria-label="Book pages">
        <div class="viewer-state" id="viewer-state" role="status">
          ${input.available ? '<span class="bar"><span></span></span><span id="viewer-status">Opening the book…</span>' : "<span>This book is being updated. Check back in a minute.</span>"}
        </div>
      </section>
      ${privateEnd}
      <a class="cta cta-bottom" href="${escapeHtml(playStoreUrl(input.slug))}" data-intent="${escapeHtml(remixIntentUrl(input.slug))}">Make a book like this</a>
      <footer class="foot">
        <button type="button" class="link-button" id="report-open">Report this book</button>
        <span class="brand">Tomeza</span>
      </footer>
      <dialog class="report" id="report">
        <form method="dialog" id="report-form">
          <h2>Report this book</h2>
          <label for="report-reason">What's wrong?</label>
          <select id="report-reason" name="reason" required>${reasons}</select>
          <label for="report-comment">Anything we should know? (optional)</label>
          <textarea id="report-comment" name="comment" maxlength="1000" rows="3"></textarea>
          <p class="report-result" id="report-result" role="status"></p>
          <div class="report-actions">
            <button type="button" class="link-button" id="report-cancel">Cancel</button>
            <button type="submit" class="button" id="report-send">Send report</button>
          </div>
        </form>
      </dialog>
    </main>
    <script type="module" src="/s/_/share.js?v=${SHARE_ASSET_VERSION}"></script>
  </body>
</html>
`;
}

/** Revoked, taken down, or a slug that was retired: no bytes, no book details. */
export function renderNoLongerSharedPage(): string {
  return plainPage("This book is no longer shared", "The person who shared it has stopped sharing, or it was removed.");
}

export function renderShareNotFoundPage(): string {
  return plainPage("Book not found", "This link doesn't point to a shared book. Check that it was copied whole.");
}

function plainPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    ${head({ title, description: body })}
  </head>
  <body>
    <main class="share plain">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
      <a class="cta" href="${escapeHtml(`https://play.google.com/store/apps/details?id=${ANDROID_APP_PACKAGE}`)}">Make your own book on Tomeza</a>
    </main>
  </body>
</html>
`;
}
