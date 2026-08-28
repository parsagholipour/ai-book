import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who owns a sheet file whose row never landed.
 *
 * The unit half of the rule; the end-to-end half — which of a pass's four ways
 * out leave files behind — is in `characterReferenceRenderLease.test.ts`, over
 * two real overlapping passes.
 */

const mocks = vi.hoisted(() => ({ rm: vi.fn() }));

vi.mock("../runtime/config.js", () => ({ config: { IMAGE_STORAGE_DIR: "/tmp/images" } }));
vi.mock("node:fs/promises", () => ({ rm: mocks.rm }));

import {
  discardCharacterReferenceSheetFiles,
  localImagePathForAsset,
  projectImageDir,
  renderedSheetFileNames
} from "./characterReferenceSheetFiles.js";

describe("character reference sheet files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rm.mockResolvedValue(undefined);
  });

  it("names the files a pass wrote and invents none for the characters it was refused", () => {
    // A refused character has no entry and no file. Filling the gap would have
    // the sweep unlink a path nobody wrote — harmless today, and exactly the
    // shape of mistake that unlinks somebody else's sheet tomorrow.
    expect(renderedSheetFileNames([{ filename: "a.png" }, undefined, { filename: "c.png" }])).toEqual([
      "a.png",
      "c.png"
    ]);
    expect(renderedSheetFileNames([undefined, undefined])).toEqual([]);
  });

  it("unlinks every named sheet under the project's own image directory, forcing past a file that is gone", async () => {
    await discardCharacterReferenceSheetFiles("project-1", ["character-reference-ada-r1.png", "b.png"]);

    expect(mocks.rm.mock.calls.map(([path]) => String(path))).toEqual([
      "/tmp/images/project-1/character-reference-ada-r1.png",
      "/tmp/images/project-1/b.png"
    ]);
    // `force` is what makes the other end of a race having already won a
    // non-event rather than a caught error.
    expect(mocks.rm.mock.calls.every(([, options]) => options?.force === true)).toBe(true);
  });

  it("never lets a failed unlink out, whether the failure is raised or rejected", async () => {
    // This runs on the way out of a delivery that has already settled — a
    // rollback, a stand-down, an outage being rethrown — so anything escaping
    // here replaces the outcome the caller earned with a permissions error over
    // bytes nothing can reach. Both shapes, because a synchronous throw is what
    // an incomplete `node:fs/promises` stand-in produces and a `.catch` on the
    // returned promise would not have seen it.
    mocks.rm.mockRejectedValueOnce(new Error("EACCES"));
    mocks.rm.mockImplementationOnce(() => {
      throw new Error("rm is not a function");
    });

    await expect(discardCharacterReferenceSheetFiles("project-1", ["a.png", "b.png"])).resolves.toBeUndefined();
    expect(mocks.rm).toHaveBeenCalledTimes(2);
  });

  it("does nothing at all for a pass that wrote nothing", async () => {
    await discardCharacterReferenceSheetFiles("project-1", []);

    expect(mocks.rm).not.toHaveBeenCalled();
  });

  it("resolves a stored asset URL back to the file under this project, and refuses anything else", () => {
    expect(projectImageDir("project-1")).toBe("/tmp/images/project-1");
    expect(localImagePathForAsset("http://api.test/assets/images/project-1/sheet.png", "project-1")).toBe(
      "/tmp/images/project-1/sheet.png"
    );
    // Another project's asset, and a path that escapes the directory, both
    // resolve to nothing — the sweep may only ever name this project's files.
    expect(localImagePathForAsset("http://api.test/assets/images/project-2/sheet.png", "project-1")).toBeUndefined();
    expect(
      localImagePathForAsset("http://api.test/assets/images/project-1/nested%2Fsheet.png", "project-1")
    ).toBeUndefined();
  });
});
