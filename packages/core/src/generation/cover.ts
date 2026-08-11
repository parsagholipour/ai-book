import { isDiagramFriendlyBookCategory } from "../categories.js";
import { withRenderPage } from "./browserPool.js";
import { scriptProfileForLanguage, type ScriptProfile } from "../prompting/script.js";
import { bookFontSetForLanguage, type BookFontSet } from "./bookFonts.js";
import { codePointsOf, embedFontFaceCss } from "./fontEmbedding.js";
import { cleanText, fitCoverText, type FittedCoverText } from "./coverText.js";
import type { BookPlan, CoverTemplateId, CreateProjectInput } from "../schemas/book.js";

export const COVER_WIDTH = 1800;
export const COVER_HEIGHT = 2400;

export type CoverMetadata = {
  title: string;
  subtitle?: string | null | undefined;
  authorName?: string | null | undefined;
  coverTagline?: string | null | undefined;
};

export type CoverArtworkPromptInput = {
  input: CreateProjectInput;
  plan: BookPlan;
  metadata: CoverMetadata;
};

export type RenderCoverOptions = CoverArtworkPromptInput & {
  artwork: {
    bytes: Buffer;
    mimeType: string;
  };
  /**
   * Typography and scrim for a bundled cover design, which was authored as a
   * whole and therefore brings its own. Absent for AI artwork, which keeps
   * being routed by `resolveCoverTemplate`.
   */
  template?: CoverTemplateOverride;
};

export type CoverTemplateOverride = {
  id: Exclude<CoverTemplateId, "auto">;
  accentColor?: string | undefined;
  /** Light artwork needs a heavier scrim: every template sets light text. */
  overlayCss?: string | undefined;
};

export type ResolvedCoverTemplate = {
  id: Exclude<CoverTemplateId, "auto">;
  titleFont: "PlayfairCover" | "NunitoCover" | "BebasCover" | "SourceSerifCover";
  supportingFont: "InterCover" | "SourceSerifCover" | "NunitoCover" | "NotoSansCover";
  titleSize: number;
  subtitleSize: number;
  authorSize: number;
  maxTitleChars: number;
  maxTitleLines: number;
  textAlign: "left" | "center";
  panel: "top" | "bottom" | "center";
  color: string;
  mutedColor: string;
  accentColor: string;
  overlayCss: string;
};

