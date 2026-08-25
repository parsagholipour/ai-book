import { describe, expect, it } from "vitest";

import {
  constraintErrorText,
  namesMentionCharacterForeignKey,
  namesMentionCheckConstraint,
  namesMentionPrimaryKey
} from "./libraryMentionConstraintErrors.js";

function prismaFailure(message: string, code: string, meta: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, meta });
}

/** One violation in every location Prisma and `@prisma/adapter-pg` may report it. */
const reportedEveryWay = (sqlstate: string, constraint: string, table: string, prismaCode?: string): unknown[] => [
  ...(prismaCode === undefined
    ? []
    : [
        prismaFailure(`Constraint failed: ${constraint}`, prismaCode, {
          modelName: table,
          driverAdapterError: { cause: { originalCode: sqlstate, constraint: { index: constraint } } }
        })
      ]),
  Object.assign(new Error("Error occurred during query execution"), {
    meta: { driverAdapterError: { cause: { originalCode: sqlstate, constraint: { index: constraint } } } }
  }),
  Object.assign(new Error("An operation failed"), { meta: { code: sqlstate, constraint, modelName: table } }),
  new Error(`raw query failed. code: "${sqlstate}". constraint: "${constraint}"`)
];

describe("LibraryMention constraint-error classification", () => {
  const predicates = [namesMentionCheckConstraint, namesMentionCharacterForeignKey];

  it("recognizes each owned constraint in every supported Prisma/driver shape", () => {
    const lanes = [
      reportedEveryWay("23514", "LibraryMention_target_arc", "LibraryMention"),
      reportedEveryWay("23503", "LibraryMention_targetCharacterId_fkey", "LibraryMention", "P2003")
    ];

    lanes.forEach((shapes, owner) => {
      for (const failure of shapes) {
        expect(predicates.map((names) => names(failure))).toEqual([owner === 0, owner === 1]);
      }
    });
  });

  it("does not claim constraints belonging to other tables", () => {
    const strangers = [
      ...reportedEveryWay("23503", "LibraryCharacter_userId_fkey", "LibraryCharacter", "P2003"),
      ...reportedEveryWay("23503", "LibraryCharacterImage_characterId_fkey", "LibraryCharacterImage", "P2003"),
      new Error("connection terminated unexpectedly"),
      undefined,
      "boom"
    ];

    for (const failure of strangers) {
      expect(predicates.map((names) => names(failure))).toEqual([false, false]);
    }
    expect([constraintErrorText(undefined), constraintErrorText("boom")]).toEqual(["", ""]);
  });

  it("recognizes the mention subtype length rule under either database code", () => {
    expect(namesMentionCheckConstraint({ code: "P2000", meta: { column_name: "otherType" } })).toBe(true);
    expect(namesMentionCheckConstraint({ meta: { code: "22001", modelName: "LibraryMention" } })).toBe(true);
  });

  it("distinguishes mention primary-key collisions from character-name uniques", () => {
    expect(namesMentionPrimaryKey(prismaFailure("Unique constraint failed", "P2002", { modelName: "LibraryMention" }))).toBe(
      true
    );
    expect(
      namesMentionPrimaryKey(
        prismaFailure("Unique constraint failed", "P2002", {
          target: ["sourceCharacterId", "targetKind", "targetId"]
        })
      )
    ).toBe(true);
    expect(
      namesMentionPrimaryKey(
        prismaFailure("Unique constraint failed", "P2002", { modelName: "LibraryCharacter", target: ["userId", "name"] })
      )
    ).toBe(false);
    expect(namesMentionPrimaryKey(prismaFailure("Foreign key failed", "P2003", { modelName: "LibraryMention" }))).toBe(
      false
    );
  });
});
