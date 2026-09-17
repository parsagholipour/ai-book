import { withStoredBookImages, type BookImageOptions } from "./storedBookImages.js";
import { writeFile } from "node:fs/promises";
import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  InternalHyperlink,
  LevelFormat,
  LineRuleType,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  TextRun,
  convertMillimetersToTwip,
  type FileChild,
  type IFontAttributesProperties,
  type INumberingOptions,
  type IStylesOptions
} from "docx";
import type { Token } from "marked";
import { scriptProfileForLanguage, type ScriptProfile } from "../prompting/script.js";
import {
  loadDocxImageAssets,
  prepareDocxSource,
  rasterizeFigure,
  type DocxImage,
  type DocxSegment,
  type DocxTitlePage
} from "./docxAssets.js";
import {
  BULLET_NUMBERING,
  BYLINE_STYLE,
  CAPTION_STYLE,
  CODE_STYLE,
  CONTENTS_ENTRY_STYLE,
  ORDERED_NUMBERING,
  SUBTITLE_STYLE,
  blocksFromToken,
  collectChapters,
  imageParagraph,
  inlineRuns,
  lexMarkdown,
  styledParagraph,
  textRun,
  type DocxChapter,
  type DocxFonts,
  type DocxRenderContext
} from "./docxMarkdown.js";
import { figureStandIn } from "./figures/figureBlocks.js";
import { figureCaptionText, figureRenderContext } from "./figures/figureHtml.js";
import { markdownLabels } from "./markdownLabels.js";

/**
 * The Word (.docx) export, built from the same compiled markdown the PDF and
 * EPUB take.
 *
 * It is a subscriber format, produced on every compile as a best-effort
 * companion like the EPUB: a render that fails records a warning and never
 * fails the book. Three choices are deliberate and match the EPUB's:
 *
 * - **Fonts are named, not embedded.** Word substitutes when a face is missing,
 *   and every reader of a Word file expects to change the font anyway.
 * - **The Contents is a static list of hyperlinks**, one per chapter heading,
 *   each bound to a bookmark on its heading. A Word TOC *field* would make the
 *   document ask "update fields?" on every open, and a book's contents do not
 *   change under the reader.
 * - **No HTML is rendered.** The compiler's own furniture is read back into
 *   fields by `prepareDocxSource`; anything else a manuscript carries as markup
 *   is dropped, and only `http`, `https` and `mailto` links survive.
 */

export type GenerateBookDocxOptions = BookImageOptions & {
  title: string;
  author?: string | undefined;
  language?: string | undefined;
  publicApiUrl: string;
  outputPath?: string | undefined;
  /**
   * The project being compiled. It narrows the illustrations this book may
   * embed to that project's own, the way `sendOwnedProjectAsset` narrows the
   * HTTP asset route and `projectId` narrows the PDF renderer's file access.
   * Omitting it leaves the whole image storage directory in scope, which is
   * only right for a book belonging to no project.
   */
  projectId?: string | undefined;
};

/** The one monospace face every Word install resolves. */
const MONO_FONT = "Courier New";

/**
 * Real family names per font set, because Word resolves names and the PDF's
 * `SourceSerifBook`/`InterBook` aliases exist only inside its own stylesheet.
 * Keyed by `BookFontSet.id`; `docxFontsFor` falls back to Latin for a set it
 * does not know, and a test holds this table to `allBookFontSets()`.
 */
const DOCX_FONTS_BY_SET: Record<string, DocxFonts> = {
  latin: fonts({}),
  "arabic-persian": fonts({ complexScript: "Vazirmatn" }),
  "arabic-naskh": fonts({ complexScript: "Noto Naskh Arabic" }),
  hebrew: fonts({ complexScript: "Noto Serif Hebrew" }),
  devanagari: fonts({ complexScript: "Noto Serif Devanagari" }),
  thai: fonts({ complexScript: "Noto Serif Thai" }),
  "han-simplified": fonts({ eastAsia: "Noto Serif SC" }),
  japanese: fonts({ eastAsia: "Noto Serif JP" }),
  korean: fonts({ eastAsia: "Noto Serif KR" })
};

