import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIBRARY_MENTION_LIMIT } from "@book-maker/core";
import { describe, expect, it } from "vitest";
import {
  LIBRARY_CHARACTER_FIELD_KEY_MAX,
  LIBRARY_CHARACTER_FIELD_VALUE_MAX,
  LIBRARY_CHARACTER_FIELDS_MAX,
  LIBRARY_CHARACTER_LIMIT_PER_USER,
  LIBRARY_CHARACTER_MENTION_ENTRIES_MAX,
  LIBRARY_MENTION_OTHER_TYPE_MAX,
  LIBRARY_TARGET_ID_MAX,
  libraryMentionOtherTypeSchema,
  libraryMentionTargetArms,
  libraryMentionTargetSchema,
  mobileCharacterCreateBodySchema,
  mobileCharacterCreateOpenApiBody,
  mobileCharacterPortraitOpenApiBody,
  mobileCharacterUpdateBodySchema,
  mobileCharacterUpdateOpenApiBody
} from "./characterSchemas.js";
import { REQUEST_ID_MAX_LENGTH, REQUEST_ID_MIN_LENGTH, requestIdSchema } from "./schemas.js";

/**
 * `LibraryMention` is the one table in this group whose shape is stated in SQL
 * and nowhere else — `LibraryMention_target_arc` decides which columns each
 * kind may fill, and the API had no copy of it, so every violation was a
 * SQLSTATE reaching Fastify from inside a rolled-back transaction rather than a
 * 400 written at the door.
 *
 * These pin the copy. Nothing routes through it yet (`REPLACED_MENTION_KINDS`
 * is `["CHARACTER"]` and no body carries a kind), which is exactly why it needs
 * a suite: an unreached schema is one nothing else would notice going wrong.
 *
 * The suite is the second of three things holding it still, and it is the one
 * that runs. `libraryMentionTargetArms` is `satisfies
 * Record<LibraryMentionTargetKind, …>`, so the kind added to the Prisma enum
 * fails the build until it has an arm, and `replaceLibraryMentions` types its
 * `createMany` batch with the CHARACTER arm, so the live writer and the arc
 * cannot drift apart. What is left over is what a type cannot see — a kind in
 * `schema.prisma` that no `pnpm db:generate` has reached yet, and an arm left
 * out of the union's tuple — and that is what "the arc's coverage of the table"
 * below is for.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const prismaSchema = () => readFileSync(resolve(repoRoot, "packages/db/prisma/schema.prisma"), "utf8");

/** One enum's members, read out of its own block rather than the file. */
const enumMembers = (schema: string, name: string): string[] => {
  const block = schema.split(`enum ${name} {`)[1]?.split("\n}")[0] ?? "";
  const members = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));
  expect(members.length, `enum ${name} is not in schema.prisma`).toBeGreaterThan(0);
  return members;
};

/** One column's line, read out of its own model block rather than the file. */
const columnLine = (schema: string, model: string, column: string): string => {
  const block = schema.split(`model ${model} {`)[1]?.split("\n}")[0] ?? "";
  const line = block.split("\n").find((entry) => entry.trimStart().startsWith(`${column} `));
  expect(line, `${model}.${column} is not in schema.prisma`).toBeDefined();
  return line ?? "";
};

describe("the OTHER subtype", () => {
  it("trims what it stores, the way the arc's btrim test demands", () => {
    const parsed = libraryMentionOtherTypeSchema.safeParse("  sword  ");
    expect(parsed.success && parsed.data).toBe("sword");
  });

  it("refuses whitespace that is empty once trimmed", () => {
    // `char_length(btrim(...)) >= 1` in SQL. Untrimmed input that survives to
    // the insert fails the CHECK rather than the column, so this is the one
    // half of the rule the database still answers as a 23514.
    expect(libraryMentionOtherTypeSchema.safeParse("   ").success).toBe(false);
    expect(libraryMentionOtherTypeSchema.safeParse("").success).toBe(false);
  });

  it("stops exactly where the column does", () => {
    expect(libraryMentionOtherTypeSchema.safeParse("x".repeat(LIBRARY_MENTION_OTHER_TYPE_MAX)).success).toBe(true);
    expect(libraryMentionOtherTypeSchema.safeParse("x".repeat(LIBRARY_MENTION_OTHER_TYPE_MAX + 1)).success).toBe(false);
  });

  it("is the same number the column carries", () => {
    // The column is the reason the bound is 80 and `schema.prisma` is where it
    // is always current — a later migration may alter the type, and this reads
    // the model rather than the one migration that introduced it. Drift between
    // the model and the migrations is `prisma migrate diff`'s question, not
    // this suite's.
    const schema = readFileSync(resolve(repoRoot, "packages/db/prisma/schema.prisma"), "utf8");
    const column = schema.split("\n").find((line) => line.trimStart().startsWith("otherType "));
    expect(column).toContain(`@db.VarChar(${LIBRARY_MENTION_OTHER_TYPE_MAX})`);
  });
});

