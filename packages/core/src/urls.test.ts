import { describe, expect, it } from "vitest";
import { publicAssetUrl, resolvePublicImageUrl } from "./urls.js";

describe("publicAssetUrl", () => {
  it("joins PUBLIC_API_URL with a relative asset path", () => {
    expect(publicAssetUrl("http://localhost:4001", "/assets/images/p1/page-1.png")).toBe(
      "http://localhost:4001/assets/images/p1/page-1.png"
    );
  });

  it("strips trailing slashes from the base URL", () => {
    expect(publicAssetUrl("http://localhost:4001/", "assets/images/p1/page-1.png")).toBe(
      "http://localhost:4001/assets/images/p1/page-1.png"
    );
  });

  it("returns absolute URLs unchanged", () => {
    const url = "https://cdn.example.com/assets/images/p1/page-1.png";
    expect(publicAssetUrl("http://localhost:4001", url)).toBe(url);
  });
});

describe("resolvePublicImageUrl", () => {
  it("returns undefined for empty paths", () => {
    expect(resolvePublicImageUrl(undefined, "http://localhost:4001")).toBeUndefined();
  });
});
