import { createHash } from "node:crypto";
import { objectKey, objectStore } from "@book-maker/storage";
import { EXPORT_FORMATS, publishedExportFilename, type ExportFormat } from "./exportFormats.js";

/**
 * Which compile of a book a downloaded file actually came from.
 *
 * Every compile publishes over the same two filenames, so a download URL is not
 * an identity: `book.pdf` is whatever the last publication left there. The
 * reader nevertheless has to file the bytes it fetched under a
 * `contentRevision` — it caches them under one, decides staleness against one,
 * and stamps every highlight and bookmark with one. It used to take that number
 * from the availability descriptor it had read moments earlier, which is a claim
 * about the past: a compile landing between the descriptor and the download
 * hands back a *newer* book under an *older* revision, and all three of those
 * records are then wrong about the same file. The retry after a failed download
 * is where that is not an edge case but the normal course of events, because
 * `EXPORT_NOT_READY` means a compile is landing.
 *
 * Comparing sizes cannot close it. Two compiles of one manuscript routinely
 * differ by no bytes at all — a presentation reprint, a re-applied edit, an undo
 * — so a same-length replacement passes a size check and is filed under the
 * revision that did not produce it.
 *
 * So the pairing is made by content. Every publication writes the digest of the
 * bytes it installed beside them, along with the revision it claimed, and a
 * download resolves the bytes it holds against that record. A digest match *is*
 * the provenance: nothing about the project row is consulted to establish it,
 * because a row read after a file read can describe a different compile than the
 * bytes in hand — which is the same mistake one layer down.
 *
 * The record is written by the publisher under the project row lock it already
 * holds. A download surface may also repair a missing record under that same
 * lock: this is how exports created before provenance existed, and publications
 * whose metadata write failed, become exact without rerendering the book.
 */

export type ExportProvenanceFormat = ExportFormat;

/** What a publication recorded about the bytes it installed. */
export type ExportProvenanceRecord = {
  /** The `contentRevision` the publishing compile claimed. */
  revision: number;
  /** sha256, hex. The identity of the published bytes. */
  digest: string;
  byteSize: number;
  publishedAt: string;
};

/**
 * How well a file in hand is tied to the compile that produced it.
 *
 * - `exact` — a record describes exactly these bytes. The revision is a fact.
 * - `unknown` — no record exists. Either the file predates this mechanism or it
 *   was published in the microseconds before its record was written. There is
 *   nothing to contradict, and nothing to confirm.
 * - `mismatch` — a record exists and describes *other* bytes. The file is being
 *   replaced underneath this read, which is precisely the case that must never
 *   be labelled with a revision.
 */
export type ExportProvenance =
  | { state: "exact"; revision: number; digest: string }
  | { state: "unknown"; digest: string }
  | { state: "mismatch"; digest: string };

export type ExportArtifact = {
  bytes: Buffer;
  provenance: ExportProvenance;
};

const PROVENANCE_SUFFIX = ".provenance.json";

export function exportProvenanceKey(projectId: string, format: ExportProvenanceFormat): string {
  return objectKey("books", projectId, `${publishedExportFilename(format)}${PROVENANCE_SUFFIX}`);
}

/** @deprecated Use exportProvenanceKey: this value is an S3 key, never a filesystem path. */
export const exportProvenancePath = exportProvenanceKey;

/** Every record a project can hold, for the delete paths that take all of them. */
export function exportProvenancePaths(projectId: string): string[] {
  return EXPORT_FORMATS.map((format) => exportProvenancePath(projectId, format));
}

export function exportContentDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Records that `bytes` — identified by `digest` — are the given revision's.
 *
 * The small document is still installed atomically. A reader therefore sees the
 * previous complete record or the next complete record, never a torn JSON write.
 */
export async function writeExportProvenance(options: {
  projectId: string;
  format: ExportProvenanceFormat;
  revision: number;
  digest: string;
  byteSize: number;
  publishedAt?: Date;
}): Promise<void> {
  const record: ExportProvenanceRecord = {
    revision: options.revision,
    digest: options.digest,
    byteSize: options.byteSize,
    publishedAt: (options.publishedAt ?? new Date()).toISOString()
  };
  await objectStore().put(exportProvenancePath(options.projectId, options.format), JSON.stringify(record), {
    contentType: "application/json"
  });
}

