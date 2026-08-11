import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isAllowedRenderResource } from "./renderResourcePolicy.js";

const imageStorageDir = resolve("/srv/storage/images");
const assetRoot = join(imageStorageDir, "proj-1");
const documentPath = join(imageStorageDir, ".book-render-abc.html");
const policy = { documentPath, assetRoot };
const allows = (path: string) => isAllowedRenderResource(pathToFileURL(path).href, policy);

describe("isAllowedRenderResource", () => {
  it("allows the document this render wrote", () => {
    expect(allows(documentPath)).toBe(true);
  });

  it("allows the book's own illustrations", () => {
    expect(allows(join(assetRoot, "page-1.png"))).toBe(true);
    expect(allows(join(assetRoot, "cover.svg"))).toBe(true);
  });

  it("allows the embedded fonts, which travel as data URIs", () => {
    expect(isAllowedRenderResource("data:font/woff2;base64,AAAA", policy)).toBe(true);
    expect(isAllowedRenderResource("about:blank", policy)).toBe(true);
  });

  it("refuses any other file on the server", () => {
    // The reported disclosure: a manuscript is user text, markdown passes raw
    // HTML through, and the document is opened from `file://`.
    expect(allows("/etc/passwd")).toBe(false);
    expect(allows("/proc/self/environ")).toBe(false);
    expect(allows("/srv/app/.env")).toBe(false);
  });

  it("refuses a climb out of the asset root", () => {
    expect(isAllowedRenderResource("file:///srv/storage/images/proj-1/../../../etc/passwd", policy)).toBe(false);
    expect(isAllowedRenderResource("file:///srv/storage/images/proj-1/..%2F..%2Fsecret.txt", policy)).toBe(false);
  });

  it("refuses another project's illustrations", () => {
    // The renderer reads what `sendOwnedProjectAsset` would have served it.
    expect(allows(join(imageStorageDir, "proj-2", "page-1.png"))).toBe(false);
  });

  it("refuses another compile's render document", () => {
    // Dotfiles are never illustrations, and this is what a concurrent compile's
    // in-flight document is named.
    expect(allows(join(assetRoot, ".book-render-def.html"))).toBe(false);
    expect(allows(join(assetRoot, ".env"))).toBe(false);
  });

  it("refuses the network", () => {
    // Not a regression to fix so much as the same hole from the other side: an
    // iframe of a cloud metadata endpoint prints the instance's credentials.
    expect(isAllowedRenderResource("http://169.254.169.254/latest/meta-data/", policy)).toBe(false);
    expect(isAllowedRenderResource("https://example.com/pic.png", policy)).toBe(false);
    expect(isAllowedRenderResource("ftp://example.com/pic.png", policy)).toBe(false);
  });

  it("refuses a file URL it cannot make sense of", () => {
    expect(isAllowedRenderResource("file://remote-host/share/passwd", policy)).toBe(false);
  });
});
