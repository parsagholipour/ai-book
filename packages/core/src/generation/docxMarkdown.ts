import {
  AlignmentType,
  Bookmark,
  BorderStyle,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type FileChild,
  type IParagraphOptions,
  type ParagraphChild
} from "docx";
import { marked, type Token, type Tokens } from "marked";
import type { ScriptProfile } from "../prompting/script.js";
import { externalLinkTarget, type DocxImage } from "./docxAssets.js";

/**
 * The marked token walk behind the Word export: one block token in, the Word
 * paragraphs and tables it becomes out.
 *
 * Every paragraph of an RTL book is `bidirectional` and every run of it
 * `rightToLeft`, except code, which is left-to-right whatever the script. A
 * script with no italic face prints emphasis bold, the rule the EPUB's
 * stylesheet applies. Raw HTML — block or inline — is dropped: this export
 * renders no markup, and the compiler's own HTML furniture has already been
 * taken out by `prepareDocxSource`.
 */

/** The font families the document names. Word substitutes what it lacks. */
export type DocxFonts = {
  body: string;
  headings: string;
  mono: string;
  /** Complex-script face for Arabic, Hebrew, Devanagari and Thai runs. */
  complexScript: string | undefined;
  /** East Asian face for Han, Kana and Hangul runs. */
  eastAsia: string | undefined;
};

export type DocxChapter = { anchor: string; title: string };

export type DocxRenderContext = {
  profile: ScriptProfile;
  fonts: DocxFonts;
  /** Illustrations keyed by the `src` the manuscript wrote. */
  images: ReadonlyMap<string, DocxImage>;
  /** Every `##` heading in document order; `nextChapter` walks it. */
  chapters: readonly DocxChapter[];
  nextChapter: number;
  /** Restarts numbering per top-level ordered list. */
  listInstance: number;
};

export const BULLET_NUMBERING = "book-bullets";
export const ORDERED_NUMBERING = "book-ordered";
export const CODE_STYLE = "BookCode";
export const CAPTION_STYLE = "BookCaption";
export const SUBTITLE_STYLE = "BookSubtitle";
export const BYLINE_STYLE = "BookByline";
export const CONTENTS_ENTRY_STYLE = "BookContentsEntry";
export const HYPERLINK_STYLE = "Hyperlink";

type RunStyle = {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
};

type BlockStyle = {
  quote?: boolean;
};

export function lexMarkdown(text: string): Token[] {
  return marked.lexer(text, { gfm: true });
}

/** The chapter list a document's Contents is built from: every `##` heading, in order. */
export function collectChapters(tokenLists: readonly Token[][]): DocxChapter[] {
  const chapters: DocxChapter[] = [];
  for (const tokens of tokenLists) {
    for (const token of tokens) {
      if (token.type === "heading" && (token as Tokens.Heading).depth === 2) {
        chapters.push({
          anchor: `chapter-${chapters.length + 1}`,
          title: plainText((token as Tokens.Heading).tokens)
        });
      }
    }
  }
  return chapters;
}

export function plainText(tokens: readonly Token[] | undefined): string {
  if (!tokens) {
    return "";
  }
  return tokens
    .map((token) => {
      switch (token.type) {
        case "text":
        case "escape":
        case "codespan":
          return (token as Tokens.Text).tokens ? plainText((token as Tokens.Text).tokens) : (token as Tokens.Text).text;
        case "strong":
        case "em":
        case "del":
        case "link":
          return plainText((token as Tokens.Strong).tokens);
        case "image":
          return (token as Tokens.Image).text;
        case "br":
          return " ";
        default:
          return "";
      }
    })
    .join("");
}

function isRtl(ctx: DocxRenderContext): boolean {
  return ctx.profile.direction === "rtl";
}

/** A run in the book's own script, or in the monospace face for code. */
export function textRun(text: string, ctx: DocxRenderContext, style: RunStyle = {}): TextRun {
  const emphasis = style.italics && !ctx.profile.hasItalic ? { bold: true } : style.italics ? { italics: true } : {};
  return new TextRun({
    text,
    ...(style.bold ? { bold: true } : {}),
    ...emphasis,
    ...(style.strike ? { strike: true } : {}),
    ...(style.code
      ? { font: ctx.fonts.mono, rightToLeft: false }
      : isRtl(ctx)
        ? { rightToLeft: true }
        : {}),
    ...(style.link ? { style: HYPERLINK_STYLE } : {})
  });
}