describe("the mention target arc", () => {
  it("accepts a character whose two ids are the same id", () => {
    expect(
      libraryMentionTargetSchema.safeParse({
        targetKind: "CHARACTER",
        targetId: "char-2",
        targetCharacterId: "char-2"
      }).success
    ).toBe(true);
  });

  it("refuses a character row whose FK names someone else", () => {
    // The FK cascade is what deletes a mention when its target goes, so a row
    // whose `targetCharacterId` is not its `targetId` outlives the character it
    // is about — and points the reader's app at one while naming another.
    expect(
      libraryMentionTargetSchema.safeParse({
        targetKind: "CHARACTER",
        targetId: "char-2",
        targetCharacterId: "char-3"
      }).success
    ).toBe(false);
  });

  it("refuses a character row carrying a subtype", () => {
    expect(
      libraryMentionTargetSchema.safeParse({
        targetKind: "CHARACTER",
        targetId: "char-2",
        targetCharacterId: "char-2",
        otherType: "sword"
      }).success
    ).toBe(false);
  });

  it("defaults both nullable columns rather than requiring the caller to spell null", () => {
    const parsed = libraryMentionTargetSchema.safeParse({ targetKind: "LOCATION", targetId: "loc-1" });
    expect(parsed.success && parsed.data).toEqual({
      targetKind: "LOCATION",
      targetId: "loc-1",
      targetCharacterId: null,
      otherType: null
    });
  });

  it("refuses a character FK on the two kinds that have no character", () => {
    for (const targetKind of ["LOCATION", "OTHER"] as const) {
      expect(
        libraryMentionTargetSchema.safeParse({
          targetKind,
          targetId: "x-1",
          targetCharacterId: "char-2",
          ...(targetKind === "OTHER" ? { otherType: "sword" } : {})
        }).success
      ).toBe(false);
    }
  });

  it("requires OTHER to name what the thing is, and refuses the name on LOCATION", () => {
    expect(libraryMentionTargetSchema.safeParse({ targetKind: "OTHER", targetId: "obj-1" }).success).toBe(false);
    expect(
      libraryMentionTargetSchema.safeParse({ targetKind: "OTHER", targetId: "obj-1", otherType: "  sword  " })
    ).toMatchObject({ success: true, data: { otherType: "sword" } });
    expect(
      libraryMentionTargetSchema.safeParse({ targetKind: "LOCATION", targetId: "loc-1", otherType: "tavern" }).success
    ).toBe(false);
  });

  it("refuses a kind the table does not have", () => {
    expect(libraryMentionTargetSchema.safeParse({ targetKind: "ITEM", targetId: "obj-1" }).success).toBe(false);
  });
});

describe("the arc's coverage of the table", () => {
  it("has an arm for every kind schema.prisma declares", () => {
    // The compile-time half of this is the `satisfies Record<
    // LibraryMentionTargetKind, …>` on the arms, and it can be asleep:
    // `packages/db/src/generated/` is gitignored and rebuilt by
    // `pnpm db:generate`, so between adding a kind to the enum and running that
    // command the type does not have the kind and the `satisfies` is satisfied.
    // This asks the schema file, which is the declaration itself.
    expect(Object.keys(libraryMentionTargetArms).sort()).toEqual(
      enumMembers(prismaSchema(), "LibraryMentionTargetKind").sort()
    );
  });

  it("puts every arm it wrote into the union", () => {
    // `z.discriminatedUnion` takes a non-empty tuple rather than the record, so
    // the `satisfies` cannot see an arm that is written and then left out of
    // the list — the one way to answer this file's own anchor and still ship a
    // kind the parser rejects. By identity rather than by equality: two arms
    // built alike are still two, and the question is which objects the union
    // holds.
    const arms = Object.values(libraryMentionTargetArms);
    expect(libraryMentionTargetSchema.options).toHaveLength(arms.length);
    for (const arm of arms) expect(libraryMentionTargetSchema.options).toContain(arm);
  });
});

/** The generated contract is structural; these tests pin the rules clients rely on. */

type JsonBound = {
  type?: string;
  additionalProperties?: boolean;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  items?: JsonBound;
  properties?: Record<string, JsonBound>;
  required?: string[];
};

const documentedProperties = (body: unknown): Record<string, JsonBound> =>
  (body as { properties: Record<string, JsonBound> }).properties;

const bound = (body: unknown, field: string): JsonBound => {
  const spec = documentedProperties(body)[field];
  expect(spec, `${field} is not in the documented body`).toBeDefined();
  return spec ?? {};
};

