/**
 * An uploaded zip's central directory, measured before JSZip reads any of it.
 *
 * `JSZip.loadAsync` builds an object for every directory entry before a
 * caller can count them: a 17 MB .docx of 200,000 empty entries held the
 * API's thread for 0.8–3.7 s and took 325 MB of heap, and three at once ran
 * the 512 MB production heap out (launch review C3, 2026-10-15). And JSZip
 * believes no declared count, so refusing on the end record's alone is not
 * enough:
 *  - it walks headers until a signature is not a directory header's, so a
 *    directory that declares one entry can hold ten thousand;
 *  - it decodes each entry's name from the local header the entry points at,
 *    so 10,000 entries sharing one header with a 64 KB name made a 0.5 MB file
 *    decode 655 MB of names (3 s, then out of heap);
 *  - it keeps every extra field as its own object and Buffer view, so 260
 *    entries of 64 KB of empty extra fields took 700 MB from 17 MB.
 *
 * `inspectZipDirectory` reads the bytes JSZip 3.10.1 will — the end record it
 * finds, the ZIP64 records it follows, the headers it walks, the local names
 * it decodes — and counts each of those instead of reading the count off a
 * header. It allocates nothing per entry and stops at the first limit, so its
 * cost is bounded by the limits, not the file. Where it cannot tell what
 * JSZip would do, it calls the archive malformed rather than guess.
 */

export type ZipDirectoryLimits = {
  /** Entries the directory may declare, and may hold when walked. */
  maxEntries: number;
  /** Bytes the end record may declare for the directory. */
  maxDirectoryBytes: number;
  /** Extra fields across every entry, as JSZip splits them. */
  maxExtraFields: number;
};

export type ZipDirectoryVerdict =
  | { readable: true; entries: number }
  | { readable: false; reason: "too_large" | "malformed"; detail: string };

const END_SIGNATURE = signature(0x06054b50);
const ZIP64_LOCATOR_SIGNATURE = signature(0x07064b50);
const ZIP64_END = 0x06064b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

const END_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_END_BYTES = 56;
/**
 * The ZIP64 end record's own size field, version 1. JSZip cannot read the
 * extensible data a larger record carries: its loop over it never advances
 * its counter, and runs on to the end of the file before it throws.
 */
const ZIP64_END_SIZE = 44;
/** What JSZip expects between the directory's end and the end record: the ZIP64 record (its size field counts all but its first 12 bytes) and the locator. */
const ZIP64_TRAILER_BYTES = 12 + ZIP64_END_SIZE + ZIP64_LOCATOR_BYTES;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const ZIP64_EXTRA_FIELD = 0x0001;
/** The sentinels that send a reader to the ZIP64 records. */
const DEFERRED_16 = 0xffff;
const DEFERRED_32 = 0xffffffff;
/**
 * JSZip reads every 4- and 8-byte field as a signed 32-bit integer. In a file
 * no longer than this, every position accepted below is one it reads the same.
 */
const MAX_ARCHIVE_BYTES = 0x7fffffff;

export function inspectZipDirectory(data: Buffer, limits: ZipDirectoryLimits): ZipDirectoryVerdict {
  if (data.length > MAX_ARCHIVE_BYTES) return tooLarge("the file is over 2 GiB");
  const end = readEndRecords(data);
  if (typeof end === "string") return malformed(end);
  const declared = Math.max(end.entries, end.entriesOnDisk);
  if (declared > limits.maxEntries) return tooLarge(`the directory declares ${declared} entries`);
  if (end.directoryBytes > limits.maxDirectoryBytes) return tooLarge(`the directory declares ${end.directoryBytes} bytes`);
  const directoryEnd = end.directoryOffset + end.directoryBytes + end.trailerBytes;
  if (directoryEnd > end.at) return malformed("the central directory runs past the end record");
  // JSZip reads a directory that ends short of the end record as one behind
  // prepended bytes (a self-extractor's), and moves every offset by them.
  const shift = end.at - directoryEnd;
  return walkDirectory(data, shift + end.directoryOffset, shift, limits);
}

type EndRecords = {
  /** Where the end of central directory record starts. */
  at: number;
  entries: number;
  entriesOnDisk: number;
  directoryBytes: number;
  directoryOffset: number;
  /** Bytes between the directory and the end record. */
  trailerBytes: number;
};

