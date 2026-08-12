import { describe, expect, it } from "vitest";
import {
  LIBRARY_CHARACTER_IMAGE_LIMIT,
  pruneLibraryCharacterImages,
  type PrunableCharacterImage
} from "./libraryCharacterImages.js";

function images(count: number): PrunableCharacterImage[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `img-${index}`,
    fileName: `char-1-portrait-${index}.jpg`
  }));
}

describe("pruneLibraryCharacterImages", () => {
  it("keeps everything under the limit", () => {
    expect(pruneLibraryCharacterImages(images(3), { keepFileNames: [] })).toEqual([]);
    expect(
      pruneLibraryCharacterImages(images(LIBRARY_CHARACTER_IMAGE_LIMIT), { keepFileNames: [] })
    ).toEqual([]);
  });

  it("drops the oldest once the limit is passed", () => {
    const doomed = pruneLibraryCharacterImages(images(LIBRARY_CHARACTER_IMAGE_LIMIT + 2), {
      keepFileNames: []
    });
    expect(doomed.map((image) => image.id)).toEqual([
      `img-${LIBRARY_CHARACTER_IMAGE_LIMIT}`,
      `img-${LIBRARY_CHARACTER_IMAGE_LIMIT + 1}`
    ]);
  });

  it("never prunes a live pointer, however old it is", () => {
    // The picture a book draws from can be the oldest thing the character has:
    // an early illustration promoted back after a redraw nobody liked.
    const all = images(6);
    const doomed = pruneLibraryCharacterImages(all, {
      limit: 3,
      keepFileNames: [all[5]?.fileName ?? null, all[4]?.fileName ?? null]
    });
    expect(doomed.map((image) => image.id)).toEqual(["img-3"]);
  });

  it("counts an exempt pointer against the limit rather than granting a free slot", () => {
    const all = images(5);
    const doomed = pruneLibraryCharacterImages(all, {
      limit: 3,
      keepFileNames: [all[4]?.fileName ?? null]
    });
    // Slots 0,1,2 fill the limit; 3 is doomed; 4 survives only by exemption.
    expect(doomed.map((image) => image.id)).toEqual(["img-3"]);
  });

  it("ignores null and undefined pointers", () => {
    const doomed = pruneLibraryCharacterImages(images(4), {
      limit: 2,
      keepFileNames: [null, undefined]
    });
    expect(doomed.map((image) => image.id)).toEqual(["img-2", "img-3"]);
  });

  it("returns nothing for a character with no pictures", () => {
    expect(pruneLibraryCharacterImages([], { keepFileNames: [null] })).toEqual([]);
  });
});
