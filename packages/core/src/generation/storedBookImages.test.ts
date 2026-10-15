import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryObjectStore, setObjectStoreForTests } from "@book-maker/storage";
import { formatBookMatter } from "./bookMatterPages.js";
import { markdownLabels } from "./markdownLabels.js";
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

it("reads illustrations once and never reads image-shaped literal matter or escaped prose", async () => {
  const store = new MemoryObjectStore(); setObjectStoreForTests(store);
  await store.put("images/owned/literal.png", "not an illustration");
  await store.put("images/owned/body.png", "body illustration");
  const get = vi.spyOn(store, "get");
  const literal = "![literal](/assets/images/owned/literal.png)";
  const matter = formatBookMatter({
    title: `Title ${literal}`, afterCover: false, labels: markdownLabels("en"),
    matter: { year: 2026, madeWithCredit: false, dedication: `For ${literal}`, aboutAuthor: literal }
  });
  const markdown = [matter.titlePage, matter.matterSheet, "## Chapter One", `\\${literal}`,
    "![body](/assets/images/owned/body.png)", "![repeated](/assets/images/owned/body.png)", matter.aboutAuthor].join("\n\n");
  await withStoredBookImages(markdown, { projectId: "owned", publicApiUrl: "http://api" }, async (root) => {
    expect(await readFile(join(root, "owned", "body.png"), "utf8")).toBe("body illustration");
    await expect(access(join(root, "owned", "literal.png"))).rejects.toThrow();
  });
  expect(get.mock.calls.map(([key]) => key)).toEqual(["images/owned/body.png"]);
});
