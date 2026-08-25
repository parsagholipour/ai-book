import { describe, expect, it } from "vitest";

import { namesDeletedCharacter, namesOrphanedCharacterImage } from "./characterPhotoWrites.js";

const imageForeignKeyShapes = (): unknown[] => [
  Object.assign(new Error("Foreign key constraint failed"), {
    code: "P2003",
    meta: {
      modelName: "LibraryCharacterImage",
      driverAdapterError: {
        cause: { originalCode: "23503", constraint: { index: "LibraryCharacterImage_characterId_fkey" } }
      }
    }
  }),
  Object.assign(new Error("Error occurred during query execution"), {
    meta: {
      driverAdapterError: {
        cause: { originalCode: "23503", constraint: { index: "LibraryCharacterImage_characterId_fkey" } }
      }
    }
  }),
  Object.assign(new Error("An operation failed"), {
    meta: { code: "23503", constraint: "LibraryCharacterImage_characterId_fkey", modelName: "LibraryCharacterImage" }
  }),
  new Error('raw query failed. code: "23503". constraint: "LibraryCharacterImage_characterId_fkey"')
];

describe("character photo write failure classification", () => {
  it("recognizes an orphaned image row in every shared constraint traversal shape", () => {
    for (const failure of imageForeignKeyShapes()) {
      expect(namesOrphanedCharacterImage(failure)).toBe(true);
      expect(namesDeletedCharacter(failure)).toBe(false);
    }
  });

  it("keeps an orphaned image row distinct from a missing character pointer write", () => {
    const notFound = Object.assign(new Error("Record to update not found."), { code: "P2025" });
    expect([namesOrphanedCharacterImage(notFound), namesDeletedCharacter(notFound)]).toEqual([false, true]);

    for (const stranger of [new Error("connection terminated unexpectedly"), undefined, "boom"]) {
      expect([namesOrphanedCharacterImage(stranger), namesDeletedCharacter(stranger)]).toEqual([false, false]);
    }
  });

  it("does not claim foreign keys belonging to another character-write table", () => {
    const mentionForeignKey = Object.assign(new Error("Foreign key constraint failed"), {
      code: "P2003",
      meta: {
        modelName: "LibraryMention",
        driverAdapterError: {
          cause: { originalCode: "23503", constraint: { index: "LibraryMention_targetCharacterId_fkey" } }
        }
      }
    });
    expect(namesOrphanedCharacterImage(mentionForeignKey)).toBe(false);
  });
});