/** The stored record, or null when it is absent or malformed. */
export async function readExportProvenanceRecord(
  projectId: string,
  format: ExportProvenanceFormat
): Promise<ExportProvenanceRecord | null> {
  const bytes = await objectStore().get(exportProvenancePath(projectId, format));
  return bytes ? parseExportProvenanceRecord(bytes.toString("utf8")) : null;
}

export function parseExportProvenanceRecord(raw: string): ExportProvenanceRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const { revision, digest, byteSize, publishedAt } = record;
  if (!Number.isInteger(revision) || typeof digest !== "string" || digest.length === 0) {
    return null;
  }
  return {
    revision: revision as number,
    digest,
    byteSize: typeof byteSize === "number" ? byteSize : 0,
    publishedAt: typeof publishedAt === "string" ? publishedAt : ""
  };
}

/** Drops a format's record. Used where the published file itself is deleted. */
export async function removeExportProvenance(projectId: string, format: ExportProvenanceFormat): Promise<void> {
  await objectStore().delete(exportProvenancePath(projectId, format));
}

/**
 * The verdict on `digest`, given every record read around the bytes.
 *
 * Records are compared newest-read first, but either may confirm: a record's
 * digest identifies one specific file, so a match means those bytes were
 * published as that revision no matter when the record was read.
 */
export function exportProvenanceFor(
  digest: string,
  records: readonly (ExportProvenanceRecord | null)[]
): ExportProvenance {
  const matched = records.find((record) => record?.digest === digest);
  if (matched) {
    return { state: "exact", revision: matched.revision, digest };
  }
  return records.some((record) => record !== null) ? { state: "mismatch", digest } : { state: "unknown", digest };
}

/**
 * Reads an export and the provenance of the exact bytes it returned.
 *
 * The record is read on both sides of the file read, because a publication that
 * lands in between moves the file and the record independently as far as this
 * reader is concerned: whichever of the two describes the bytes that arrived is
 * the truth about them, and if neither does, the file is being replaced right
 * now and one more attempt catches its settled state.
 *
 * A `mismatch` that survives the retry is answered honestly rather than retried
 * forever — the caller still gets a whole, readable book, it just may not be
 * filed under a revision.
 *
 * Taking the two reads as arguments is what makes the interleavings testable at
 * all; `readPublishedExport` is the S3 binding and the only caller that
 * matters.
 */
export async function readExportArtifact(readers: {
  readBytes: () => Promise<Buffer | null>;
  readRecord: () => Promise<ExportProvenanceRecord | null>;
  attempts?: number;
  retryDelayMs?: number;
}): Promise<ExportArtifact | null> {
  const attempts = Math.max(1, readers.attempts ?? 2);
  const retryDelayMs = Math.max(0, readers.retryDelayMs ?? 0);
  let last: ExportArtifact | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = await readers.readRecord();
    const bytes = await readers.readBytes();
    if (!bytes) {
      return null;
    }
    const after = await readers.readRecord();
    const provenance = exportProvenanceFor(exportContentDigest(bytes), [after, before]);
    last = { bytes, provenance };
    if (provenance.state === "exact" || attempt === attempts - 1) {
      return last;
    }

    await delay(retryDelayMs);
    if (provenance.state === "unknown") {
      // The downloadable file is installed just before its tiny metadata
      // record. Poll only the record first: this catches that publication gap
      // without rereading a multi-megabyte legacy book merely because it has no
      // record. A record for other bytes falls through to the next full read.
      const settledRecord = await readers.readRecord();
      if (!settledRecord) {
        return last;
      }
      const settled = exportProvenanceFor(provenance.digest, [settledRecord]);
      if (settled.state === "exact") {
        return { bytes, provenance: settled };
      }
    }
  }
  return last;
}

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The compiled file and its provenance, or null when it is absent from object storage. */
export async function readPublishedExport(
  projectId: string,
  format: ExportProvenanceFormat
): Promise<ExportArtifact | null> {
  return readExportArtifact({
    readBytes: () => objectStore().get(objectKey("books", projectId, publishedExportFilename(format))),
    readRecord: () => readExportProvenanceRecord(projectId, format),
    // Sidecar installation follows the artifact PUT immediately. One short,
    // bounded poll closes that gap; a genuinely legacy file still incurs no
    // second read of its potentially large bytes.
    retryDelayMs: 10
  });
}