function paragraphOptions(ctx: DocxRenderContext, block: BlockStyle, extra: IParagraphOptions = {}): IParagraphOptions {
  return {
    ...(isRtl(ctx) ? { bidirectional: true } : {}),
    ...(block.quote
      ? {
          indent: { left: 720 },
          border: { left: { style: BorderStyle.SINGLE, size: 6, color: "D7D7D7", space: 8 } }
        }
      : {}),
    ...extra
  };
}

export function imageParagraph(image: DocxImage, alt: string, ctx: DocxRenderContext): Paragraph {
  return new Paragraph(
    paragraphOptions(
      ctx,
      {},
      {
        alignment: AlignmentType.CENTER,
        children: [imageRun(image, alt)]
      }
    )
  );
}

export function imageRun(image: DocxImage, alt: string): ImageRun {
  const name = alt.trim() || "Illustration";
  return new ImageRun({
    type: image.type,
    data: image.data,
    transformation: { width: image.width, height: image.height },
    altText: { name, description: name, title: name }
  });
}

/** Inline tokens to runs, links and pictures. */
export function inlineRuns(tokens: readonly Token[] | undefined, ctx: DocxRenderContext, style: RunStyle = {}): ParagraphChild[] {
  if (!tokens) {
    return [];
  }
  const runs: ParagraphChild[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        if (text.tokens && text.tokens.length > 0) {
          runs.push(...inlineRuns(text.tokens, ctx, style));
        } else if (text.text) {
          runs.push(textRun(text.text, ctx, style));
        }
        break;
      }
      case "escape":
        runs.push(textRun((token as Tokens.Escape).text, ctx, style));
        break;
      case "strong":
        runs.push(...inlineRuns((token as Tokens.Strong).tokens, ctx, { ...style, bold: true }));
        break;
      case "em":
        runs.push(...inlineRuns((token as Tokens.Em).tokens, ctx, { ...style, italics: true }));
        break;
      case "del":
        runs.push(...inlineRuns((token as Tokens.Del).tokens, ctx, { ...style, strike: true }));
        break;
      case "codespan":
        runs.push(textRun((token as Tokens.Codespan).text, ctx, { ...style, code: true }));
        break;
      case "br":
        runs.push(new TextRun({ break: 1 }));
        break;
      case "link": {
        const link = token as Tokens.Link;
        const target = externalLinkTarget(link.href);
        const children = inlineRuns(link.tokens, ctx, target ? { ...style, link: true } : style);
        if (target) {
          runs.push(new ExternalHyperlink({ link: target, children }));
        } else {
          runs.push(...children);
        }
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        const asset = ctx.images.get(image.href);
        if (asset) {
          runs.push(imageRun(asset, image.text));
        }
        break;
      }
      case "html":
        // Inline markup is not rendered; the words inside a tag pair still arrive
        // as their own text tokens.
        break;
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) {
          runs.push(...inlineRuns(token.tokens, ctx, style));
        } else if (typeof token.raw === "string" && token.type !== "space") {
          runs.push(textRun(token.raw, ctx, style));
        }
    }
  }
  return runs;
}

function headingBlocks(token: Tokens.Heading, ctx: DocxRenderContext, block: BlockStyle): FileChild[] {
  if (token.depth === 2) {
    const chapter = ctx.chapters[ctx.nextChapter];
    ctx.nextChapter += 1;
    const runs = inlineRuns(token.tokens, ctx);
    return [
      new Paragraph(
        paragraphOptions(ctx, block, {
          heading: HeadingLevel.HEADING_1,
          pageBreakBefore: true,
          children: chapter ? [new Bookmark({ id: chapter.anchor, children: runs })] : runs
        })
      )
    ];
  }
  const heading =
    token.depth === 1 ? HeadingLevel.HEADING_1 : token.depth === 3 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
  return [
    new Paragraph(
      paragraphOptions(ctx, block, {
        heading,
        ...(token.depth === 1 ? { pageBreakBefore: true } : {}),
        children: inlineRuns(token.tokens, ctx)
      })
    )
  ];
}

function paragraphBlocks(tokens: readonly Token[], ctx: DocxRenderContext, block: BlockStyle): FileChild[] {
  const soleImage = tokens.length === 1 && tokens[0]?.type === "image" ? (tokens[0] as Tokens.Image) : undefined;
  if (soleImage) {
    const asset = ctx.images.get(soleImage.href);
    return asset ? [imageParagraph(asset, soleImage.text, ctx)] : [];
  }
  const runs = inlineRuns(tokens, ctx);
  if (runs.length === 0) {
    return [];
  }
  return [new Paragraph(paragraphOptions(ctx, block, { children: runs }))];
}

