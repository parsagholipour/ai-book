import {
  COMPANION_EXPORT_FORMATS,
  EXPORT_FORMATS,
  exportContentDigest,
  exportProvenancePath,
  isCompanionExportFormat,
  pendingExportTempPath,
  publishedExportFilename,
  supersededExportToken,
  type CompanionExportFormat,
  type ExportFormat,
  type ExportRepairFormat
} from "@book-maker/core";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The filesystem half of publishing a compile: where a render lands before it
 * is published, how the set moves onto its downloadable names, and how a
 * half-moved set is put back.
 *
 * Split out of `exportPublication.ts`, which keeps the claim and the
 * transaction. Everything here is a pure function of paths and flags plus the
 * renames themselves, and every list it builds derives from the format registry
 * in core — so a new export format is one registry entry and a renderer, not a
 * fourth spelling of `["md", "pdf", "epub"]`.
 */

export type PendingExportPaths = { markdown: string } & Record<ExportFormat, string>;

/** Which best-effort formats this compile managed to render. */
export type CompanionsProduced = Record<CompanionExportFormat, boolean>;

export const EVERY_COMPANION_PRODUCED: CompanionsProduced = Object.fromEntries(
  COMPANION_EXPORT_FORMATS.map((format) => [format, true])
) as CompanionsProduced;

const PUBLISHED_EXPORT_FILENAMES: Record<keyof PendingExportPaths, string> = {
  markdown: "book.md",
  ...(Object.fromEntries(EXPORT_FORMATS.map((format) => [format, publishedExportFilename(format)])) as Record<
    ExportFormat,
    string
  >)
};

/**
 * Where a compile renders, before anything downloadable can see it.
 *
 * Named per compile rather than per project: two compiles for one project
 * overlapping is the case this module exists for, so a shared scratch name
 * would have them writing over each other's half-rendered PDF.
 *
 * The name is built in `@book-maker/core` because the sweep that collects these
 * after a SIGKILL matches on it (`isPendingExportTempName`): a name assembled
 * from a local literal could drift out of that pattern and strand files nothing
 * recognises. `discardPendingExports` is still what removes them in every case
 * where this process gets to run its own `finally`.
 */
export function pendingExportPaths(projectDir: string, token: string = randomUUID()): PendingExportPaths {
  return {
    markdown: pendingExportTempPath(projectDir, "md", token),
    ...(Object.fromEntries(
      EXPORT_FORMATS.map((format) => [format, pendingExportTempPath(projectDir, format, token)])
    ) as Record<ExportFormat, string>)
  };
}

/** Removes whatever of a render survived — a no-op once it was published. */
export async function discardPendingExports(paths: PendingExportPaths): Promise<void> {
  await Promise.all(
    [
      paths.markdown,
      ...EXPORT_FORMATS.map((format) => paths[format]),
      ...EXPORT_FORMATS.map((format) => `${paths[format]}.provenance.json`)
    ].map((path) => rm(path, { force: true }).catch(() => undefined))
  );
}

/**
 * Where the artifacts this compile replaces are parked while it moves in.
 *
 * Named per publication for the same reason the render is: two compiles for one
 * project overlapping is the case this module exists for, and a shared name
 * would have each one holding the other's predecessor.
 */
function supersededExportPaths(projectDir: string): PendingExportPaths {
  return pendingExportPaths(projectDir, supersededExportToken());
}

/** One artifact's move onto its published name, and what it displaced. */
export type ArtifactPublication = {
  /** Null retires a live artifact without installing a successor. */
  pending: string | null;
  live: string;
  superseded: string;
  /** Whether a predecessor existed and is now parked at `superseded`. */
  parked: boolean;
  /** Whether the new artifact has reached `live`. */
  installed: boolean;
};

export type ArtifactPublicationOptions = {
  projectDir: string;
  pending: PendingExportPaths;
  companionsProduced: CompanionsProduced;
  repairFormat: ExportRepairFormat | null;
  publishReconstructedMarkdown: boolean;
};

