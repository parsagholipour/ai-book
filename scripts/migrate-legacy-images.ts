import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { prisma } from "../packages/db/src/index.ts";
import { objectKey, objectStore } from "../packages/storage/src/index.ts";

/**
 * Copy pictures that only ever lived on local disk into the object store.
 *
 * Durable images moved to private S3 (MinIO locally), and `storage/README.md`
 * says the old directory is historical: "neither migrated nor read as a
 * fallback". So every book made before the move lost its pictures at once —
 * the cover of a finished book answers 404 from `/assets/:id`, the app asks
 * again on every visit (one cover was requested 32 times in 12 hours), and a
 * saved character's portrait shows its initials. The bytes are still on disk
 * under `storage/images/`; nothing copies them.
 *
 * Two kinds of row name such a file, and each maps to one key:
 *   - `ImageAsset` (covers, page pictures, reference sheets):
 *     `.../assets/images/<projectId>/<file>` → `images/<projectId>/<file>`
 *   - `LibraryCharacterImage` (a saved character's photo or portrait):
 *     `<userId>/<fileName>` → `images/characters/<userId>/<fileName>`
 *
 * A row is copied only when the object is missing and the file is present, and
 * the write is `putIfAbsent`, so nothing in the store is ever overwritten.
 *
 * MinIO refuses every write once its drive is under ~1% free, and the local
 * drive has sat just above that. Check `df` first: the dry run prints the bytes
 * an `--apply` would add.
 *
 * Run inside the api container (the host has no object-store credentials):
 *
 *   docker exec -w /app/apps/api ai-book-maker-api-1 \
 *     node /app/scripts/tsx-dev-entry.mjs /app/scripts/migrate-legacy-images.ts \
 *     [--project <id>] [--storage-dir <dir>] [--verbose] [--apply]
 *
 * Dry run by default, like every other ops script here.
 */

type Args = { apply: boolean; verbose: boolean; projectId?: string | undefined; storageDir: string };

type Candidate = { key: string; file: string; bytes: number; label: string };

type Tally = { scanned: number; present: number; candidates: Candidate[]; missingEverywhere: number; unreadablePath: number };

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/;
const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml"
};

function parseArgs(argv: string[]): Args {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    apply: argv.includes("--apply"),
    verbose: argv.includes("--verbose"),
    projectId: value("--project"),
    storageDir: resolve(value("--storage-dir") ?? join(import.meta.dirname, "..", "storage", "images"))
  };
}

/** The file an `ImageAsset.path` names under its own project, the same rule the asset route reads. */
export function projectImageFileName(path: string, projectId: string): string | null {
  let pathname = path;
  try {
    pathname = new URL(path).pathname;
  } catch {
    // A bare `/assets/images/...` path is read as it stands.
  }
  const prefix = `/assets/images/${projectId}/`;
  const index = pathname.indexOf(prefix);
  if (index === -1) return null;
  let fileName: string;
  try {
    fileName = decodeURIComponent(pathname.slice(index + prefix.length));
  } catch {
    return null;
  }
  return SAFE_SEGMENT.test(fileName) ? fileName : null;
}

async function fileSize(file: string): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

async function consider(tally: Tally, key: string, file: string, label: string): Promise<void> {
  tally.scanned += 1;
  if (await objectStore().head(key)) {
    tally.present += 1;
    return;
  }
  const bytes = await fileSize(file);
  if (bytes === null) {
    tally.missingEverywhere += 1;
    return;
  }
  tally.candidates.push({ key, file, bytes, label });
}

async function scanProjectImages(args: Args, tally: Tally): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.imageAsset.findMany({
      where: args.projectId ? { projectId: args.projectId } : {},
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, projectId: true, type: true, path: true }
    });
    if (rows.length === 0) return;
    for (const row of rows) {
      const fileName = projectImageFileName(row.path, row.projectId);
      if (!fileName || !SAFE_SEGMENT.test(row.projectId)) {
        tally.scanned += 1;
        tally.unreadablePath += 1;
        continue;
      }
      await consider(
        tally,
        objectKey("images", row.projectId, fileName),
        join(args.storageDir, row.projectId, fileName),
        `${row.type} ${row.id} (project ${row.projectId})`
      );
    }
    cursor = rows.at(-1)!.id;
  }
}

async function scanCharacterImages(args: Args, tally: Tally): Promise<void> {
  if (args.projectId) return;
  const rows = await prisma.libraryCharacterImage.findMany({
    orderBy: { id: "asc" },
    select: { id: true, userId: true, fileName: true, source: true }
  });
  for (const row of rows) {
    if (!SAFE_SEGMENT.test(row.userId) || !SAFE_SEGMENT.test(row.fileName)) {
      tally.scanned += 1;
      tally.unreadablePath += 1;
      continue;
    }
    await consider(
      tally,
      objectKey("images", "characters", row.userId, row.fileName),
      join(args.storageDir, "characters", row.userId, row.fileName),
      `character ${row.source} ${row.id}`
    );
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function report(name: string, tally: Tally, verbose: boolean): void {
  const bytes = tally.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  console.log(`${name}: ${tally.scanned} rows`);
  console.log(`  already in the object store: ${tally.present}`);
  console.log(`  on disk only (would copy):   ${tally.candidates.length} (${megabytes(bytes)})`);
  console.log(`  in neither place:            ${tally.missingEverywhere}`);
  console.log(`  path not readable:           ${tally.unreadablePath}`);
  if (verbose) {
    for (const candidate of tally.candidates) console.log(`    ${candidate.key} ← ${candidate.file} (${candidate.label})`);
  }
}

async function copy(candidates: Candidate[]): Promise<{ copied: number; skipped: number; failed: number }> {
  const outcome = { copied: 0, skipped: 0, failed: 0 };
  for (const candidate of candidates) {
    try {
      const data = await readFile(candidate.file);
      const contentType = CONTENT_TYPES[extname(candidate.file).toLowerCase()];
      const written = await objectStore().putIfAbsent(candidate.key, data, contentType ? { contentType } : undefined);
      if (written) outcome.copied += 1;
      else outcome.skipped += 1;
    } catch (error) {
      outcome.failed += 1;
      console.error(`  failed: ${candidate.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return outcome;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Legacy image directory: ${args.storageDir}${args.apply ? "" : "  (dry run; pass --apply to copy)"}`);
  await objectStore().ready();
  const projects: Tally = { scanned: 0, present: 0, candidates: [], missingEverywhere: 0, unreadablePath: 0 };
  const characters: Tally = { scanned: 0, present: 0, candidates: [], missingEverywhere: 0, unreadablePath: 0 };
  await scanProjectImages(args, projects);
  await scanCharacterImages(args, characters);
  report("Book images (ImageAsset)", projects, args.verbose);
  report("Character pictures (LibraryCharacterImage)", characters, args.verbose);
  const all = [...projects.candidates, ...characters.candidates];
  console.log(`Total to copy: ${all.length} files, ${megabytes(all.reduce((sum, candidate) => sum + candidate.bytes, 0))}`);
  if (!args.apply) return;
  const outcome = await copy(all);
  console.log(`Copied ${outcome.copied}, already present ${outcome.skipped}, failed ${outcome.failed}.`);
  if (outcome.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    await main();
  } finally {
    await prisma.$disconnect();
  }
}
