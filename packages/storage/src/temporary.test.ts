import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sweepTemporaryDirectories } from "./temporary.js";

it("sweeps expired helper leases while preserving active work and unrelated directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "storage-sweep-test-"));
  const now = new Date();
  const expired = new Date(now.getTime() - 8 * 60 * 60 * 1000);
  const recent = new Date(now.getTime() - 30 * 60 * 1000);
  const cases = [
    ["book-maker-render-images-Ab123x", expired],
    ["book-maker-render-images-Cd456y", recent],
    ["unrelated-Ab123x", expired]
  ] as const;
  try {
    for (const [name, touched] of cases) {
      const directory = join(root, name);
      await mkdir(directory);
      await writeFile(join(directory, ".active"), "scratch");
      await utimes(join(directory, ".active"), touched, touched);
    }
    // Even a caller requesting zero retention must keep recent live work.
    expect(await sweepTemporaryDirectories({ root, now, minAgeMs: 0 })).toBe(1);
    await expect(access(join(root, cases[0][0]))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, cases[1][0]))).resolves.toBeUndefined();
    await expect(access(join(root, cases[2][0]))).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