function listBlocks(token: Tokens.List, ctx: DocxRenderContext, block: BlockStyle, level: number): FileChild[] {
  const reference = token.ordered ? ORDERED_NUMBERING : BULLET_NUMBERING;
  if (token.ordered && level === 0) {
    ctx.listInstance += 1;
  }
  const instance = ctx.listInstance;
  const blocks: FileChild[] = [];
  for (const item of token.items) {
    const inline: ParagraphChild[] = [];
    const nested: FileChild[] = [];
    if (item.task) {
      inline.push(textRun(item.checked ? "☑ " : "☐ ", ctx));
    }
    for (const child of item.tokens) {
      if (child.type === "list") {
        nested.push(...listBlocks(child as Tokens.List, ctx, block, Math.min(level + 1, 2)));
      } else if (child.type === "text" || child.type === "paragraph") {
        inline.push(...inlineRuns((child as Tokens.Text).tokens ?? [], ctx));
      } else {
        nested.push(...blocksFromToken(child, ctx, block));
      }
    }
    blocks.push(
      new Paragraph(
        paragraphOptions(ctx, block, {
          numbering: { reference, level, ...(token.ordered ? { instance } : {}) },
          children: inline
        })
      )
    );
    blocks.push(...nested);
  }
  return blocks;
}

function codeBlocks(token: Tokens.Code, ctx: DocxRenderContext): FileChild[] {
  const lines = token.text.replace(/\r\n?/g, "\n").split("\n");
  return lines.map(
    (line) =>
      new Paragraph({
        style: CODE_STYLE,
        alignment: AlignmentType.LEFT,
        children: [new TextRun({ text: line, font: ctx.fonts.mono, rightToLeft: false })]
      })
  );
}

function tableBlocks(token: Tokens.Table, ctx: DocxRenderContext): FileChild[] {
  const alignmentFor = (align: "center" | "left" | "right" | null) =>
    align === "center" ? AlignmentType.CENTER : align === "right" ? AlignmentType.RIGHT : align === "left" ? AlignmentType.LEFT : undefined;
  const cell = (source: Tokens.TableCell, header: boolean) => {
    const alignment = alignmentFor(source.align);
    return new TableCell({
      children: [
        new Paragraph(
          paragraphOptions(
            ctx,
            {},
            {
              ...(alignment ? { alignment } : {}),
              children: inlineRuns(source.tokens, ctx, header ? { bold: true } : {})
            }
          )
        )
      ]
    });
  };
  const rows = [
    new TableRow({ tableHeader: true, children: token.header.map((source) => cell(source, true)) }),
    ...token.rows.map((row) => new TableRow({ children: row.map((source) => cell(source, false)) }))
  ];
  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      ...(isRtl(ctx) ? { visuallyRightToLeft: true } : {}),
      rows
    }),
    // A table followed directly by a heading or another table is legal but
    // renders cramped; one empty paragraph is what Word itself inserts.
    new Paragraph({})
  ];
}

export function blocksFromToken(token: Token, ctx: DocxRenderContext, block: BlockStyle = {}): FileChild[] {
  switch (token.type) {
    case "heading":
      return headingBlocks(token as Tokens.Heading, ctx, block);
    case "paragraph":
      return paragraphBlocks((token as Tokens.Paragraph).tokens, ctx, block);
    case "text":
      return paragraphBlocks((token as Tokens.Text).tokens ?? [token], ctx, block);
    case "list":
      return listBlocks(token as Tokens.List, ctx, block, 0);
    case "blockquote":
      return blocksFromTokens((token as Tokens.Blockquote).tokens, ctx, { ...block, quote: true });
    case "code":
      return codeBlocks(token as Tokens.Code, ctx);
    case "table":
      return tableBlocks(token as Tokens.Table, ctx);
    case "hr":
      return [new Paragraph({ thematicBreak: true })];
    case "space":
    case "html":
    case "def":
      return [];
    default:
      return "tokens" in token && Array.isArray(token.tokens) ? paragraphBlocks(token.tokens, ctx, block) : [];
  }
}

export function blocksFromTokens(tokens: readonly Token[], ctx: DocxRenderContext, block: BlockStyle = {}): FileChild[] {
  const blocks: FileChild[] = [];
  for (const token of tokens) {
    blocks.push(...blocksFromToken(token, ctx, block));
  }
  return blocks;
}

/** A styled paragraph of plain text, for captions, bylines and stand-ins. */
export function styledParagraph(text: string, style: string, ctx: DocxRenderContext, extra: IParagraphOptions = {}): Paragraph {
  return new Paragraph(paragraphOptions(ctx, {}, { style, children: [textRun(text, ctx)], ...extra }));
}
