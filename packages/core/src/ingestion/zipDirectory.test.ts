import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { DOCUMENT_ARCHIVE_DIRECTORY_MAX_BYTES, DOCUMENT_ARCHIVE_MAX_ENTRIES, DOCUMENT_ARCHIVE_MAX_EXTRA_FIELDS } from "./documentText.js";
import { inspectZipDirectory, type ZipDirectoryLimits, type ZipDirectoryVerdict } from "./zipDirectory.js";
import { LINEAR_TIME_CEILING_MS } from "./testing/linearTime.js";
import { emptyEntries, endRecords, zipArchive, type ZipEntry } from "./testing/zipArchive.js";

const LIMITS: ZipDirectoryLimits = {
  maxEntries: DOCUMENT_ARCHIVE_MAX_ENTRIES,
  maxDirectoryBytes: DOCUMENT_ARCHIVE_DIRECTORY_MAX_BYTES,
  maxExtraFields: DOCUMENT_ARCHIVE_MAX_EXTRA_FIELDS
};
const UNLIMITED: ZipDirectoryLimits = { maxEntries: 1e9, maxDirectoryBytes: 1e12, maxExtraFields: 1e9 };

function timed(data: Buffer, limits = LIMITS): { verdict: ZipDirectoryVerdict; ms: number } {
  const started = performance.now();
  const verdict = inspectZipDirectory(data, limits);
  return { verdict, ms: performance.now() - started };
}

function reason(verdict: ZipDirectoryVerdict): string {
  return verdict.readable ? "readable" : verdict.reason;
}

async function jszipArchive(files: Record<string, string>, comment?: string): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, text] of Object.entries(files)) zip.file(path, text);
  zip.folder("images");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", ...(comment ? { comment } : {}) });
}

const SMALL: ZipEntry[] = [
  { path: "mimetype", text: "application/epub+zip" },
  { path: "META-INF/container.xml", text: "<container/>" },
  { path: "OEBPS/chapter.xhtml", text: "<p>Snow fell.</p>" }
];

/** Extra fields of empty data, each with an id of its own (none of them ZIP64's), filling one entry's 64 KB. */
function emptyExtraFields(count: number): Buffer {
  const extra = Buffer.alloc(count * 4);
  for (let index = 0; index < count; index += 1) extra.writeUInt16LE(index + 2, index * 4);
  return extra;
}