function fonts(overrides: { complexScript?: string; eastAsia?: string }): DocxFonts {
  return {
    body: "Source Serif 4",
    headings: "Inter",
    mono: MONO_FONT,
    complexScript: overrides.complexScript,
    eastAsia: overrides.eastAsia
  };
}

export function docxFontsFor(profile: ScriptProfile): DocxFonts {
  return DOCX_FONTS_BY_SET[profile.fontSet] ?? DOCX_FONTS_BY_SET.latin!;
}

function fontAttributes(family: string, fontSet: DocxFonts): IFontAttributesProperties {
  return {
    ascii: family,
    hAnsi: family,
    cs: fontSet.complexScript ?? family,
    eastAsia: fontSet.eastAsia ?? family
  };
}

function docxStyles(profile: ScriptProfile, fontSet: DocxFonts): IStylesOptions {
  const body = fontAttributes(fontSet.body, fontSet);
  const headings = fontAttributes(fontSet.headings, fontSet);
  const rtl = profile.direction === "rtl";
  const eastAsian = fontSet.eastAsia !== undefined;
  return {
    default: {
      document: {
        run: {
          font: body,
          size: 22,
          language: {
            value: profile.code,
            ...(rtl ? { bidirectional: profile.code } : {}),
            ...(eastAsian ? { eastAsia: profile.code } : {})
          }
        },
        paragraph: {
          spacing: { line: Math.round(profile.lineHeight * 240), lineRule: LineRuleType.AUTO, after: 160 }
        }
      },
      title: {
        run: { font: headings, size: 44, bold: true },
        paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 2400, after: 240 } }
      },
      heading1: {
        run: { font: headings, size: 30, bold: true },
        paragraph: { spacing: { before: 480, after: 240 }, keepNext: true, outlineLevel: 0 }
      },
      heading2: {
        run: { font: headings, size: 25, bold: true },
        paragraph: { spacing: { before: 320, after: 160 }, keepNext: true, outlineLevel: 1 }
      },
      heading3: {
        run: { font: headings, size: 22, bold: true },
        paragraph: { spacing: { before: 240, after: 120 }, keepNext: true, outlineLevel: 2 }
      }
    },
    paragraphStyles: [
      {
        id: SUBTITLE_STYLE,
        name: "Book Subtitle",
        basedOn: "Normal",
        run: { size: 26, ...(profile.hasItalic ? { italics: true } : {}) },
        paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 200 } }
      },
      {
        id: BYLINE_STYLE,
        name: "Book Byline",
        basedOn: "Normal",
        run: { size: 22 },
        paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 600, after: 200 } }
      },
      {
        id: CAPTION_STYLE,
        name: "Book Caption",
        basedOn: "Normal",
        run: { size: 17, color: "555555" },
        paragraph: { spacing: { before: 80, after: 280 } }
      },
      {
        id: CODE_STYLE,
        name: "Book Code",
        basedOn: "Normal",
        run: { font: MONO_FONT, size: 18 },
        paragraph: {
          shading: { type: ShadingType.CLEAR, fill: "F4F4F4" },
          spacing: { after: 0, line: 240, lineRule: LineRuleType.AUTO }
        }
      },
      {
        id: CONTENTS_ENTRY_STYLE,
        name: "Book Contents Entry",
        basedOn: "Normal",
        paragraph: { spacing: { after: 80 } }
      }
    ]
  };
}

function docxNumbering(): INumberingOptions {
  const bullets = ["•", "◦", "▪"];
  return {
    config: [
      {
        reference: BULLET_NUMBERING,
        levels: bullets.map((text, level) => ({
          level,
          format: LevelFormat.BULLET,
          text,
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } }
        }))
      },
      {
        reference: ORDERED_NUMBERING,
        levels: [0, 1, 2].map((level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } }
        }))
      }
    ]
  };
}

