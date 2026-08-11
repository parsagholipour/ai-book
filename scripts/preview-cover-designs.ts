/**
 * Renders every bundled cover design through the real cover pipeline so they can
 * be looked at. Writes `output/cover-designs/<id>.png` plus an `index.html`
 * contact sheet.
 *
 * These are the covers readers actually see, so review the sheet before
 * changing a palette or a motif — a design that reads badly under the title
 * panel is not something a unit test can tell you about.
 *
 *   pnpm covers:preview                  # all 50
 *   pnpm covers:preview moonlit-sea ...  # just these
 */

import {
  closeSharedBrowser,
  COVER_DESIGNS,
  coverDesignSvg,
  createProjectSchema,
  renderCoverPng,
  installSharedBrowserSignalHandlers,
  type BookPlan,
  type CoverDesign
} from "../packages/core/src/index.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const outputDir = fileURLToPath(new URL("../output/cover-designs/", import.meta.url));

/** A title long enough to exercise wrapping, and an author to sit under it. */
const SAMPLE = {
  title: "The Quiet Hours Between",
  subtitle: "A book about paying attention",
  authorName: "A. Reader"
};

const requested = new Set(process.argv.slice(2));
const designs = requested.size > 0 ? COVER_DESIGNS.filter((design) => requested.has(design.id)) : COVER_DESIGNS;
if (designs.length === 0) {
  throw new Error(`No cover designs matched: ${[...requested].join(", ")}`);
}

const input = createProjectSchema.parse({
  title: SAMPLE.title,
  prompt: "A sample book used to preview the bundled cover designs.",
  category: "STORY"
});

const plan = {
  title: SAMPLE.title,
  subtitle: SAMPLE.subtitle,
  premise: "A sample premise.",
  audience: "Sample readers.",
  illustrationPlan: { globalStyle: "n/a", cadence: "manual", characterReferencePrompts: [], pageRules: [] },
  characters: []
} as unknown as BookPlan;

const removeSignalHandlers = installSharedBrowserSignalHandlers();
try {
  await mkdir(outputDir, { recursive: true });

  for (const design of designs) {
    const png = await renderCoverPng({
      input,
      plan,
      metadata: { title: SAMPLE.title, subtitle: SAMPLE.subtitle, authorName: SAMPLE.authorName },
      artwork: { bytes: Buffer.from(coverDesignSvg(design), "utf8"), mimeType: "image/svg+xml" },
      template: {
        id: design.template,
        ...(design.accentColor ? { accentColor: design.accentColor } : {}),
        ...(design.overlayCss ? { overlayCss: design.overlayCss } : {})
      }
    });
    await writeFile(join(outputDir, `${design.id}.png`), png);
    console.log(`${design.id.padEnd(20)} ${design.motif.padEnd(11)} ${(png.byteLength / 1024).toFixed(0)} KB`);
  }

  await writeFile(join(outputDir, "index.html"), contactSheet(designs));
  console.log(`\n${designs.length} designs → ${join(outputDir, "index.html")}`);
} finally {
  try {
    // Keep the signal handlers installed until Chromium is actually gone. A
    // signal during an awaited close must join cleanup, not restore Node's
    // default immediate exit and orphan the browser midway through shutdown.
    await closeSharedBrowser();
  } finally {
    removeSignalHandlers();
  }
}

function contactSheet(entries: readonly CoverDesign[]): string {
  const cards = entries
    .map(
      (design) => `<figure>
  <img src="${design.id}.png" alt="${escapeHtml(design.name)}" loading="lazy" />
  <figcaption><b>${escapeHtml(design.name)}</b> <code>${design.id}</code><br/>${escapeHtml(design.description)}<br/>
  <small>${design.motif} · ${design.template} · ${design.tags.join(", ")}</small></figcaption>
</figure>`
    )
    .join("\n");
  return `<!doctype html>
<meta charset="utf-8" />
<title>Cover designs (${entries.length})</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 32px; background: #14161a; color: #e8e8ea; }
  h1 { font-size: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 28px; }
  figure { margin: 0; }
  img { width: 100%; border-radius: 8px; display: block; box-shadow: 0 12px 32px rgba(0,0,0,0.45); }
  figcaption { margin-top: 10px; color: #b9bcc4; font-size: 12px; }
  code { color: #8fd3c1; }
  small { color: #7e8494; }
</style>
<h1>${entries.length} cover designs</h1>
<div class="grid">
${cards}
</div>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[char] ?? char);
}
