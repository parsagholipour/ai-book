import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  exportContentDigest,
  exportProvenanceFor,
  exportProvenancePath,
  parseExportProvenanceRecord,
  readExportArtifact,
  readPublishedExport,
  writeExportProvenance,
  type ExportProvenanceRecord
} from "./exportProvenance.js";

/**
 * The whole point of this module is the case a size comparison cannot see, so
 * every fixture here is deliberately the same length as the one it replaces.
 */
const REVISION_ONE = Buffer.from("%PDF-one-edition");
const REVISION_TWO = Buffer.from("%PDF-two-edition");

function recordFor(bytes: Buffer, revision: number): ExportProvenanceRecord {
  return {
    revision,
    digest: exportContentDigest(bytes),
    byteSize: bytes.length,
    publishedAt: "2026-08-11T00:00:00.000Z"
  };
}

describe("exportProvenanceFor", () => {
  it("names the revision whose record describes these exact bytes", () => {
    expect(exportProvenanceFor(exportContentDigest(REVISION_TWO), [recordFor(REVISION_TWO, 8)])).toEqual({
      state: "exact",
      revision: 8,
      digest: exportContentDigest(REVISION_TWO)
    });
  });

  it("accepts a match from either read, because a digest identifies one file", () => {
    // The record read *before* the bytes is as good a witness as the one read
    // after: it named these bytes, and bytes do not change identity.
    const provenance = exportProvenanceFor(exportContentDigest(REVISION_ONE), [
      recordFor(REVISION_TWO, 9),
      recordFor(REVISION_ONE, 8)
    ]);

    expect(provenance).toMatchObject({ state: "exact", revision: 8 });
  });

  it("refuses to guess when a record describes different bytes of the same length", () => {
    expect(REVISION_TWO.length).toBe(REVISION_ONE.length);

    expect(exportProvenanceFor(exportContentDigest(REVISION_ONE), [recordFor(REVISION_TWO, 9)])).toMatchObject({
      state: "mismatch"
    });
  });

  it("reports no record as unknown rather than as a contradiction", () => {
    expect(exportProvenanceFor(exportContentDigest(REVISION_ONE), [null, null])).toMatchObject({ state: "unknown" });
  });
});

describe("readExportArtifact", () => {
  it("catches a publication that lands mid-read with the record it reads after", async () => {
    // The mid-flight race, driven exactly: the record is read while the book
    // being replaced is still the current one, the bytes that arrive are the
    // compile replacing it — the same length, so nothing but a digest can tell
    // them apart — and the read taken afterwards is what names them.
    let published = false;
    const reads: string[] = [];

    const artifact = await readExportArtifact({
      readBytes: async () => {
        reads.push("bytes");
        published = true;
        return REVISION_TWO;
      },
      readRecord: async () => {
        reads.push("record");
        return published ? recordFor(REVISION_TWO, 9) : recordFor(REVISION_ONE, 8);
      }
    });

    expect(artifact?.provenance).toMatchObject({ state: "exact", revision: 9 });
    expect(reads, "one attempt was enough").toEqual(["record", "bytes", "record"]);
  });

  it("re-reads when the bytes arrive ahead of the record that names them", async () => {
    // A publication renames the file and writes its record a moment later, so
    // an attempt can straddle the two: same-length bytes that no record on
    // either side describes. That is the one state worth trying again, and the
    // settled publication answers.
    let attempt = 0;
    const artifact = await readExportArtifact({
      readBytes: async () => REVISION_TWO,
      readRecord: async () => {
        attempt += 1;
        // Three reads per attempt minus the byte read: the record only catches
        // up once the first attempt is over.
        return attempt <= 2 ? recordFor(REVISION_ONE, 8) : recordFor(REVISION_TWO, 9);
      }
    });

    expect(artifact?.provenance).toMatchObject({ state: "exact", revision: 9 });
  });

  it("waits for a record installed just after previously unknown bytes", async () => {
    let recordReads = 0;
    let byteReads = 0;
    const artifact = await readExportArtifact({
      readBytes: async () => {
        byteReads += 1;
        return REVISION_TWO;
      },
      readRecord: async () => {
        recordReads += 1;
        return recordReads < 3 ? null : recordFor(REVISION_TWO, 9);
      }
    });

    expect(artifact?.provenance).toMatchObject({ state: "exact", revision: 9 });
    expect(byteReads, "a large export is not reread while only its sidecar catches up").toBe(1);
  });

  it("gives up on a revision when the file keeps moving", async () => {
    const artifact = await readExportArtifact({
      readBytes: async () => REVISION_ONE,
      readRecord: async () => recordFor(REVISION_TWO, 9)
    });

    expect(artifact?.provenance).toMatchObject({ state: "mismatch" });
    expect(artifact?.bytes.toString()).toBe(REVISION_ONE.toString());
  });

  it("does not re-read a file no publication ever recorded", async () => {
    let byteReads = 0;

    const artifact = await readExportArtifact({
      readBytes: async () => {
        byteReads += 1;
        return REVISION_ONE;
      },
      readRecord: async () => null
    });

    expect(artifact?.provenance).toMatchObject({ state: "unknown" });
    expect(byteReads, "re-reading megabytes cannot turn an absent record into one").toBe(1);
  });

  it("is null when there is no file", async () => {
    expect(await readExportArtifact({ readBytes: async () => null, readRecord: async () => null })).toBeNull();
  });
});

