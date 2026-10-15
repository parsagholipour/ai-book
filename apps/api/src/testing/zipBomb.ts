import { constants, deflateRawSync } from "node:zlib";

/**
 * A .docx whose document.xml inflates to `mib` MiB of zeros behind headers
 * claiming 1,000 bytes: one sync-flushed MiB of deflate repeated, then an
 * empty final block. Core's `ingestion/testing/zipArchive.ts` writes the same,
 * outside this workspace's rootDir.
 */
export function wordBomb(mib: number): Buffer {
  const block = deflateRawSync(Buffer.alloc(1024 * 1024), { finishFlush: constants.Z_SYNC_FLUSH });
  const data = Buffer.concat([...Array.from({ length: mib }, () => block), Buffer.from([0x03, 0x00])]);
  const name = Buffer.from("word/document.xml");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(1000, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(1000, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