const COVER_TEMPLATES: Record<Exclude<CoverTemplateId, "auto">, ResolvedCoverTemplate> = {
  kids: {
    id: "kids",
    titleFont: "NunitoCover",
    supportingFont: "InterCover",
    titleSize: 142,
    subtitleSize: 48,
    authorSize: 42,
    maxTitleChars: 18,
    maxTitleLines: 4,
    textAlign: "center",
    panel: "bottom",
    color: "#fff7df",
    mutedColor: "#f9e7bb",
    accentColor: "#ffd166",
    overlayCss:
      "linear-gradient(180deg, rgba(25, 30, 31, 0.1) 0%, rgba(20, 31, 30, 0.25) 45%, rgba(14, 29, 28, 0.78) 100%)"
  },
  science: {
    id: "science",
    titleFont: "BebasCover",
    supportingFont: "InterCover",
    titleSize: 154,
    subtitleSize: 46,
    authorSize: 38,
    maxTitleChars: 16,
    maxTitleLines: 4,
    textAlign: "left",
    panel: "top",
    color: "#f8fbff",
    mutedColor: "#d7e9f3",
    accentColor: "#70d6ff",
    overlayCss:
      "linear-gradient(180deg, rgba(4, 21, 35, 0.82) 0%, rgba(5, 31, 47, 0.5) 42%, rgba(7, 24, 32, 0.18) 100%)"
  },
  fiction: {
    id: "fiction",
    titleFont: "PlayfairCover",
    supportingFont: "SourceSerifCover",
    titleSize: 134,
    subtitleSize: 44,
    authorSize: 38,
    maxTitleChars: 15,
    maxTitleLines: 4,
    textAlign: "left",
    panel: "bottom",
    color: "#fff8ed",
    mutedColor: "#eadcc7",
    accentColor: "#cfa86a",
    overlayCss:
      "linear-gradient(180deg, rgba(15, 15, 18, 0.06) 0%, rgba(17, 17, 20, 0.38) 44%, rgba(13, 13, 16, 0.86) 100%)"
  },
  minimal: {
    id: "minimal",
    titleFont: "SourceSerifCover",
    supportingFont: "InterCover",
    titleSize: 126,
    subtitleSize: 42,
    authorSize: 36,
    maxTitleChars: 16,
    maxTitleLines: 5,
    textAlign: "center",
    panel: "center",
    color: "#fcfbf6",
    mutedColor: "#e7e1d3",
    accentColor: "#e1bc78",
    overlayCss:
      "linear-gradient(180deg, rgba(22, 25, 25, 0.36) 0%, rgba(20, 22, 23, 0.62) 48%, rgba(19, 21, 21, 0.4) 100%)"
  },
  business: {
    id: "business",
    titleFont: "BebasCover",
    supportingFont: "InterCover",
    titleSize: 148,
    subtitleSize: 44,
    authorSize: 38,
    maxTitleChars: 16,
    maxTitleLines: 4,
    textAlign: "left",
    panel: "top",
    color: "#f5fbf7",
    mutedColor: "#d7e9df",
    accentColor: "#7bdcb5",
    overlayCss:
      "linear-gradient(180deg, rgba(8, 27, 31, 0.86) 0%, rgba(12, 39, 42, 0.58) 42%, rgba(10, 26, 29, 0.28) 100%)"
  },
  "self-help": {
    id: "self-help",
    titleFont: "SourceSerifCover",
    supportingFont: "NunitoCover",
    titleSize: 130,
    subtitleSize: 44,
    authorSize: 38,
    maxTitleChars: 17,
    maxTitleLines: 5,
    textAlign: "center",
    panel: "center",
    color: "#fffaf0",
    mutedColor: "#f6dfc5",
    accentColor: "#f4a261",
    overlayCss:
      "linear-gradient(180deg, rgba(42, 30, 24, 0.24) 0%, rgba(45, 32, 25, 0.64) 48%, rgba(34, 27, 24, 0.42) 100%)"
  },
  romance: {
    id: "romance",
    titleFont: "PlayfairCover",
    supportingFont: "SourceSerifCover",
    titleSize: 138,
    subtitleSize: 44,
    authorSize: 38,
    maxTitleChars: 15,
    maxTitleLines: 4,
    textAlign: "center",
    panel: "bottom",
    color: "#fff3f4",
    mutedColor: "#f2d2d6",
    accentColor: "#f08ca3",
    overlayCss:
      "linear-gradient(180deg, rgba(34, 18, 23, 0.1) 0%, rgba(41, 22, 29, 0.44) 44%, rgba(31, 17, 23, 0.86) 100%)"
  }
};

export function resolveCoverTemplate(
  requested: CoverTemplateId | undefined,
  category: CreateProjectInput["category"],
  subcategory?: string | null
): ResolvedCoverTemplate {
  if (requested && requested !== "auto") {
    return COVER_TEMPLATES[requested];
  }
  const normalizedSubcategory = normalizeSubcategory(subcategory);
  if (category === "KIDS") {
    return COVER_TEMPLATES.kids;
  }
  if (isDiagramFriendlyBookCategory(category)) {
    return COVER_TEMPLATES.science;
  }
  if (category === "STORY") {
    if (normalizedSubcategory.includes("romance")) {
      return COVER_TEMPLATES.romance;
    }
    return COVER_TEMPLATES.fiction;
  }
  if (category === "BUSINESS") {
    return COVER_TEMPLATES.business;
  }
  if (category === "SELF_HELP") {
    return COVER_TEMPLATES["self-help"];
  }
  if (normalizedSubcategory.includes("business")) {
    return COVER_TEMPLATES.business;
  }
  if (normalizedSubcategory.includes("self-help") || normalizedSubcategory.includes("relationships")) {
    return COVER_TEMPLATES["self-help"];
  }
  return COVER_TEMPLATES.minimal;
}