describe("readPublishedExport", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "export-provenance-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("reads a published file back as the compile that published it", async () => {
    await writeFile(join(projectDir, "book.pdf"), REVISION_TWO);
    await writeExportProvenance({
      projectDir,
      format: "pdf",
      revision: 9,
      digest: exportContentDigest(REVISION_TWO),
      byteSize: REVISION_TWO.length
    });

    const artifact = await readPublishedExport(projectDir, "pdf");

    expect(artifact?.bytes.toString()).toBe(REVISION_TWO.toString());
    expect(artifact?.provenance).toMatchObject({ state: "exact", revision: 9 });
    await expect(readdir(projectDir)).resolves.toEqual([
      "book.pdf",
      "book.pdf.provenance.json"
    ]);
  });

  it("reports a same-length replacement as a mismatch, never as the old revision", async () => {
    // What the file looks like between one compile's rename and its record: the
    // record still describes the book that was there, and the book that is
    // there is the same size. Anything that answered "revision 8" here would
    // cache a newer book under an older compile.
    await writeFile(join(projectDir, "book.pdf"), REVISION_TWO);
    await writeExportProvenance({
      projectDir,
      format: "pdf",
      revision: 8,
      digest: exportContentDigest(REVISION_ONE),
      byteSize: REVISION_ONE.length
    });

    const artifact = await readPublishedExport(projectDir, "pdf");

    expect(artifact?.provenance).toEqual({ state: "mismatch", digest: exportContentDigest(REVISION_TWO) });
  });

  it("reports an unrecorded file as unknown", async () => {
    await writeFile(join(projectDir, "book.epub"), REVISION_ONE);

    expect((await readPublishedExport(projectDir, "epub"))?.provenance).toMatchObject({ state: "unknown" });
  });

  it("treats an unreadable record as no record at all", async () => {
    await writeFile(join(projectDir, "book.pdf"), REVISION_ONE);
    await writeFile(exportProvenancePath(projectDir, "pdf"), '{"revision":8,"dig');

    expect((await readPublishedExport(projectDir, "pdf"))?.provenance).toMatchObject({ state: "unknown" });
  });

  it("is null when the export is not on disk", async () => {
    expect(await readPublishedExport(projectDir, "pdf")).toBeNull();
  });
});

describe("parseExportProvenanceRecord", () => {
  it("refuses records that name no revision or no digest", () => {
    expect(parseExportProvenanceRecord('{"digest":"abc"}')).toBeNull();
    expect(parseExportProvenanceRecord('{"revision":3,"digest":""}')).toBeNull();
    expect(parseExportProvenanceRecord('{"revision":"3","digest":"abc"}')).toBeNull();
    expect(parseExportProvenanceRecord("not json")).toBeNull();
  });
});
