import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FontsourcePackage } from "./bookFonts.js";

const require = createRequire(import.meta.url);

const FONT_FACE_RE = /@font-face\s*\{([^}]*)\}/g;
const SRC_URL_RE = /url\(\s*(['"]?)\.\/files\/([^'")]+)\1\s*\)/i;
const UNICODE_RANGE_RE = /unicode-range\s*:\s*([^;]+);/i;
const RANGE_TOKEN_RE = /U\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?/gi;

/** Metadata for one `@font-face` block; the woff2 bytes are loaded separately. */
type ParsedFace = {
  readonly declarations: string;
  readonly filePath: string;
  readonly ranges: readonly CodePointRange[];
  /** The raw `unicode-range` value, kept verbatim in the output. */
  readonly rangeText: string;
};

type CodePointRange = { readonly start: number; readonly end: number };

export type EmbeddedFontRequest = {
  /** The family name the stylesheets refer to, e.g. "SourceSerifBook". */
  readonly family: string;
  readonly packages: readonly FontsourcePackage[];
  /** Only faces covering at least one of these are embedded. */
  readonly codePoints: ReadonlySet<number>;
};

// Printable ASCII is always in play — page numbers, the footer's "Page N",
// URLs — so a book that happens to contain none of it must still carry a Latin
// face rather than being left with nothing to render them with.
const ASCII_SEED: readonly number[] = Array.from({ length: 0x7e - 0x20 + 1 }, (_, index) => 0x20 + index);

export function codePointsOf(...text: readonly string[]): Set<number> {
  const points = new Set<number>(ASCII_SEED);
  for (const value of text) {
    for (const character of value) {
      points.add(character.codePointAt(0) as number);
    }
  }
  return points;
}

/**
 * The `@font-face` rules for a set of families, with every woff2 inlined as a
 * data URI and every face the document does not need dropped.
 *
 * Dropping by code point is what makes a CJK book possible at all: Noto Serif
 * SC ships 101 subsets, roughly 11 MB once base64-encoded, and a real book
 * touches a third of them. It also makes an English book smaller than the
 * hand-written three faces this replaced.
 */
export async function embedFontFaceCss(requests: readonly EmbeddedFontRequest[]): Promise<string> {
  const blocks = await Promise.all(
    requests.map(async (request) => {
      const rendered = await Promise.all(
        request.packages.map((pkg) => renderPackage(request.family, pkg, request.codePoints))
      );
      return rendered.flat();
    })
  );
  return blocks.flat().join("\n");
}

async function renderPackage(
  family: string,
  pkg: FontsourcePackage,
  codePoints: ReadonlySet<number>
): Promise<string[]> {
  const limit = pkg.limitTo ? parseUnicodeRange(pkg.limitTo) : undefined;
  const faces: string[] = [];

  for (const cssFile of pkg.css) {
    for (const face of await parseFontsourceCss(pkg.package, cssFile)) {
      if (limit && !rangesIntersect(face.ranges, limit)) {
        continue;
      }
      if (!coversAnyCodePoint(face.ranges, codePoints)) {
        continue;
      }
      faces.push(await renderFace(family, face));
    }
  }

  return faces;
}

async function renderFace(family: string, face: ParsedFace): Promise<string> {
  const base64 = await fontFileBase64(face.filePath);
  return `@font-face {
  font-family: "${family}";
${face.declarations}
  src: url("data:font/woff2;base64,${base64}") format("woff2-variations");
  unicode-range: ${face.rangeText};
  font-display: block;
}`;
}

const facesByCssFile = new Map<string, Promise<readonly ParsedFace[]>>();
const base64ByFile = new Map<string, Promise<string>>();

/**
 * Face metadata is cached per CSS file and the encoded bytes per woff2 file.
 * The assembled stylesheet deliberately is not: it is a function of the font
 * set *and* the book's code points, so caching it would grow without bound in
 * a worker that renders more than one language.
 */
function parseFontsourceCss(pkg: string, cssFile: string): Promise<readonly ParsedFace[]> {
  const key = `${pkg}/${cssFile}`;
  const cached = facesByCssFile.get(key);
  if (cached) {
    return cached;
  }
  const parsed = readFontsourceCss(pkg, cssFile);
  facesByCssFile.set(key, parsed);
  return parsed;
}

async function readFontsourceCss(pkg: string, cssFile: string): Promise<readonly ParsedFace[]> {
  const cssPath = require.resolve(`${pkg}/${cssFile}`);
  const filesDir = join(dirname(cssPath), "files");
  const css = await readFile(cssPath, "utf8");
  const faces: ParsedFace[] = [];

  for (const match of css.matchAll(FONT_FACE_RE)) {
    const body = match[1] ?? "";
    const file = body.match(SRC_URL_RE)?.[2];
    const rangeText = body.match(UNICODE_RANGE_RE)?.[1]?.trim();
    // A face with no range would claim all of Unicode and stop every later
    // fallback, which is the failure this module exists to prevent.
    if (!file || !rangeText) {
      continue;
    }
    faces.push({
      declarations: keptDeclarations(body),
      filePath: join(filesDir, file),
      ranges: parseUnicodeRange(rangeText),
      rangeText
    });
  }

  return faces;
}

/** Weight and style survive; family, src, range and display are rewritten. */
function keptDeclarations(body: string): string {
  return body
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => /^font-(style|weight|stretch)\s*:/i.test(declaration))
    .map((declaration) => `  ${declaration};`)
    .join("\n");
}

function fontFileBase64(filePath: string): Promise<string> {
  const cached = base64ByFile.get(filePath);
  if (cached) {
    return cached;
  }
  const encoded = readFile(filePath).then((bytes) => bytes.toString("base64"));
  base64ByFile.set(filePath, encoded);
  return encoded;
}

/**
 * Parses a `unicode-range` value. Hex is matched case-insensitively on purpose:
 * the Latin packages write `U+0100-02BA` and the CJK packages `U+1f1e9-1f1f5`.
 */
export function parseUnicodeRange(value: string): CodePointRange[] {
  const ranges: CodePointRange[] = [];
  for (const match of value.matchAll(RANGE_TOKEN_RE)) {
    const start = match[1] ?? "";
    const end = match[2];
    if (start.includes("?")) {
      ranges.push({
        start: Number.parseInt(start.replace(/\?/g, "0"), 16),
        end: Number.parseInt(start.replace(/\?/g, "f"), 16)
      });
      continue;
    }
    const from = Number.parseInt(start, 16);
    ranges.push({ start: from, end: end ? Number.parseInt(end, 16) : from });
  }
  return ranges;
}

function coversAnyCodePoint(ranges: readonly CodePointRange[], codePoints: ReadonlySet<number>): boolean {
  for (const point of codePoints) {
    for (const range of ranges) {
      if (point >= range.start && point <= range.end) {
        return true;
      }
    }
  }
  return false;
}

function rangesIntersect(ranges: readonly CodePointRange[], limit: readonly CodePointRange[]): boolean {
  return ranges.some((range) => limit.some((other) => range.start <= other.end && other.start <= range.end));
}
