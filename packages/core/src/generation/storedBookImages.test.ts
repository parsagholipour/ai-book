import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MemoryObjectStore, setObjectStoreForTests } from "@book-maker/storage";
import { withStoredBookImages } from "./storedBookImages.js";

afterEach(() => setObjectStoreForTests(null));
it("materializes only this project's referenced assets and removes the render snapshot", async () => {
  const store = new MemoryObjectStore(); setObjectStoreForTests(store);
  await store.put("images/owned/cover.png", "owned");
  await store.put("images/other/private.png", "secret");
  let directory = "";
  await withStoredBookImages("![cover](/assets/images/owned/cover.png)\n![other](/assets/images/other/private.png)\n![traversal](/assets/images/owned/../../other/private.png)",
    { projectId: "owned", publicApiUrl: "http://api" }, async (root) => {
      directory = root;
      expect(await readFile(join(root, "owned", "cover.png"), "utf8")).toBe("owned");
      await expect(access(join(root, "other", "private.png"))).rejects.toThrow();
    });
  await expect(access(directory)).rejects.toThrow();
});
it("requires project scope for S3 materialization", async () => {
  await expect(withStoredBookImages("", { publicApiUrl: "http://api" }, async () => undefined)).rejects.toThrow("projectId");
});