const writeBodies: { route: string; documented: unknown; accepted: { safeParse: (value: unknown) => { success: boolean } } }[] = [
  {
    route: "POST /api/mobile/characters",
    documented: mobileCharacterCreateOpenApiBody,
    accepted: mobileCharacterCreateBodySchema
  },
  {
    route: "PATCH /api/mobile/characters/:id",
    documented: mobileCharacterUpdateOpenApiBody,
    accepted: mobileCharacterUpdateBodySchema
  }
];

describe("the documented character bodies and the Zod schemas behind them", () => {
  it.each(writeBodies)("$route: every documented string bound is the one Zod keeps", ({ documented, accepted }) => {
    const strings = Object.entries(documentedProperties(documented)).flatMap(([field, spec]) =>
      spec.type === "string" && typeof spec.maxLength === "number" ? [{ field, maxLength: spec.maxLength }] : []
    );
    // A guard on the guard: a body whose fields stopped being documented would
    // pass an empty loop.
    expect(strings.map((entry) => entry.field).sort()).toEqual(["appearance", "description", "name"]);
    for (const { field, maxLength } of strings) {
      expect(accepted.safeParse({ name: "Ada", [field]: "x".repeat(maxLength) }).success).toBe(true);
      expect(accepted.safeParse({ name: "Ada", [field]: "x".repeat(maxLength + 1) }).success).toBe(false);
    }
  });

  it.each(writeBodies)("$route: bounds a mention target id where Zod bounds it", ({ documented, accepted }) => {
    expect(bound(documented, "mentionedCharacterIds").items).toEqual({
      type: "string",
      minLength: 1,
      maxLength: LIBRARY_TARGET_ID_MAX
    });
    const ids = (length: number) => ({ name: "Ada", mentionedCharacterIds: ["x".repeat(length)] });
    expect(accepted.safeParse(ids(LIBRARY_TARGET_ID_MAX)).success).toBe(true);
    expect(accepted.safeParse(ids(LIBRARY_TARGET_ID_MAX + 1)).success).toBe(false);
  });

  it.each(writeBodies)("$route: keeps both the body and profile rows strict", ({ documented }) => {
    const body = documented as JsonBound;
    const profileRow = bound(documented, "fields").items;

    expect(body.additionalProperties).toBe(false);
    expect(profileRow?.additionalProperties).toBe(false);
    expect(profileRow?.required).toEqual(["key", "value"]);
  });

  it("publishes create defaults without making those fields required", () => {
    const body = mobileCharacterCreateOpenApiBody as JsonBound;
    const properties = documentedProperties(body);

    expect(body.required).toEqual(["name"]);
    expect(properties.description?.default).toBe("");
    expect(properties.appearance?.default).toBe("");
    expect(properties.fields?.default).toEqual([]);
    expect(properties.mentionedCharacterIds?.default).toEqual([]);
  });

  it.each(writeBodies)("$route: bounds a profile row where Zod bounds it", ({ documented, accepted }) => {
    const row = bound(documented, "fields").items?.properties ?? {};
    expect(row.key?.maxLength).toBe(LIBRARY_CHARACTER_FIELD_KEY_MAX);
    expect(row.value?.maxLength).toBe(LIBRARY_CHARACTER_FIELD_VALUE_MAX);
    const fields = (key: number, value: number) => ({
      name: "Ada",
      fields: [{ key: "k".repeat(key), value: "v".repeat(value) }]
    });
    expect(accepted.safeParse(fields(LIBRARY_CHARACTER_FIELD_KEY_MAX, 1)).success).toBe(true);
    expect(accepted.safeParse(fields(LIBRARY_CHARACTER_FIELD_KEY_MAX + 1, 1)).success).toBe(false);
    expect(accepted.safeParse(fields(1, LIBRARY_CHARACTER_FIELD_VALUE_MAX)).success).toBe(true);
    expect(accepted.safeParse(fields(1, LIBRARY_CHARACTER_FIELD_VALUE_MAX + 1)).success).toBe(false);
  });

  it.each(writeBodies)("$route: documents the profile-row ceiling as the one Zod keeps", ({ documented, accepted }) => {
    expect(bound(documented, "fields").maxItems).toBe(LIBRARY_CHARACTER_FIELDS_MAX);
    const rows = (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({ key: `k${index}`, value: "v" }));
    expect(accepted.safeParse({ name: "Ada", fields: rows(LIBRARY_CHARACTER_FIELDS_MAX) }).success).toBe(true);
    expect(accepted.safeParse({ name: "Ada", fields: rows(LIBRARY_CHARACTER_FIELDS_MAX + 1) }).success).toBe(false);
  });

  it.each(writeBodies)("$route: bounds the mention list's size, not the cast it names", ({ documented, accepted }) => {
    // Two different questions, and only one of them is a `maxItems`. How many
    // characters a description may mention is `LIBRARY_MENTION_LIMIT`, counted
    // in *distinct* ids by `mentionedTargets`; what the door can ask is how many
    // entries the array holds. So the door takes the library cap — nothing can
    // name more targets than the account holds — and the rule keeps its one
    // spelling in the write.
    expect(LIBRARY_CHARACTER_MENTION_ENTRIES_MAX).toBe(LIBRARY_CHARACTER_LIMIT_PER_USER);
    expect(bound(documented, "mentionedCharacterIds").maxItems).toBe(LIBRARY_CHARACTER_MENTION_ENTRIES_MAX);
    const ids = (count: number) => Array.from({ length: count }, (_unused, index) => `char-${index}`);
    expect(
      accepted.safeParse({ name: "Ada", mentionedCharacterIds: ids(LIBRARY_CHARACTER_MENTION_ENTRIES_MAX) }).success
    ).toBe(true);
    expect(
      accepted.safeParse({ name: "Ada", mentionedCharacterIds: ids(LIBRARY_CHARACTER_MENTION_ENTRIES_MAX + 1) })
        .success
    ).toBe(false);
  });

  it.each(writeBodies)("$route: lets an over-cap cast reach the write that can name it", ({ accepted }) => {
    // The door held to `LIBRARY_MENTION_LIMIT` for a while, and an eleventh id
    // then failed the parse — which both routes answer with one line about the
    // field most bodies get wrong ("Give the character a name.", "Send at least
    // one change."), snackbared verbatim by the editor sheet. The reader was
    // told about a name that was fine. Past the door it is `mentionedTargets`'
    // own sentence, which names the list and the number.
    const ids = (count: number) => Array.from({ length: count }, (_unused, index) => `char-${index}`);
    expect(accepted.safeParse({ name: "Ada", mentionedCharacterIds: ids(LIBRARY_MENTION_LIMIT + 1) }).success).toBe(
      true
    );
  });

  it.each(writeBodies)("$route: counts entries, because maxItems cannot count anything else", ({ accepted }) => {
    // `maxItems` has no way to ask for distinct ids, so the bound is an entry
    // count on both sides of the door — which is the other half of why it may
    // not be the mention limit. A cast of exactly `LIBRARY_MENTION_LIMIT`
    // characters sent with one id repeated is eleven entries and a legal ten-name
    // set; `mentionedTargets` collapses it and stores ten links.
    const withDuplicate = [
      "char-0",
      "char-0",
      ...Array.from({ length: LIBRARY_MENTION_LIMIT - 1 }, (_unused, index) => `char-${index + 1}`)
    ];
    expect(withDuplicate).toHaveLength(LIBRARY_MENTION_LIMIT + 1);
    expect(new Set(withDuplicate).size).toBe(LIBRARY_MENTION_LIMIT);
    expect(accepted.safeParse({ name: "Ada", mentionedCharacterIds: withDuplicate }).success).toBe(true);
  });

  it("documents the portrait idempotency key with the bounds requestIdSchema keeps", () => {
    expect(bound(mobileCharacterPortraitOpenApiBody, "requestId")).toEqual({
      type: "string",
      minLength: REQUEST_ID_MIN_LENGTH,
      maxLength: REQUEST_ID_MAX_LENGTH
    });
    expect(requestIdSchema.safeParse("x".repeat(REQUEST_ID_MIN_LENGTH - 1)).success).toBe(false);
    expect(requestIdSchema.safeParse("x".repeat(REQUEST_ID_MIN_LENGTH)).success).toBe(true);
    expect(requestIdSchema.safeParse("x".repeat(REQUEST_ID_MAX_LENGTH)).success).toBe(true);
    expect(requestIdSchema.safeParse("x".repeat(REQUEST_ID_MAX_LENGTH + 1)).success).toBe(false);
  });

  it("keeps the id bound a door bound, because no column is holding it up", () => {
    // Asked of `schema.prisma` for the same reason the OTHER subtype asks it,
    // and answering the opposite: `otherType` is 80 because the column is 80,
    // while both id columns are unbounded `TEXT`. So this constant is the only
    // thing in the stack that refuses a long id, and a reader who assumes a
    // column under it would widen it and find nothing gives. The day one of
    // them gains a `VarChar`, that stops being true and this says so.
    const schema = prismaSchema();
    expect(columnLine(schema, "LibraryCharacter", "id")).not.toMatch(/@db\.VarChar/);
    expect(columnLine(schema, "LibraryMention", "targetId")).not.toMatch(/@db\.VarChar/);
  });
});