export function applyCoverTemplateOverride(
  template: ResolvedCoverTemplate,
  override: CoverTemplateOverride | undefined
): ResolvedCoverTemplate {
  if (!override) {
    return template;
  }
  return {
    ...template,
    ...(override.accentColor ? { accentColor: override.accentColor } : {}),
    ...(override.overlayCss ? { overlayCss: override.overlayCss } : {})
  };
}

/**
 * Swaps out a display face a non-Latin title cannot use.
 *
 * The script's own font is registered under every family name, so a Persian
 * title always has glyphs — but Bebas Neue is condensed uppercase Latin, and a
 * cover mixing it with Vazirmatn reads as two different books. Nunito is the
 * other high-impact display face already in the set, and keeping the swap
 * inside the closed `titleFont` union is what leaves the seven templates and
 * the design catalog untouched.
 */
export function coverTemplateForScript(
  template: ResolvedCoverTemplate,
  script: ScriptProfile
): ResolvedCoverTemplate {
  if (script.script === "latin" || template.titleFont !== "BebasCover") {
    return template;
  }
  return { ...template, titleFont: "NunitoCover" };
}

export function buildCoverArtworkPrompt(options: CoverArtworkPromptInput): string {
  const template = resolveCoverTemplate(
    options.input.mediaSettings.coverTemplate,
    options.input.category,
    options.input.subcategory
  );
  const title = cleanText(options.metadata.title);
  const subtitle = cleanText(options.metadata.subtitle ?? options.plan.subtitle);
  const tagline = cleanText(options.metadata.coverTagline);
  const baseCoverPrompt = cleanText(options.plan.illustrationPlan.coverPrompt) || options.input.prompt;
  const style = cleanText(options.input.mediaSettings.imageStyle) || options.plan.illustrationPlan.globalStyle;

  return [
    "Full-bleed text-free book cover artwork, portrait 3:4 composition.",
    `Template mood: ${template.id}.`,
    `Book category: ${options.input.category}.`,
    options.input.subcategory ? `Book subcategory context: ${options.input.subcategory}.` : "",
    `Thematic title context, not to be rendered as text: ${title}.`,
    subtitle ? `Subtitle context, not to be rendered as text: ${subtitle}.` : "",
    tagline ? `Tagline context, not to be rendered as text: ${tagline}.` : "",
    `Primary visual concept: ${baseCoverPrompt}.`,
    `Audience and premise: ${options.plan.audience}; ${options.plan.premise}.`,
    `Visual style: ${style}.`,
    "Do not include any readable text, letters, numbers, words, handwriting, captions, logos, signatures, watermarks, book title, or author name.",
    "No mockup, no book object, no border, no spine, no UI, no poster text."
  ]
    .filter(Boolean)
    .join("\n");
}

