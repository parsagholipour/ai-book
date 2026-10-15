import { constants, deflateRawSync } from "node:zlib";

/**
 * Test archives written byte by byte, so an entry's header can say anything.
 * JSZip would write honest sizes, and an honest bomb proves less: the
 * inflate limits in `documentText.ts` must hold against a header that lies.
 */
export type ZipEntry = {
  path: string;
  /** Stored as is. */
  text?: string;
  /** Already a raw deflate stream. */
  deflated?: Buffer;
  /**
   * What the headers claim the entry inflates to: the truth for `text`, and 1
   * for `deflated` by default. Not 0 — JSZip reads a claimed 0 as an empty file
   * without inflating it at all.
   */
  claimedSize?: number;
  /** The directory header's extra field bytes. */
  extra?: Buffer;
  /** Points the directory header at an earlier entry's local header, by index, instead of writing one of its own. */
  sharesLocalHeaderOf?: number;
  /** Defers the local header's offset to a ZIP64 extra field, after `extra`, as a writer must past 4 GiB. */
  zip64Offset?: boolean;
};

export type ZipArchiveOptions = {
  /** Writes the ZIP64 end record and locator, and leaves the classic end record only its sentinels. */
  zip64?: boolean;
  /** The archive comment, after the end record. */
  comment?: string;
  /** What the end records say the directory holds, in place of the truth. */
  declaredEntries?: number;
};

const MIB = 1024 * 1024;

/**
 * A raw deflate stream of `mib` MiB of zeros, a little over 1 KB per MiB: one
 * sync-flushed MiB repeated, then an empty final block. Each copy starts a
 * new block and refers back only to zeros, so the copies inflate end to end.
 */
export function zeroBomb(mib: number): Buffer {
  const block = deflateRawSync(Buffer.alloc(MIB), { finishFlush: constants.Z_SYNC_FLUSH });
  return Buffer.concat([...Array.from({ length: mib }, () => block), Buffer.from([0x03, 0x00])]);
}

export function zipArchive(entries: readonly ZipEntry[], options: ZipArchiveOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const localOffsets: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = entry.deflated ?? Buffer.from(entry.text ?? "", "utf8");
    const method = entry.deflated ? 8 : 0;
    const claimed = entry.claimedSize ?? (entry.deflated ? 1 : data.length);
    const shared = entry.sharesLocalHeaderOf;
    const localOffset = shared === undefined ? offset : localOffsets[shared]!;
    localOffsets.push(localOffset);
    const extra = Buffer.concat([entry.extra ?? Buffer.alloc(0), entry.zip64Offset ? zip64OffsetField(localOffset) : Buffer.alloc(0)]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(claimed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(entry.zip64Offset ? 0xffffffff : localOffset, 42);
    centrals.push(central, name, extra);
    if (shared !== undefined) continue;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(claimed, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = endRecords({
    entries: options.declaredEntries ?? entries.length,
    directoryBytes: directory.length,
    directoryOffset: offset,
    zip64: options.zip64 ?? false,
    comment: options.comment ?? ""
  });
  return Buffer.concat([...locals, directory, end]);
}

function zip64OffsetField(offset: number): Buffer {
  const field = Buffer.alloc(12);
  field.writeUInt16LE(0x0001, 0);
  field.writeUInt16LE(8, 2);
  field.writeBigUInt64LE(BigInt(offset), 4);
  return field;
}

/**
 * The end of central directory record, after the ZIP64 end record and its
 * locator when `zip64` is set — then every count, size and offset in the
 * classic record is its sentinel, and the ZIP64 record holds the values.
 */
export function endRecords(directory: {
  entries: number;
  directoryBytes: number;
  directoryOffset: number;
  zip64?: boolean;
  comment?: string;
}): Buffer {
  const comment = Buffer.from(directory.comment ?? "", "utf8");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(comment.length, 20);
  if (!directory.zip64) {
    end.writeUInt16LE(directory.entries, 8);
    end.writeUInt16LE(directory.entries, 10);
    end.writeUInt32LE(directory.directoryBytes, 12);
    end.writeUInt32LE(directory.directoryOffset, 16);
    return Buffer.concat([end, comment]);
  }
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(directory.entries), 24);
  record.writeBigUInt64LE(BigInt(directory.entries), 32);
  record.writeBigUInt64LE(BigInt(directory.directoryBytes), 40);
  record.writeBigUInt64LE(BigInt(directory.directoryOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(directory.directoryOffset + directory.directoryBytes), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([record, locator, end, comment]);
}

const EMPTY_ENTRY_NAME_BYTES = 8;

/**
 * `count` empty stored files, each with its own local header and name,
 * written in place into one buffer: the shape of the 17 MB .docx of 200,000
 * entries in the 2026-10-15 launch review. Past 65,534 entries the counts no
 * longer fit the classic end record, and the ZIP64 records are written.
 */
export function emptyEntries(count: number, options: { zip64?: boolean } = {}): Buffer {
  const localBytes = 30 + EMPTY_ENTRY_NAME_BYTES;
  const centralBytes = 46 + EMPTY_ENTRY_NAME_BYTES;
  const directoryOffset = count * localBytes;
  const directoryBytes = count * centralBytes;
  const end = endRecords({ entries: count, directoryBytes, directoryOffset, zip64: options.zip64 ?? count >= 0xffff });
  const data = Buffer.alloc(directoryOffset + directoryBytes + end.length);
  for (let index = 0; index < count; index += 1) {
    const name = String(index).padStart(EMPTY_ENTRY_NAME_BYTES, "0");
    const local = index * localBytes;
    data.writeUInt32LE(0x04034b50, local);
    data.writeUInt16LE(20, local + 4);
    data.writeUInt16LE(EMPTY_ENTRY_NAME_BYTES, local + 26);
    data.write(name, local + 30, "latin1");
    const central = directoryOffset + index * centralBytes;
    data.writeUInt32LE(0x02014b50, central);
    data.writeUInt16LE(20, central + 4);
    data.writeUInt16LE(20, central + 6);
    data.writeUInt16LE(EMPTY_ENTRY_NAME_BYTES, central + 28);
    data.writeUInt32LE(local, central + 42);
    data.write(name, central + 46, "latin1");
  }
  end.copy(data, directoryOffset + directoryBytes);
  return data;
}

/** A .docx whose `word/document.xml` inflates to `mib` MiB while its headers claim 1,000 bytes. */
export function wordBomb(mib: number): Buffer {
  return zipArchive([{ path: "word/document.xml", deflated: zeroBomb(mib), claimedSize: 1000 }]);
}