/**
 * A4, with the text block the PDF sets: `@page { margin: 20mm 18mm 22mm }` in
 * `pdfCss.ts` is what actually sizes the printed page, so this mirrors it.
 */
function pageProperties() {
  return {
    page: {
      size: { width: convertMillimetersToTwip(210), height: convertMillimetersToTwip(297) },
      margin: {
        top: convertMillimetersToTwip(20),
        right: convertMillimetersToTwip(18),
        bottom: convertMillimetersToTwip(22),
        left: convertMillimetersToTwip(18),
        footer: convertMillimetersToTwip(10)
      }
    }
  };
}

function pageNumberFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: [PageNumber.CURRENT], size: 18 })]
      })
    ]
  });
}

function titlePageBlocks(titlePage: DocxTitlePage, ctx: DocxRenderContext): FileChild[] {
  const blocks: FileChild[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      ...(ctx.profile.direction === "rtl" ? { bidirectional: true } : {}),
      children: [textRun(titlePage.title, ctx)]
    })
  ];
  if (titlePage.subtitle) {
    blocks.push(styledParagraph(titlePage.subtitle, SUBTITLE_STYLE, ctx));
  }
  if (titlePage.byline) {
    blocks.push(styledParagraph(titlePage.byline, BYLINE_STYLE, ctx));
  }
  return blocks;
}

function contentsBlocks(chapters: readonly DocxChapter[], heading: string, ctx: DocxRenderContext): FileChild[] {
  const rtl = ctx.profile.direction === "rtl";
  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      ...(rtl ? { bidirectional: true } : {}),
      children: [textRun(heading, ctx)]
    }),
    ...chapters.map(
      (chapter) =>
        new Paragraph({
          style: CONTENTS_ENTRY_STYLE,
          ...(rtl ? { bidirectional: true } : {}),
          children: [
            new InternalHyperlink({
              anchor: chapter.anchor,
              children: [textRun(chapter.title, ctx, { link: true })]
            })
          ]
        })
    )
  ];
}

async function figureBlocks(segment: Extract<DocxSegment, { kind: "figure" }>, ctx: DocxRenderContext, language: string | undefined): Promise<FileChild[]> {
  const { fence } = segment;
  const figureContext = figureRenderContext(language);
  const raster = fence.spec ? await rasterizeFigure(fence.spec, figureContext) : null;
  if (!fence.spec || !raster) {
    return [styledParagraph(figureStandIn(fence.title), CAPTION_STYLE, ctx)];
  }
  const caption = figureCaptionText(fence.spec, figureContext);
  const captionRuns = [
    textRun(caption.title, ctx, { bold: true }),
    ...(caption.caption ? [textRun(` ${caption.caption}`, ctx)] : []),
    textRun(` ${caption.sourceLine}`, ctx)
  ];
  return [
    imageParagraph(raster, fence.spec.title, ctx),
    new Paragraph({
      style: CAPTION_STYLE,
      ...(ctx.profile.direction === "rtl" ? { bidirectional: true } : {}),
      children: captionRuns
    })
  ];
}

function isPageBreakingHeading(token: Token | undefined): boolean {
  return token?.type === "heading" && ((token as { depth: number }).depth === 1 || (token as { depth: number }).depth === 2);
}

