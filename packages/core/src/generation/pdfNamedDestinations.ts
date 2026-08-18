/**
 * The dependency-free reader for a rendered PDF's named destinations.
 *
 * Skia (Chrome's PDF backend, m148 and m151 verified) writes a classic
 * cross-reference table, a flat `/Dests` dictionary of
 * `name → [pageRef /XYZ x y z]` entries and a nested page tree capped at 8 kids
 * per node; only content streams are compressed. That is little enough shape to
 * read with regexes over the latin1 bytes, and reading it here rather than
 * through a PDF library keeps the measurement pass off `packages/core`'s
 * dependency surface — the bytes it parses are the exact ones being published.
 *
 * Everything here is about the *file*. What those destinations mean for a book —
 * which model page each anchor belongs to, which sheets a page occupies — is
 * `pdfPageMap.ts`. Every structural surprise returns `undefined` rather than
 * throwing: a book without a translatable map falls back to the old model-index
 * chat behaviour, and no compile may fail over it.
 */

export type PdfNamedDestination = { pdfPage: number; y: number | undefined };

export type PdfNamedDestinations = {
  pageCount: number;
  destinations: Map<string, PdfNamedDestination>;
  /** Height of the first page's /MediaBox in points — the y axis destinations are measured on. */
  mediaBoxHeight?: number;
};

/**
 * Reads the named destinations and the page count out of a Skia PDF.
 *
 * Object offsets come from the cross-reference table rather than a whole-file
 * scan, so the byte pattern `N 0 obj` inside a compressed stream can never
 * fabricate an object. Anything off the expected shape — an xref stream, an
 * object-stream catalog, a missing trailer — returns `undefined`.
 */
export function extractPdfNamedDestinations(pdf: Buffer): PdfNamedDestinations | undefined {
  try {
    const text = pdf.toString("latin1");
    const objects = indexObjectsFromXref(text);
    if (!objects) {
      return undefined;
    }
    const trailer = trailerDictionary(text);
    if (!trailer) {
      return undefined;
    }
    const rootRef = referenceIn(trailer, "Root");
    const catalog = rootRef === undefined ? undefined : objects.get(rootRef);
    if (!catalog) {
      return undefined;
    }

    const pagesRootRef = referenceIn(catalog, "Pages");
    if (pagesRootRef === undefined) {
      return undefined;
    }
    const pageOrder: number[] = [];
    walkPageTree(objects, pagesRootRef, pageOrder, new Set(), 0);
    if (pageOrder.length === 0) {
      return undefined;
    }
    const rootBody = objects.get(pagesRootRef) ?? "";
    const countMatch = rootBody.match(/\/Count\s+(\d+)/);
    const declaredCount = countMatch ? Number.parseInt(countMatch[1] ?? "", 10) : undefined;
    if (declaredCount !== undefined && declaredCount !== pageOrder.length) {
      return undefined;
    }
    const pageNumberOf = new Map<number, number>();
    pageOrder.forEach((objectNumber, index) => pageNumberOf.set(objectNumber, index + 1));

    const destinations = new Map<string, PdfNamedDestination>();
    const destsBody = dictionaryIn(objects, catalog, "Dests");
    if (destsBody) {
      harvestDestinations(destsBody, pageNumberOf, destinations);
    } else {
      // Defensive branch: a future Skia could move to the /Names name tree.
      const names = dictionaryIn(objects, catalog, "Names");
      const namesDests = names ? dictionaryIn(objects, names, "Dests") : undefined;
      if (namesDests) {
        harvestNameTree(objects, namesDests, pageNumberOf, destinations, new Set(), 0);
      }
    }

    const mediaBoxHeight = mediaBoxHeightIn(objects, pageOrder, pagesRootRef);
    return {
      pageCount: pageOrder.length,
      destinations,
      ...(mediaBoxHeight !== undefined ? { mediaBoxHeight } : {})
    };
  } catch {
    return undefined;
  }
}

/** The /MediaBox height, read from the first leaf that carries one, else the tree root. */
function mediaBoxHeightIn(
  objects: Map<number, string>,
  pageOrder: number[],
  pagesRootRef: number
): number | undefined {
  for (const objectNumber of [...pageOrder, pagesRootRef]) {
    const body = objects.get(objectNumber) ?? "";
    const box = body.match(/\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/);
    if (box) {
      const height = Number.parseFloat(box[4] ?? "") - Number.parseFloat(box[2] ?? "");
      if (Number.isFinite(height) && height > 0) {
        return height;
      }
    }
  }
  return undefined;
}

