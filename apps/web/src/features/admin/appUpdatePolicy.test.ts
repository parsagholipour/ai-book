import { describe, expect, it } from "vitest";
import { newReleaseProblem, platformEffects, releasesDiffer, type AppUpdateRelease } from "./appUpdatePolicy.js";

const android = (build: number, policy: AppUpdateRelease["policy"]): AppUpdateRelease => ({
  platform: "android",
  build,
  version: `1.${build}.0`,
  policy
});

describe("platformEffects", () => {
  it("reduces a platform's releases to the newest required and the newest prompt above it", () => {
    expect(platformEffects([android(4, "required"), android(6, "prompt"), android(7, "silent")])).toEqual([
      { platform: "android", latest: android(7, "silent"), requiredBelow: 4, promptBelow: 6 }
    ]);
  });

  it("drops a prompt that a newer required release already covers", () => {
    expect(platformEffects([android(4, "prompt"), android(6, "required")])[0]).toMatchObject({
      requiredBelow: 6,
      promptBelow: null
    });
  });

  it("names no platform that has no releases", () => {
    expect(platformEffects([])).toEqual([]);
  });
});

describe("releasesDiffer", () => {
  it("ignores order, padding and empty messages", () => {
    expect(
      releasesDiffer(
        [android(4, "prompt"), { ...android(5, "silent"), message: "  " }],
        [android(5, "silent"), { ...android(4, "prompt"), version: " 1.4.0 " }]
      )
    ).toBe(false);
  });

  it("sees a changed policy", () => {
    expect(releasesDiffer([android(4, "prompt")], [android(4, "required")])).toBe(true);
  });
});

describe("newReleaseProblem", () => {
  it("refuses a build that is not a positive whole number", () => {
    expect(newReleaseProblem([], { platform: "android", build: "1.2", version: "1.2.0" })).toMatch(/whole-number/);
    expect(newReleaseProblem([], { platform: "android", build: "0", version: "1.2.0" })).toMatch(/whole-number/);
  });

  it("refuses a build the platform already lists", () => {
    expect(newReleaseProblem([android(4, "prompt")], { platform: "android", build: "4", version: "1.4.0" })).toBe(
      "Android build 4 is already listed."
    );
    expect(newReleaseProblem([android(4, "prompt")], { platform: "ios", build: "4", version: "1.4.0" })).toBeNull();
  });
});