/** Builds a Word document from the compiled book markdown. */
export async function generateBookDocx(markdown: string, options: GenerateBookDocxOptions): Promise<Buffer> {
  if (options.imageSource === "object-storage") {
    return withStoredBookImages(markdown, options, (imageStorageDir) =>
      generateBookDocx(markdown, { ...options, imageStorageDir, imageSource: "local" }));
  }
  const profile = scriptProfileForLanguage(options.language);
  const labels = markdownLabels(options.language);
  const fontSet = docxFontsFor(profile);
  const source = prepareDocxSource(markdown);
  const images = await loadDocxImageAssets(markdown, options);

  const lexed = source.segments.map((segment) => (segment.kind === "markdown" ? lexMarkdown(segment.text) : []));
  const chapters = collectChapters(lexed);
  const ctx: DocxRenderContext = {
    profile,
    fonts: fontSet,
    images,
    chapters,
    nextChapter: 0,
    listInstance: 0
  };

  const children: FileChild[] = [];
  let frontMatter = false;
  if (source.cover) {
    const cover: DocxImage | undefined = images.get(source.cover.src);
    if (cover) {
      children.push(imageParagraph(cover, source.cover.alt || labels.bookCover, ctx));
      frontMatter = true;
    }
  }
  if (source.titlePage) {
    children.push(...titlePageBlocks(source.titlePage, ctx));
    frontMatter = true;
  }

  const printsContents = chapters.length > 1;
  let contentsPlaced = false;
  let sawTitleHeading = false;
  let bodyStarted = false;
  for (const [index, segment] of source.segments.entries()) {
    if (segment.kind === "figure") {
      children.push(...(await figureBlocks(segment, ctx, options.language)));
      bodyStarted = true;
      continue;
    }
    const tokens = lexed[index] ?? [];
    for (let position = 0; position < tokens.length; position += 1) {
      const token = tokens[position]!;
      if (token.type === "space") {
        continue;
      }
      const isTitleHeading = !sawTitleHeading && !bodyStarted && token.type === "heading" && (token as { depth: number }).depth === 1;
      if (printsContents && !contentsPlaced && token.type === "heading" && (token as { depth: number }).depth === 2) {
        children.push(...contentsBlocks(chapters, labels.contentsHeading, ctx));
        contentsPlaced = true;
      } else if (frontMatter && !bodyStarted && !isPageBreakingHeading(token)) {
        // The cover or title page has to end somewhere: a chapter heading breaks
        // the page itself, anything else needs the break put in front of it.
        children.push(new Paragraph({ children: [new PageBreak()] }));
      }
      frontMatter = false;
      if (isTitleHeading) {
        sawTitleHeading = true;
        const heading = token as { tokens: Token[] };
        children.push(
          new Paragraph({
            heading: HeadingLevel.TITLE,
            ...(profile.direction === "rtl" ? { bidirectional: true } : {}),
            children: inlineRuns(heading.tokens, ctx)
          })
        );
        // The compiler writes the subtitle as an emphasised paragraph right
        // under a bare `# Title`; print it as the subtitle it is.
        const next = tokens.slice(position + 1).find((candidate) => candidate.type !== "space");
        const emphasis = next?.type === "paragraph" ? (next as { tokens: Token[] }).tokens : undefined;
        if (next && emphasis && emphasis.length === 1 && emphasis[0]?.type === "em") {
          children.push(
            new Paragraph({
              style: SUBTITLE_STYLE,
              ...(profile.direction === "rtl" ? { bidirectional: true } : {}),
              children: inlineRuns((emphasis[0] as { tokens: Token[] }).tokens, ctx)
            })
          );
          position = tokens.indexOf(next);
        }
        continue;
      }
      bodyStarted = true;
      children.push(...blocksFromToken(token, ctx));
    }
  }
  if (children.length === 0) {
    children.push(new Paragraph({ children: [textRun(options.title, ctx)] }));
  }

  const document = new Document({
    title: options.title,
    ...(options.author ? { creator: options.author } : {}),
    styles: docxStyles(profile, fontSet),
    numbering: docxNumbering(),
    sections: [
      {
        properties: pageProperties(),
        footers: { default: pageNumberFooter() },
        children
      }
    ]
  });

  const bytes = await Packer.toBuffer(document);
  if (options.outputPath) {
    await writeFile(options.outputPath, bytes);
  }
  return bytes;
}