export async function renderCoverPng(options: RenderCoverOptions): Promise<Buffer> {
  const baseTemplate = applyCoverTemplateOverride(
    resolveCoverTemplate(
      options.template?.id ?? options.input.mediaSettings.coverTemplate,
      options.input.category,
      options.input.subcategory
    ),
    options.template
  );
  const script = scriptProfileForLanguage(options.input.language);
  const template = coverTemplateForScript(baseTemplate, script);
  const title = cleanText(options.metadata.title) || "Untitled Book";
  const subtitle = cleanText(options.metadata.subtitle ?? options.plan.subtitle);
  const tagline = cleanText(options.metadata.coverTagline);
  const authorName = cleanText(options.metadata.authorName);
  const titleFit = fitCoverText({
    text: title,
    baseFontSize: template.titleSize,
    minFontSize: 76,
    maxCharsPerLine: template.maxTitleChars,
    maxLines: template.maxTitleLines,
    script
  });
  const subtitleFit = fitCoverText({
    text: subtitle || tagline || "",
    baseFontSize: template.subtitleSize,
    minFontSize: 30,
    maxCharsPerLine: 38,
    maxLines: 2,
    script
  });
  const html = await buildCoverHtml({
    template,
    script,
    imageDataUrl: `data:${options.artwork.mimeType};base64,${options.artwork.bytes.toString("base64")}`,
    titleFit,
    subtitleFit,
    authorName,
    tagline: subtitle ? tagline : undefined
  });

  return withRenderPage(async (page) => {
    await page.setViewport({ width: COVER_WIDTH, height: COVER_HEIGHT, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    // `load` and `document.fonts.ready` both resolve while the artwork is still
    // being rasterized, and the screenshot then captures unpainted tiles as the
    // page backdrop — a black rectangle over the artwork. Decoding the image
    // explicitly and letting two frames go by is what makes the capture stable;
    // it started mattering once a book's fonts grew past a megabyte and gave
    // the compositor real work to lose the race to.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.evaluate(async () => {
      const art = document.querySelector("img.art");
      if (art instanceof HTMLImageElement) {
        await art.decode().catch(() => undefined);
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
    // `captureBeyondViewport` is what makes a clip usable on an RTL cover.
    // Passing `clip` alone opts into the beyond-viewport capture path, which
    // resolves the rect against the document's scroll origin — and in a
    // `dir="rtl"` document that origin sits at the right edge, so x:0 lands
    // a full cover width away from the artwork and the capture comes back as
    // nothing but the `#111` body backdrop. Layout is identical either way, so
    // this only ever looked like "the cover generated black". The clip is
    // already exactly the viewport; capturing within it is the same pixels.
    const screenshot = await page.screenshot({
      type: "png",
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: COVER_WIDTH, height: COVER_HEIGHT }
    });
    return Buffer.from(screenshot);
  });
}

async function buildCoverHtml(options: {
  template: ResolvedCoverTemplate;
  script: ScriptProfile;
  imageDataUrl: string;
  titleFit: FittedCoverText;
  subtitleFit: FittedCoverText;
  authorName?: string | undefined;
  tagline?: string | undefined;
}): Promise<string> {
  const script = options.script;
  const template = options.template;
  const fontCss = await loadCoverFontCss(
    bookFontSetForLanguage(script.code),
    [
      options.titleFit.lines.join(" "),
      options.subtitleFit.lines.join(" "),
      options.authorName ?? "",
      options.tagline ?? ""
    ].join(" ")
  );
  const panelClass = `panel-${template.panel}`;
  const textAlignClass = `align-${template.textAlign}`;
  const titleLines = options.titleFit.lines.map((line) => `<span>${escapeHtml(line)}</span>`).join("");
  const subtitleLines = options.subtitleFit.lines.map((line) => `<span>${escapeHtml(line)}</span>`).join("");
  const tagline = cleanText(options.tagline);

  return `<!doctype html>
<html lang="${script.code}" dir="${script.direction}">
<head>
<meta charset="utf-8" />
<style>
${fontCss}
* { box-sizing: border-box; }
html, body { width: ${COVER_WIDTH}px; height: ${COVER_HEIGHT}px; margin: 0; overflow: hidden; }
body { font-family: "NotoSansCover"; background: #111; }
.cover { position: relative; width: ${COVER_WIDTH}px; height: ${COVER_HEIGHT}px; overflow: hidden; }
.art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.overlay { position: absolute; inset: 0; background: ${template.overlayCss}; }
.text-panel {
  position: absolute;
  left: 132px;
  right: 132px;
  display: flex;
  flex-direction: column;
  gap: 34px;
  color: ${template.color};
  /* A line that still overflows must not widen the page. In RTL that overflow
     shifts the layout origin, which slides the artwork off the cover and
     leaves the backdrop showing through. */
  overflow: hidden;
}
.panel-top { top: 132px; }
.panel-center { top: 50%; transform: translateY(-50%); }
.panel-bottom { bottom: 128px; }
.align-center { text-align: center; align-items: center; }
/* Logical, so an RTL cover starts its type on the right. flex-start already
   resolves against the inline axis; only text-align was physical. */
.align-left { text-align: start; align-items: flex-start; }
.accent {
  width: 180px;
  height: 10px;
  background: ${template.accentColor};
  border-radius: 999px;
  opacity: 0.92;
}
.title {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 100%;
  font-family: "${template.titleFont}";
  font-size: ${options.titleFit.fontSize}px;
  font-weight: 800;
  line-height: ${script.coverTitleLineHeight};
  letter-spacing: 0;
  text-wrap: balance;
  text-shadow: 0 8px 28px rgba(0, 0, 0, 0.38);
}
.subtitle,
.tagline,
.author {
  max-width: 100%;
  font-family: "${template.supportingFont}";
  letter-spacing: 0;
  text-shadow: 0 5px 20px rgba(0, 0, 0, 0.32);
}
.subtitle {
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: ${template.mutedColor};
  font-size: ${options.subtitleFit.fontSize}px;
  font-weight: 600;
  line-height: 1.12;
}
.tagline {
  color: ${template.mutedColor};
  font-size: 34px;
  line-height: 1.2;
  font-weight: 500;
}
.author {
  margin-top: 32px;
  color: ${template.color};
  font-size: ${template.authorSize}px;
  font-weight: 800;
}
</style>
</head>
<body>
  <main class="cover">
    <img class="art" src="${options.imageDataUrl}" alt="" />
    <div class="overlay"></div>
    <section class="text-panel ${panelClass} ${textAlignClass}">
      <div class="accent"></div>
      <h1 class="title">${titleLines}</h1>
      ${subtitleLines ? `<div class="subtitle">${subtitleLines}</div>` : ""}
      ${tagline ? `<div class="tagline">${escapeHtml(tagline)}</div>` : ""}
      ${options.authorName ? `<div class="author">${escapeHtml(options.authorName)}</div>` : ""}
    </section>
  </main>
</body>
</html>`;
}

// Fontsource packages below ship OFL-1.1 fonts. Do not replace them with
// proprietary, paid, system-only, or unclear-license fonts.
const COVER_LATIN_FONTS: ReadonlyArray<[ResolvedCoverTemplate["titleFont"] | ResolvedCoverTemplate["supportingFont"], string]> = [
  ["InterCover", "@fontsource-variable/inter"],
  ["NotoSansCover", "@fontsource-variable/noto-sans"],
  ["NunitoCover", "@fontsource-variable/nunito"],
  ["PlayfairCover", "@fontsource-variable/playfair-display"],
  ["SourceSerifCover", "@fontsource-variable/source-serif-4"],
  ["BebasCover", "@fontsource/bebas-neue"]
];

/**
 * The six cover families, each carrying the book's script alongside its Latin
 * face.
 *
 * Registering the script under *every* family name is what keeps
 * `COVER_TEMPLATES` and the design catalog free of language knowledge: whatever
 * face a template names, a Persian title finds glyphs in it. The script package
 * is listed last so it wins the overlap — its range claims the joining controls
 * a Latin face would otherwise take.
 */
function loadCoverFontCss(fontSet: BookFontSet, text: string): Promise<string> {
  const codePoints = codePointsOf(text);
  const script = fontSet.body.filter((pkg) => pkg.package !== "@fontsource-variable/source-serif-4");
  return embedFontFaceCss(
    COVER_LATIN_FONTS.map(([family, pkg]) => ({
      family,
      packages: [{ package: pkg, css: ["index.css"] }, ...script],
      codePoints
    }))
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[char] ?? char;
  });
}

function normalizeSubcategory(value: string | null | undefined): string {
  return cleanText(value).toLowerCase();
}
