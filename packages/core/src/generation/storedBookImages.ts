import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { objectKey, objectStore, withTemporaryDirectory } from "@book-maker/storage";
import { imageMarkdownRe, resolveBookImageAsset } from "./bookImageAssets.js";

/** S3 renders require ownership; only explicit local fixtures require a disk root. */
export type BookImageOptions =
  | { imageSource: "object-storage"; projectId: string; imageStorageDir?: string }
  | { imageSource?: "local"; projectId?: string | undefined; imageStorageDir: string };
/** A renderer gets a private, scoped local snapshot of only this book's illustrations. */
export async function withStoredBookImages<T>(markdown: string, options: {
  projectId?: string | undefined;
  publicApiUrl: string;
}, render: (imageDirectory: string) => Promise<T>): Promise<T> {
  if (!options.projectId) throw new Error("An object-storage render requires projectId.");
  return withTemporaryDirectory("render-images", async (directory) => {
    const seen = new Set<string>();
    for (const match of markdown.matchAll(imageMarkdownRe())) {
      const asset = resolveBookImageAsset(match[2] ?? "", {
        imageStorageDir: directory,
        publicApiBase: options.publicApiUrl.replace(/\/+$/, ""),
        projectId: options.projectId
      });
      if (!asset || seen.has(asset.assetPath)) continue;
      seen.add(asset.assetPath);
      const parts = asset.assetPath.split("/").map(decodeURIComponent);
      const bytes = await objectStore().get(objectKey("images", ...parts));
      if (!bytes) continue;
      await mkdir(dirname(asset.localPath), { recursive: true });
      await writeFile(asset.localPath, bytes);
    }
    return render(directory);
  });
}
