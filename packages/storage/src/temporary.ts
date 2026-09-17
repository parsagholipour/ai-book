import { lstat, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { objectStore, validateObjectKey } from "./store.js";

export async function withTemporaryDirectory<T>(prefix: string, use: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), `book-maker-${prefix.replace(/[^a-zA-Z0-9_-]/g, "-")}-`));
  const lease = join(directory, ".active");
  await writeFile(lease, "scratch");
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lease, now, now).catch(() => undefined);
  }, 60_000);
  heartbeat.unref();
  try { return await use(directory); } finally {
    clearInterval(heartbeat);
    await rm(directory, { recursive: true, force: true });
  }
}
/** Materializes only the named objects for tools that require real filenames. */
export async function withObjectFiles<T>(keys: readonly string[], use: (files: string[]) => Promise<T>): Promise<T> {
  return withTemporaryDirectory("objects", async (directory) => {
    const files = await Promise.all(keys.map(async (key, index) => {
      const data = await objectStore().get(key);
      if (!data) throw new Error(`Object is missing: ${key}`);
      const file = join(directory, `${index}-${basename(key)}`);
      await writeFile(file, data);
      return file;
    }));
    return use(files);
  });
}
export function objectReference(key: string): string { return `object://${validateObjectKey(key)}`; }
/** Explicit references keep offline renderer fixtures local without a runtime disk fallback. */
export async function readObjectReference(reference: string): Promise<Buffer> {
  if (!reference.startsWith("object://")) return readFile(reference);
  const key = validateObjectKey(reference.slice("object://".length));
  const data = await objectStore().get(key);
  if (!data) throw new Error(`Object is missing: ${key}`);
  return data;
}

/** Each container sweeps its own scratch; a heartbeat protects live long renders. */
export async function sweepTemporaryDirectories(options: { minAgeMs: number; root?: string; now?: Date }): Promise<number> {
  const root = options.root ?? tmpdir();
  const cutoff = (options.now ?? new Date()).getTime() - Math.max(60 * 60 * 1000, options.minAgeMs);
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^book-maker-[a-zA-Z0-9_-]+-[a-zA-Z0-9]{6}$/.test(entry.name)) continue;
    const directory = join(root, entry.name);
    try {
      const lease = await lstat(join(directory, ".active"));
      if (!lease.isFile() || lease.mtimeMs >= cutoff) continue;
      // Re-read the lease immediately before removal, after the directory scan.
      const current = await lstat(join(directory, ".active"));
      if (current.mtimeMs !== lease.mtimeMs || current.ino !== lease.ino) continue;
      await rm(directory, { recursive: true, force: true });
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}