describe("zip directory inspection", () => {
  it("counts exactly the entries JSZip reads, whoever wrote the archive", async () => {
    const archives: Array<[string, Buffer]> = [
      ["JSZip", await jszipArchive({ "word/document.xml": "<w:p/>", "docProps/core.xml": "<core/>" })],
      ["JSZip with a comment", await jszipArchive({ "chapter.xhtml": "<p/>" }, "Exported by a tool that signs its archives.")],
      ["hand-written", zipArchive(SMALL)],
      ["ZIP64", zipArchive(SMALL, { zip64: true })],
      ["ZIP64 with a comment", zipArchive(SMALL, { zip64: true, comment: "a comment" })],
      ["ZIP64 local header offsets", zipArchive(SMALL.map((entry) => ({ ...entry, zip64Offset: true })), { zip64: true })],
      ["many entries", emptyEntries(50)],
      ["many entries, ZIP64", emptyEntries(50, { zip64: true })],
      // JSZip reads past the bytes a self-extractor puts before the archive.
      ["prepended bytes", Buffer.concat([Buffer.alloc(100, 0x4d), zipArchive(SMALL)])],
      // JSZip walks the headers, not the count: it reads all three.
      ["a directory declaring one entry", zipArchive(SMALL, { declaredEntries: 1 })]
    ];
    for (const [label, data] of archives) {
      const zip = await JSZip.loadAsync(data);
      expect(inspectZipDirectory(data, LIMITS), label).toEqual({ readable: true, entries: Object.keys(zip.files).length });
    }
  });

  it("refuses a directory declaring more entries than any book has, before reading it", () => {
    // The launch review's 17 MB .docx held 200,000 empty entries: JSZip took
    // 0.8–3.7 s and 325 MB to read it, and three at once ran 512 MB out.
    const classic = emptyEntries(60_000);
    const zip64 = emptyEntries(200_000);
    for (const [data, declared] of [[classic, 60_000], [zip64, 200_000]] as const) {
      const { verdict, ms } = timed(data);
      expect(verdict).toEqual({ readable: false, reason: "too_large", detail: `the directory declares ${declared} entries` });
      expect(ms).toBeLessThan(LINEAR_TIME_CEILING_MS);
    }
    // And the archive is honest: walked without limits, it holds what it declares.
    expect(inspectZipDirectory(zip64, UNLIMITED)).toEqual({ readable: true, entries: 200_000 });
  });

  it("counts the headers a directory holds, not the ones it declares", () => {
    const entries = Array.from({ length: DOCUMENT_ARCHIVE_MAX_ENTRIES + 1 }, (_, index) => ({ path: `p${index}`, text: "" }));
    const verdict = inspectZipDirectory(zipArchive(entries, { declaredEntries: 1 }), LIMITS);
    expect(verdict).toEqual({ readable: false, reason: "too_large", detail: `the directory holds more than ${DOCUMENT_ARCHIVE_MAX_ENTRIES} entries` });
  });

  it("refuses entries that share one local header's long name", () => {
    // JSZip decodes every entry's name from its local header: as many entries
    // as the cap allows, sharing one 64 KB name, decoded 655 MB from a 0.5 MB
    // file — 3 s, then out of a 512 MB heap.
    const entries: ZipEntry[] = [
      { path: "n".repeat(0xffff), text: "" },
      ...Array.from({ length: DOCUMENT_ARCHIVE_MAX_ENTRIES - 1 }, () => ({ path: "x", sharesLocalHeaderOf: 0 }))
    ];
    const data = zipArchive(entries);
    expect(data.length).toBeLessThan(1024 * 1024);
    const { verdict, ms } = timed(data);
    expect(verdict).toEqual({ readable: false, reason: "too_large", detail: "the entries' local file names come to more than the file holds" });
    expect(ms).toBeLessThan(LINEAR_TIME_CEILING_MS);
    // A few entries sharing a header is no more than the file's own bytes, and is JSZip's to judge.
    expect(reason(inspectZipDirectory(zipArchive(entries.slice(0, 2)), LIMITS))).toBe("readable");
  });

  it("refuses a directory of more extra fields than any book's", () => {
    // JSZip keeps each extra field as an object and a Buffer view: 260
    // entries of 16,383 empty fields took 700 MB of heap from 17 MB.
    const flood = emptyExtraFields(16_383);
    const entries = Array.from({ length: Math.ceil(DOCUMENT_ARCHIVE_MAX_EXTRA_FIELDS / 16_383) }, (_, index) => ({ path: `p${index}`, text: "", extra: flood }));
    const { verdict, ms } = timed(zipArchive(entries));
    expect(verdict).toEqual({ readable: false, reason: "too_large", detail: `the directory holds more than ${DOCUMENT_ARCHIVE_MAX_EXTRA_FIELDS} extra fields` });
    expect(ms).toBeLessThan(LINEAR_TIME_CEILING_MS);
    // The most files a book may have, each with four fields of a real writer's size.
    const timesAndIds = Buffer.concat(Array.from({ length: 4 }, (_, index) => Buffer.concat([Buffer.from([index + 2, 0x75, 9, 0]), Buffer.alloc(9)])));
    const real = Array.from({ length: DOCUMENT_ARCHIVE_MAX_ENTRIES }, (_, index) => ({ path: `OEBPS/page${index}.xhtml`, text: "", extra: timesAndIds }));
    expect(inspectZipDirectory(zipArchive(real), LIMITS)).toEqual({ readable: true, entries: DOCUMENT_ARCHIVE_MAX_ENTRIES });
  });

  it("refuses a directory declared larger than any book's", () => {
    const end = endRecords({ entries: 1, directoryBytes: DOCUMENT_ARCHIVE_DIRECTORY_MAX_BYTES + 1, directoryOffset: 0 });
    expect(inspectZipDirectory(end, LIMITS)).toMatchObject({ readable: false, reason: "too_large" });
    const end64 = endRecords({ entries: 1, directoryBytes: 0, directoryOffset: 0, zip64: true });
    end64.writeBigUInt64LE(2n ** 40n, 40);
    expect(inspectZipDirectory(end64, LIMITS)).toEqual({ readable: false, reason: "too_large", detail: `the directory declares ${2 ** 40} bytes` });
  });

  it("calls a cut, garbled or foreign file malformed, and never throws reading one", async () => {
    for (const data of [Buffer.alloc(0), Buffer.from("PK"), Buffer.from("Chapter One\n\nSnow fell.")]) {
      expect(reason(inspectZipDirectory(data, LIMITS))).toBe("malformed");
    }
    const archives = [zipArchive(SMALL), zipArchive(SMALL.map((entry) => ({ ...entry, zip64Offset: true })), { zip64: true, comment: "kept" })];
    archives.push(await jszipArchive({ "chapter.xhtml": "<p>Snow</p>" }, "comment"));
    for (const archive of archives) {
      for (let length = 0; length < archive.length; length += 1) {
        expect(reason(inspectZipDirectory(archive.subarray(0, length), LIMITS)), `cut at ${length}`).toBe("malformed");
      }
      for (let at = 0; at < archive.length; at += 1) {
        for (const byte of [0x00, 0xff]) {
          const garbled = Buffer.from(archive);
          garbled[at] = byte;
          expect(() => inspectZipDirectory(garbled, LIMITS), `byte ${at} set to ${byte}`).not.toThrow();
        }
      }
    }
  });

  it("refuses offsets and records that point outside the archive", () => {
    const plain = zipArchive(SMALL);
    const end = plain.length - 22;
    const pastEnd = Buffer.from(plain);
    pastEnd.writeUInt32LE(0x7ffffff0, end + 16);
    expect(inspectZipDirectory(pastEnd, LIMITS)).toEqual({ readable: false, reason: "malformed", detail: "the central directory runs past the end record" });

    const zip64 = zipArchive(SMALL, { zip64: true });
    const locator = zip64.length - 22 - 20;
    const misplaced = Buffer.from(zip64);
    misplaced.writeBigUInt64LE(5n, locator + 8);
    expect(inspectZipDirectory(misplaced, LIMITS)).toMatchObject({ readable: false, reason: "malformed" });
    const extensible = Buffer.from(zip64);
    extensible.writeBigUInt64LE(45n, locator - 56 + 4);
    expect(inspectZipDirectory(extensible, LIMITS)).toMatchObject({ readable: false, reason: "malformed" });
  });

  it("looks for the end record only where a comment can reach", async () => {
    // JSZip would open this; no writer puts 64 KB of anything after an archive's comment.
    const trailing = Buffer.concat([zipArchive(SMALL), Buffer.alloc(0x10000)]);
    expect(Object.keys((await JSZip.loadAsync(trailing)).files)).toHaveLength(SMALL.length);
    expect(inspectZipDirectory(trailing, LIMITS)).toEqual({ readable: false, reason: "malformed", detail: "no end of central directory record in the last 64 KiB" });
    // The longest comment there is still reaches it.
    expect(inspectZipDirectory(zipArchive(SMALL, { comment: "c".repeat(0xffff) }), LIMITS)).toEqual({ readable: true, entries: SMALL.length });
  });
});