/**
 * The downloadable formats this compile installs.
 *
 * A full compile installs the PDF and every companion it managed to render. A
 * repair installs the one format it was asked for — unless that format is a
 * companion whose render failed, in which case it installs nothing but any
 * reconstructed markdown. The markdown rides along whenever the caller says it
 * rebuilt one.
 */
export function publishedExportFormats(options: {
  companionsProduced: CompanionsProduced;
  repairFormat: ExportRepairFormat | null;
}): ExportFormat[] {
  if (options.repairFormat) {
    return isCompanionExportFormat(options.repairFormat) && !options.companionsProduced[options.repairFormat]
      ? []
      : [options.repairFormat];
  }
  return ["pdf", ...COMPANION_EXPORT_FORMATS.filter((format) => options.companionsProduced[format])];
}

/**
 * The companions this compile owed and could not render: their predecessors are
 * retired, so an older revision's file can never masquerade as this one's.
 */
function retiredCompanionFormats(options: {
  companionsProduced: CompanionsProduced;
  repairFormat: ExportRepairFormat | null;
}): CompanionExportFormat[] {
  return COMPANION_EXPORT_FORMATS.filter(
    (format) =>
      !options.companionsProduced[format] && (options.repairFormat === null || options.repairFormat === format)
  );
}

export function artifactPublications(options: ArtifactPublicationOptions): ArtifactPublication[] {
  const superseded = supersededExportPaths(options.projectDir);
  const formats: (keyof PendingExportPaths)[] = [
    ...(options.publishReconstructedMarkdown || options.repairFormat === null ? (["markdown"] as const) : []),
    ...publishedExportFormats(options)
  ];
  const publications: ArtifactPublication[] = formats.map((format) => ({
    pending: options.pending[format],
    live: join(options.projectDir, PUBLISHED_EXPORT_FILENAMES[format]),
    superseded: superseded[format],
    parked: false,
    installed: false
  }));
  for (const format of retiredCompanionFormats(options)) {
    publications.push({
      pending: null,
      live: join(options.projectDir, PUBLISHED_EXPORT_FILENAMES[format]),
      superseded: superseded[format],
      parked: false,
      installed: false
    });
  }
  return publications;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Parks a published artifact. False when there was none to park — the first
 * compile of a book, or one whose files an edit deleted a moment ago.
 *
 * Parked by `rename` rather than checked for first: an edit's
 * `invalidateCompiledProjectExports` deletes these files without taking the
 * project row lock this publication holds, so anything the check learned could
 * be wrong by the time the move ran.
 */
async function parkPublishedArtifact(live: string, superseded: string): Promise<boolean> {
  try {
    await rename(live, superseded);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

/** Moves the whole set into place, recording enough to undo a partial one. */
export async function installArtifacts(publications: ArtifactPublication[]): Promise<void> {
  for (const publication of publications) {
    publication.parked = await parkPublishedArtifact(publication.live, publication.superseded);
    if (publication.pending) {
      await rename(publication.pending, publication.live);
      publication.installed = true;
    }
  }
}

/**
 * Puts back exactly what `installArtifacts` moved, newest move first.
 *
 * Best-effort by necessity: this runs because something has already failed, and
 * the caller needs *that* failure rather than one raised while tidying up. A
 * restore that cannot complete is the mixed set this exists to prevent, which is
 * why it is the one thing here worth a log line.
 */
export async function restoreSupersededArtifacts(publications: ArtifactPublication[]): Promise<void> {
  for (const publication of [...publications].reverse()) {
    try {
      if (publication.parked) {
        // Overwrites the new artifact where it landed and fills the gap where it
        // did not: either way the published name ends up back on its predecessor.
        await rename(publication.superseded, publication.live);
      } else if (publication.installed) {
        // Nothing to put back, so the published name returns to being absent —
        // which is a state the repair lane knows how to answer.
        await rm(publication.live, { force: true });
      }
      publication.parked = false;
      publication.installed = false;
    } catch (error) {
      console.error(`Failed to restore ${publication.live} after an interrupted publication:`, error);
    }
  }
}

export type ExportDigests = Map<ExportFormat, { digest: string; byteSize: number }>;

/**
 * The digest of each downloadable artifact this compile is about to install.
 *
 * Hashed from the scratch files *before* the transaction opens. They are this
 * compile's own and cannot change under it, and the transaction holds a lock
 * every edit to this book has to take — a few megabytes of sha256 has no
 * business inside it. A file that cannot be read here simply gets no record:
 * the rename below will fail on it too, and that is the failure worth
 * reporting.
 */
export async function pendingExportDigests(options: {
  pending: PendingExportPaths;
  companionsProduced: CompanionsProduced;
  repairFormat: ExportRepairFormat | null;
}): Promise<ExportDigests> {
  const digests: ExportDigests = new Map();
  for (const format of publishedExportFormats(options)) {
    try {
      const bytes = await readFile(options.pending[format]);
      digests.set(format, { digest: exportContentDigest(bytes), byteSize: bytes.length });
    } catch {
      // Left unrecorded rather than guessed at.
    }
  }
  return digests;
}

/**
 * Files the installed bytes under the revision this compile published them for.
 *
 * Inside the transaction and after the artifacts have moved, so a rollback
 * leaves the previous record describing the file `restoreSupersededArtifacts`
 * puts back. Never fatal: a book that is on disk and downloadable must not be
 * failed — and refunded — because a hundred bytes of metadata beside it could
 * not be written. A download of bytes no record describes is answered as
 * exactly that, and the next publication of this book writes the record again.
 *
 * The revision is the claimed one, which the compare-and-set has just proved is
 * the row's. A payload carrying none (older rows) claimed unconditionally, so
 * the row is read by the caller instead — under the lock its transaction is
 * already holding, which is the one place that read cannot race the files it
 * describes.
 */
export async function provenancePublications(options: {
  projectDir: string;
  pending: PendingExportPaths;
  contentRevision: number;
  digests: ExportDigests;
  formatsTouched: ReadonlySet<ExportFormat>;
}): Promise<ArtifactPublication[]> {
  const superseded = supersededExportPaths(options.projectDir);
  const publications: ArtifactPublication[] = [];
  for (const format of options.formatsTouched) {
    const artifact = options.digests.get(format);
    const pending = `${options.pending[format]}.provenance.json`;
    let prepared: string | null = null;
    if (artifact) {
      try {
        await writeFile(
          pending,
          JSON.stringify({
            revision: options.contentRevision,
            digest: artifact.digest,
            byteSize: artifact.byteSize,
            publishedAt: new Date().toISOString()
          }),
          "utf8"
        );
        prepared = pending;
      } catch (error) {
        // The new bytes remain publishable, but an old record must not be left
        // describing them. Retiring it makes the download honestly `unknown`.
        console.error("Failed to prepare export provenance for publication:", error);
      }
    }
    publications.push({
      pending: prepared,
      live: exportProvenancePath(options.projectDir, format),
      superseded: `${superseded[format]}.provenance.json`,
      parked: false,
      installed: false
    });
  }
  return publications;
}

/** The formats whose provenance record this compile writes or retires. */
export function formatsTouchedByPublication(repairFormat: ExportRepairFormat | null): Set<ExportFormat> {
  return new Set<ExportFormat>(repairFormat ? [repairFormat] : EXPORT_FORMATS);
}

/** Drops the parked predecessors once the whole set is published. */
export async function discardSupersededArtifacts(publications: ArtifactPublication[]): Promise<void> {
  await Promise.all(
    publications
      .filter((publication) => publication.parked)
      .map((publication) => rm(publication.superseded, { force: true }).catch(() => undefined))
  );
}
