import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBookImageAsset } from "./bookImageAssets.js";

const imageStorageDir = resolve("/srv/storage/images");
const publicApiBase = "http://localhost:4001";
const resolveAsset = (src: string) => resolveBookImageAsset(src, { imageStorageDir, publicApiBase });

describe("resolveBookImageAsset", () => {
  it("resolves a project illustration to its file and its renderer-relative path", () => {
    expect(resolveAsset("http://localhost:4001/assets/images/proj-1/page-1.png")).toEqual({
      localPath: join(imageStorageDir, "proj-1", "page-1.png"),
      assetPath: "proj-1/page-1.png"
    });
  });

  it("resolves the same asset named as a bare path", () => {
    expect(resolveAsset("/assets/images/proj-1/page-1.png")?.assetPath).toBe("proj-1/page-1.png");
  });

  it("decodes a percent-encoded filename before reading it, and re-encodes the path", () => {
    // The two copies of this resolver disagreed here too: the EPUB decoded, the
    // PDF did not, so an image with a space in its name was packaged into one
    // export and silently missing from the other.
    expect(resolveAsset("/assets/images/proj-1/a%20page.png")).toEqual({
      localPath: join(imageStorageDir, "proj-1", "a page.png"),
      assetPath: "proj-1/a%20page.png"
    });
  });

  it("keeps a filename that is not valid percent-encoding", () => {
    expect(resolveAsset("/assets/images/proj-1/100%.png")?.localPath).toBe(
      join(imageStorageDir, "proj-1", "100%.png")
    );
  });

  it("refuses a filename that climbs out of the storage directory", () => {
    // The reported disclosure: the filename group matches slashes, so without
    // containment this read a server file and packaged it into the download.
    expect(resolveAsset("/assets/images/p/../../../../etc/passwd")).toBeNull();
  });

  it("refuses a climb that is percent-encoded", () => {
    expect(resolveAsset("/assets/images/p/..%2F..%2F..%2F..%2Fetc%2Fpasswd")).toBeNull();
  });

  it("refuses a climb through the project segment", () => {
    expect(resolveAsset("/assets/images/..%2F..%2Fetc/passwd")).toBeNull();
  });

  it("refuses a path that stays inside the directory but is not an illustration", () => {
    // Two segments exactly, the shape `GET /assets/images/:projectId/:filename`
    // serves — so no reaching a nested file, and no naming the storage root.
    expect(resolveAsset("/assets/images/proj-1/nested/page-1.png")).toBeNull();
    expect(resolveAsset("/assets/images/proj-1/.%2Fpage-1.png")?.assetPath).toBe("proj-1/page-1.png");
  });

  it("refuses another project's illustration when the compile names its project", () => {
    // Storage is shared, so containment only says "some book's illustration".
    // A manuscript is user text, and one that names a path it has no business
    // knowing was reading another reader's artwork — the PDF stopped at the
    // renderer's allowlist, the EPUB read the file and packaged it.
    const scoped = (src: string) =>
      resolveBookImageAsset(src, { imageStorageDir, publicApiBase, projectId: "proj-1" });

    expect(scoped("/assets/images/proj-1/page-1.png")?.assetPath).toBe("proj-1/page-1.png");
    expect(scoped("/assets/images/proj-2/page-1.png")).toBeNull();
    // Compared against the directory the read would come from, not the text:
    // both of these name `proj-2` by the time the path is resolved.
    expect(scoped("/assets/images/proj-1/..%2Fproj-2%2Fpage-1.png")).toBeNull();
    expect(scoped("/assets/images/proj%2D2/page-1.png")).toBeNull();
    // A prefix is a different project, not this one.
    expect(scoped("/assets/images/proj-10/page-1.png")).toBeNull();
  });

  it("keeps the whole storage directory in scope when no project is named", () => {
    // The fixture renderer compiles books belonging to no project.
    expect(resolveAsset("/assets/images/proj-2/page-1.png")?.assetPath).toBe("proj-2/page-1.png");
  });

  it("refuses anything that is not an asset URL", () => {
    expect(resolveAsset("https://example.com/pic.png")).toBeNull();
    expect(resolveAsset("data:image/png;base64,AAAA")).toBeNull();
    expect(resolveAsset("")).toBeNull();
  });

  it("never returns a path outside the storage directory", () => {
    const inputs = [
      "/assets/images/p/../../secret.txt",
      "/assets/images/p/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/assets/images/./../secret.txt",
      "/assets/images/p/..\\..\\secret.txt"
    ];
    for (const input of inputs) {
      const asset = resolveAsset(input);
      expect(asset === null || asset.localPath.startsWith(imageStorageDir + sep)).toBe(true);
    }
  });
});