/** The end record and, when it defers to them, the ZIP64 records: the counts, or why they cannot be read. */
function readEndRecords(data: Buffer): EndRecords | string {
  // A comment is at most 64 KiB, so a real end record starts in the last
  // 64 KiB + 22 bytes, and the last signature there is the one JSZip finds.
  // JSZip searches the whole file, which only matters to one with junk after it.
  const tail = Math.max(0, data.length - END_BYTES - MAX_COMMENT_BYTES);
  const at = lastIndexFrom(data, END_SIGNATURE, tail);
  if (at === -1) return "no end of central directory record in the last 64 KiB";
  if (at + END_BYTES > data.length || at + END_BYTES + data.readUInt16LE(at + 20) > data.length) {
    return "the end of central directory record runs past the end of the file";
  }
  const disk = data.readUInt16LE(at + 4);
  const directoryDisk = data.readUInt16LE(at + 6);
  const entriesOnDisk = data.readUInt16LE(at + 8);
  const entries = data.readUInt16LE(at + 10);
  const directoryBytes = data.readUInt32LE(at + 12);
  const directoryOffset = data.readUInt32LE(at + 16);
  const zip64 =
    [disk, directoryDisk, entriesOnDisk, entries].includes(DEFERRED_16) || directoryBytes === DEFERRED_32 || directoryOffset === DEFERRED_32;
  if (!zip64) return { at, entries, entriesOnDisk, directoryBytes, directoryOffset, trailerBytes: 0 };

  // JSZip follows the last locator in the file to the record it names. Where
  // no record is there it searches the file for one; a real locator is right.
  const locator = lastIndexFrom(data, ZIP64_LOCATOR_SIGNATURE, Math.max(0, tail - ZIP64_LOCATOR_BYTES));
  if (locator === -1 || locator + ZIP64_LOCATOR_BYTES > data.length) return "the end record defers to a ZIP64 locator that is not there";
  const record = readUInt64(data, locator + 8);
  if (record + ZIP64_END_BYTES > data.length || data.readUInt32LE(record) !== ZIP64_END) {
    return "the ZIP64 locator does not point at a ZIP64 end record";
  }
  if (readUInt64(data, record + 4) !== ZIP64_END_SIZE) return "the ZIP64 end record is not the version-1 record JSZip reads";
  return {
    at,
    entriesOnDisk: readUInt64(data, record + 24),
    entries: readUInt64(data, record + 32),
    directoryBytes: readUInt64(data, record + 40),
    directoryOffset: readUInt64(data, record + 48),
    trailerBytes: ZIP64_TRAILER_BYTES
  };
}

/**
 * JSZip's own walk: header after header from the directory's start for as
 * long as the signature is a directory header's, whatever the end record
 * declared, then each entry's local header for its name. Counted, never kept.
 */
function walkDirectory(data: Buffer, start: number, shift: number, limits: ZipDirectoryLimits): ZipDirectoryVerdict {
  let at = start;
  let entries = 0;
  let extraFields = 0;
  let localNameBytes = 0;
  for (;;) {
    if (at + 4 > data.length) return malformed("the central directory runs off the end of the file");
    if (data.readUInt32LE(at) !== CENTRAL_HEADER) return { readable: true, entries };
    entries += 1;
    if (entries > limits.maxEntries) return tooLarge(`the directory holds more than ${limits.maxEntries} entries`);
    if (at + CENTRAL_HEADER_BYTES > data.length) return malformed("a directory header runs off the end of the file");
    const extraStart = at + CENTRAL_HEADER_BYTES + data.readUInt16LE(at + 28);
    const extraEnd = extraStart + data.readUInt16LE(at + 30);
    const next = extraEnd + data.readUInt16LE(at + 32);
    if (next > data.length) return malformed("a directory entry runs off the end of the file");

    // JSZip's split of the extra bytes: a field's data may run past the
    // entry's extra bytes, and the last ZIP64 field is the one it reads.
    let zip64Field = -1;
    let zip64FieldEnd = -1;
    for (let field = extraStart; field + 4 < extraEnd; ) {
      extraFields += 1;
      if (extraFields > limits.maxExtraFields) return tooLarge(`the directory holds more than ${limits.maxExtraFields} extra fields`);
      const fieldEnd = field + 4 + data.readUInt16LE(field + 2);
      if (fieldEnd > data.length) return malformed("an extra field runs off the end of the file");
      if (data.readUInt16LE(field) === ZIP64_EXTRA_FIELD) {
        zip64Field = field + 4;
        zip64FieldEnd = fieldEnd;
      }
      field = fieldEnd;
    }

    let localOffset = data.readUInt32LE(at + 42);
    if (localOffset === DEFERRED_32) {
      // In the ZIP64 field, after whichever of the two sizes the header deferred there too.
      let value = zip64Field;
      if (data.readUInt32LE(at + 24) === DEFERRED_32) value += 8;
      if (data.readUInt32LE(at + 20) === DEFERRED_32) value += 8;
      if (zip64Field === -1 || value + 8 > zip64FieldEnd) return malformed("an entry defers its local header offset to a ZIP64 field that lacks it");
      localOffset = readUInt64(data, value);
    }
    const local = shift + localOffset;
    if (local + LOCAL_HEADER_BYTES > data.length || data.readUInt32LE(local) !== LOCAL_HEADER) {
      return malformed("an entry points at no local header");
    }
    // Entries with a local header each name no more bytes than the file holds.
    localNameBytes += data.readUInt16LE(local + 26);
    if (localNameBytes > data.length) return tooLarge("the entries' local file names come to more than the file holds");
    at = next;
  }
}

function signature(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
}

/** The last place `needle` starts at or after `from`, searching only from there to the end. */
function lastIndexFrom(data: Buffer, needle: Buffer, from: number): number {
  const index = data.subarray(from).lastIndexOf(needle);
  return index === -1 ? -1 : from + index;
}

/** Exact below 2^53, and far past any position in a file under 2 GiB above it. */
function readUInt64(data: Buffer, at: number): number {
  return data.readUInt32LE(at + 4) * 2 ** 32 + data.readUInt32LE(at);
}

function tooLarge(detail: string): ZipDirectoryVerdict {
  return { readable: false, reason: "too_large", detail };
}

function malformed(detail: string): ZipDirectoryVerdict {
  return { readable: false, reason: "malformed", detail };
}
