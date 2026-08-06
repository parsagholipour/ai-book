import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import puppeteer from "puppeteer";
import { isDiagramFriendlyBookCategory } from "../categories.js";
import type { BookPlan, CoverTemplateId, CreateProjectInput } from "../schemas/book.js";

export const COVER_WIDTH = 1800;
export const COVER_HEIGHT = 2400;

const require = createRequire(import.meta.url);

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

export type FitCoverTextOptions = {
  text: string;
  baseFontSize: number;
  minFontSize: number;
  maxCharsPerLine: number;
  maxLines: number;
};

export type FittedCoverText = {
  fontSize: number;
  lines: string[];
  truncated: boolean;
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

let cachedFontCss: string | undefined;

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
  const template = applyCoverTemplateOverride(
    resolveCoverTemplate(
      options.template?.id ?? options.input.mediaSettings.coverTemplate,
      options.input.category,
      options.input.subcategory
    ),
    options.template
  );
  const title = cleanText(options.metadata.title) || "Untitled Book";
  const subtitle = cleanText(options.metadata.subtitle ?? options.plan.subtitle);
  const tagline = cleanText(options.metadata.coverTagline);
  const authorName = cleanText(options.metadata.authorName);
  const titleFit = fitCoverText({
    text: title,
    baseFontSize: template.titleSize,
    minFontSize: 76,
    maxCharsPerLine: template.maxTitleChars,
    maxLines: template.maxTitleLines
  });
  const subtitleFit = fitCoverText({
    text: subtitle || tagline || "",
    baseFontSize: template.subtitleSize,
    minFontSize: 30,
    maxCharsPerLine: 38,
    maxLines: 2
  });
  const html = await buildCoverHtml({
    template,
    imageDataUrl: `data:${options.artwork.mimeType};base64,${options.artwork.bytes.toString("base64")}`,
    titleFit,
    subtitleFit,
    authorName,
    tagline: subtitle ? tagline : undefined
  });

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: COVER_WIDTH, height: COVER_HEIGHT, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const screenshot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: COVER_WIDTH, height: COVER_HEIGHT }
    });
    return Buffer.from(screenshot);
  } finally {
    await browser.close();
  }
}

export function fitCoverText(options: FitCoverTextOptions): FittedCoverText {
  const text = cleanText(options.text);
  if (!text) {
    return { fontSize: options.baseFontSize, lines: [], truncated: false };
  }

  for (let fontSize = options.baseFontSize; fontSize >= options.minFontSize; fontSize -= 4) {
    const charsPerLine = Math.max(8, Math.floor(options.maxCharsPerLine * (options.baseFontSize / fontSize)));
    const lines = wrapText(text, charsPerLine);
    if (lines.length <= options.maxLines) {
      return { fontSize, lines, truncated: false };
    }
  }

  const minCharsPerLine = Math.max(8, Math.floor(options.maxCharsPerLine * (options.baseFontSize / options.minFontSize)));
  const lines = wrapText(text, minCharsPerLine).slice(0, options.maxLines);
  const last = lines.at(-1);
  if (last) {
    lines[lines.length - 1] = ellipsize(last, minCharsPerLine);
  }
  return { fontSize: options.minFontSize, lines, truncated: true };
}

function wrapText(text: string, maxCharsPerLine: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (word.length > maxCharsPerLine) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(...splitLongWord(word, maxCharsPerLine));
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
      }
      current = word;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

function splitLongWord(word: string, maxCharsPerLine: number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < word.length; index += maxCharsPerLine) {
    parts.push(word.slice(index, index + maxCharsPerLine));
  }
  return parts;
}

function ellipsize(value: string, maxLength: number): string {
  if (value.length <= Math.max(1, maxLength - 1)) {
    return `${value}...`;
  }
  return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}...`;
}

async function buildCoverHtml(options: {
  template: ResolvedCoverTemplate;
  imageDataUrl: string;
  titleFit: FittedCoverText;
  subtitleFit: FittedCoverText;
  authorName?: string | undefined;
  tagline?: string | undefined;
}): Promise<string> {
  const fontCss = await loadFontCss();
  const template = options.template;
  const panelClass = `panel-${template.panel}`;
  const textAlignClass = `align-${template.textAlign}`;
  const titleLines = options.titleFit.lines.map((line) => `<span>${escapeHtml(line)}</span>`).join("");
  const subtitleLines = options.subtitleFit.lines.map((line) => `<span>${escapeHtml(line)}</span>`).join("");
  const tagline = cleanText(options.tagline);

  return `<!doctype html>
<html>
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
}
.panel-top { top: 132px; }
.panel-center { top: 50%; transform: translateY(-50%); }
.panel-bottom { bottom: 128px; }
.align-center { text-align: center; align-items: center; }
.align-left { text-align: left; align-items: flex-start; }
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
  line-height: 0.94;
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

async function loadFontCss(): Promise<string> {
  if (cachedFontCss) {
    return cachedFontCss;
  }

  // Fontsource packages below ship OFL-1.1 fonts. Do not replace them with
  // proprietary, paid, system-only, or unclear-license fonts.
  const fonts = await Promise.all([
    fontFace("InterCover", "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", "100 900"),
    fontFace("NotoSansCover", "@fontsource-variable/noto-sans/files/noto-sans-latin-wght-normal.woff2", "100 900"),
    fontFace("NunitoCover", "@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2", "200 1000"),
    fontFace(
      "PlayfairCover",
      "@fontsource-variable/playfair-display/files/playfair-display-latin-wght-normal.woff2",
      "400 900"
    ),
    fontFace(
      "SourceSerifCover",
      "@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2",
      "200 900"
    ),
    fontFace("BebasCover", "@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2", "400")
  ]);
  cachedFontCss = fonts.join("\n");
  return cachedFontCss;
}

async function fontFace(family: string, specifier: string, weight: string): Promise<string> {
  const fontPath = require.resolve(specifier);
  const bytes = await readFile(fontPath);
  return `@font-face {
  font-family: "${family}";
  src: url("data:font/woff2;base64,${bytes.toString("base64")}") format("woff2");
  font-weight: ${weight};
  font-style: normal;
  font-display: block;
}`;
}

function cleanText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
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