/** Object bodies by number, located through the classic cross-reference table. */
function indexObjectsFromXref(text: string): Map<number, string> | undefined {
  const tail = text.slice(-256);
  const startxref = tail.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
  if (!startxref) {
    return undefined;
  }
  let xrefOffset = Number.parseInt(startxref[1] ?? "", 10);
  const offsets = new Map<number, number>();
  const seen = new Set<number>();

  // A Skia file has a single table, but an incrementally-updated PDF chains
  // /Prev sections; walk them, newest first, first offset wins.
  while (Number.isInteger(xrefOffset) && xrefOffset >= 0 && xrefOffset < text.length && !seen.has(xrefOffset)) {
    seen.add(xrefOffset);
    const section = text.slice(xrefOffset, xrefOffset + 8);
    if (!section.startsWith("xref")) {
      return undefined;
    }
    let cursor = xrefOffset + 4;
    for (;;) {
      const header = /^\s*(\d+)\s+(\d+)\s*/.exec(text.slice(cursor, cursor + 64));
      if (!header) {
        break;
      }
      const firstObject = Number.parseInt(header[1] ?? "", 10);
      const entryCount = Number.parseInt(header[2] ?? "", 10);
      cursor += header[0].length;
      for (let i = 0; i < entryCount; i += 1) {
        // Entries are fixed-width: 10-digit offset, 5-digit generation, f/n.
        const entry = text.slice(cursor, cursor + 20);
        const parsed = /^(\d{10})\s(\d{5})\s([nf])/.exec(entry);
        if (!parsed) {
          return undefined;
        }
        const objectNumber = firstObject + i;
        if (parsed[3] === "n" && !offsets.has(objectNumber)) {
          offsets.set(objectNumber, Number.parseInt(parsed[1] ?? "", 10));
        }
        cursor += 20;
      }
    }
    const trailerStart = text.indexOf("trailer", cursor);
    if (trailerStart < 0) {
      break;
    }
    const prev = /\/Prev\s+(\d+)/.exec(text.slice(trailerStart, trailerStart + 512));
    if (!prev) {
      break;
    }
    xrefOffset = Number.parseInt(prev[1] ?? "", 10);
  }

  if (offsets.size === 0) {
    return undefined;
  }
  const objects = new Map<number, string>();
  for (const [objectNumber, offset] of offsets) {
    const head = /^\s*(\d+)\s+\d+\s+obj\b/.exec(text.slice(offset, offset + 64));
    if (!head || Number.parseInt(head[1] ?? "", 10) !== objectNumber) {
      return undefined;
    }
    const bodyStart = offset + head[0].length;
    const bodyEnd = text.indexOf("endobj", bodyStart);
    if (bodyEnd < 0) {
      return undefined;
    }
    objects.set(objectNumber, text.slice(bodyStart, bodyEnd));
  }
  return objects;
}

function trailerDictionary(text: string): string | undefined {
  const trailerStart = text.lastIndexOf("trailer");
  if (trailerStart < 0) {
    return undefined;
  }
  return text.slice(trailerStart, trailerStart + 1024);
}

function referenceIn(body: string, key: string): number | undefined {
  const match = body.match(new RegExp(`\\/${key}\\s+(\\d+)\\s+\\d+\\s+R`));
  return match ? Number.parseInt(match[1] ?? "", 10) : undefined;
}

/** The dictionary a key holds, whether written inline or as an indirect reference. */
function dictionaryIn(objects: Map<number, string>, body: string, key: string): string | undefined {
  const reference = referenceIn(body, key);
  if (reference !== undefined) {
    return objects.get(reference);
  }
  const inline = body.match(new RegExp(`\\/${key}\\s*<<`));
  if (inline?.index === undefined) {
    return undefined;
  }
  let depth = 0;
  const start = body.indexOf("<<", inline.index);
  for (let i = start; i < body.length; ) {
    if (body.startsWith("<<", i)) {
      depth += 1;
      i += 2;
    } else if (body.startsWith(">>", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) {
        return body.slice(start, i);
      }
    } else {
      i += 1;
    }
  }
  return undefined;
}

function walkPageTree(
  objects: Map<number, string>,
  objectNumber: number,
  pageOrder: number[],
  visited: Set<number>,
  depth: number
): void {
  if (depth > 64 || visited.has(objectNumber)) {
    return;
  }
  visited.add(objectNumber);
  const body = objects.get(objectNumber);
  if (!body) {
    return;
  }
  if (/\/Type\s*\/Page\b/.test(body) && !/\/Type\s*\/Pages\b/.test(body)) {
    pageOrder.push(objectNumber);
    return;
  }
  const kids = body.match(/\/Kids\s*\[([^\]]*)\]/);
  if (!kids) {
    return;
  }
  const kidRe = /(\d+)\s+\d+\s+R/g;
  let kid: RegExpExecArray | null;
  while ((kid = kidRe.exec(kids[1] ?? "")) !== null) {
    walkPageTree(objects, Number.parseInt(kid[1] ?? "", 10), pageOrder, visited, depth + 1);
  }
}

/** `name → [P G R /XYZ x y z]` entries out of a flat destination dictionary. */
function harvestDestinations(
  dictionary: string,
  pageNumberOf: Map<number, number>,
  destinations: Map<string, PdfNamedDestination>
): void {
  const entryRe =
    /\/((?:[^\s/[\]<>()]|#[0-9a-fA-F]{2})+)\s*\[\s*(\d+)\s+\d+\s+R\s*\/(?:XYZ|Fit\w*)\s*([^\]]*)\]/g;
  let entry: RegExpExecArray | null;
  while ((entry = entryRe.exec(dictionary)) !== null) {
    const name = decodePdfName(entry[1] ?? "");
    const pdfPage = pageNumberOf.get(Number.parseInt(entry[2] ?? "", 10));
    if (pdfPage === undefined) {
      continue;
    }
    const coordinates = (entry[3] ?? "").trim().split(/\s+/);
    const y = Number.parseFloat(coordinates[1] ?? "");
    destinations.set(name, { pdfPage, y: Number.isFinite(y) ? y : undefined });
  }
}

/** The /Names-tree shape of the same data, flattened. Skia does not write it today. */
function harvestNameTree(
  objects: Map<number, string>,
  node: string,
  pageNumberOf: Map<number, number>,
  destinations: Map<string, PdfNamedDestination>,
  visited: Set<string>,
  depth: number
): void {
  if (depth > 64 || visited.has(node)) {
    return;
  }
  visited.add(node);
  const names = node.match(/\/Names\s*\[([\s\S]*?)\]/);
  if (names) {
    const pairRe = /\(((?:[^()\\]|\\.)*)\)\s*\[\s*(\d+)\s+\d+\s+R\s*\/(?:XYZ|Fit\w*)\s*([^\]]*)\]/g;
    let pair: RegExpExecArray | null;
    while ((pair = pairRe.exec(names[1] ?? "")) !== null) {
      const pdfPage = pageNumberOf.get(Number.parseInt(pair[2] ?? "", 10));
      if (pdfPage === undefined) {
        continue;
      }
      const coordinates = (pair[3] ?? "").trim().split(/\s+/);
      const y = Number.parseFloat(coordinates[1] ?? "");
      destinations.set(decodePdfString(pair[1] ?? ""), { pdfPage, y: Number.isFinite(y) ? y : undefined });
    }
  }
  const kids = node.match(/\/Kids\s*\[([^\]]*)\]/);
  if (kids) {
    const kidRe = /(\d+)\s+\d+\s+R/g;
    let kid: RegExpExecArray | null;
    while ((kid = kidRe.exec(kids[1] ?? "")) !== null) {
      const child = objects.get(Number.parseInt(kid[1] ?? "", 10));
      if (child) {
        harvestNameTree(objects, child, pageNumberOf, destinations, visited, depth + 1);
      }
    }
  }
}

/** `#xx` escapes in a PDF name. Our own anchor ids are ASCII and pass through. */
function decodePdfName(name: string): string {
  return name.replace(/#([0-9a-fA-F]{2})/g, (_full, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

function decodePdfString(value: string): string {
  return value.replace(/\\([nrtbf()\\])/g, (_full, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escaped;
    }
  });
}
