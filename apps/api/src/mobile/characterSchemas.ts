import { MAX_APPEARANCE_LENGTH } from "@book-maker/core";
import type { LibraryMentionTargetKind } from "@book-maker/db";
import { z } from "zod";
import { REQUEST_ID_MAX_LENGTH, REQUEST_ID_MIN_LENGTH, requestIdSchema } from "./schemas.js";

/**
 * Bodies for the library-character routes — both groups, `routes/characters.ts`
 * and `routes/characterImages.ts` — split out of `schemas.ts` for the file-size
 * budget. The OpenAPI fragments beside each Zod schema feed Fastify's docs and
 * must move together with them.
 */

export const LIBRARY_CHARACTER_LIMIT_PER_USER = 100;
export const LIBRARY_CHARACTER_NAME_MAX = 80;
export const LIBRARY_CHARACTER_DESCRIPTION_MAX = 2_000;
/**
 * Shared with the snapshot reader in core rather than restated: the same string
 * is capped here on the way in and again on the way out of
 * `mediaSettings.mobile.characters`, and a wider cap here would be silently
 * truncated there — mid-sentence, in the one field truncation is unsafe in.
 */
export const LIBRARY_CHARACTER_APPEARANCE_MAX = MAX_APPEARANCE_LENGTH;
export const LIBRARY_CHARACTER_FIELDS_MAX = 12;
/**
 * How many mention **entries** one write body may carry.
 *
 * **The library cap, and deliberately not the mention limit.** How many
 * characters a description may mention is `LIBRARY_MENTION_LIMIT` (10), and
 * that rule counts *distinct ids*: `mentionedTargets`
 * (`libraryMentionLinks.ts`) runs `uniqueIds` before it counts, so eleven
 * entries naming ten characters is a legal ten-character cast and is stored as
 * ten links. Neither `maxItems` nor `z.array().max()` can count distinct
 * anything, so a door held to the mention limit refuses that set — a body the
 * write would have accepted, turned down for repeating an id nothing forbids
 * the app from sending twice.
 *
 * **And it refuses it in the wrong sentence.** Both routes answer any failed
 * parse with one line about the field most bodies get wrong — "Give the
 * character a name." on POST, "Send at least one change." on PATCH — and
 * `character_editor_sheet.dart` snackbars `error.message` verbatim. Held here,
 * an over-cap list reaches the reader as a complaint about a name that is
 * perfectly fine; reaching the write it is "A description can mention up to 10
 * characters.", which names the field and the number they need. The door was
 * tightened to the mention limit for a while, and that is what it cost.
 *
 * What is left for the door is the *size* of the request, and the library cap
 * is the honest ceiling for it: no list can name more targets than the account
 * holds. The rule itself keeps one spelling, in the write, and the price of
 * that is named rather than hidden — an over-cap list of distinct ids is
 * refused from inside the transaction, on POST after the row has been created
 * and rolled back. The door could only pre-empt it by carrying a second copy of
 * that sentence, which is the drift every other bound in this file is written
 * to avoid.
 */
export const LIBRARY_CHARACTER_MENTION_ENTRIES_MAX = LIBRARY_CHARACTER_LIMIT_PER_USER;
/**
 * The two halves of one optional profile row — "Age" / "9". Named for the same
 * reason every other bound here is: they are spelled on both sides of the door,
 * and the JSON-schema side is the half that runs first.
 */
export const LIBRARY_CHARACTER_FIELD_KEY_MAX = 40;
export const LIBRARY_CHARACTER_FIELD_VALUE_MAX = 300;
/**
 * The ceiling `LibraryMention.otherType` carries as a column and again inside
 * `LibraryMention_target_arc`. Named here so the day an OTHER write body lands
 * it picks the number up rather than becoming its third spelling.
 */
export const LIBRARY_MENTION_OTHER_TYPE_MAX = 80;
/**
 * How long an id inside one reader's library may be.
 *
 * **Not a column, unlike the bound above it.** `LibraryCharacter.id` and
 * `LibraryMention.targetId` are both unbounded `TEXT`, so nothing under this
 * refuses a longer one and no migration can move the number — it is a door
 * bound, sized well past the 25 characters `@default(cuid())` writes, and the
 * same one the opaque ids on the picture routes carry. Which is exactly why it
 * has to be named: a bound with no floor beneath it drifts silently.
 */
export const LIBRARY_TARGET_ID_MAX = 64;

/** An id inside one reader's library — a character today, a place or an item later. */
const libraryTargetIdSchema = z.string().trim().min(1).max(LIBRARY_TARGET_ID_MAX);

/**
 * What the character looks like, in words. Empty clears it — and clearing is a
 * real choice rather than a no-op, because an absent appearance is what tells
 * every model downstream to describe nothing and defer to the reference image.
 */
const appearanceSchema = z.string().trim().max(LIBRARY_CHARACTER_APPEARANCE_MAX);

export const libraryCharacterFieldSchema = z
  .object({
    key: z.string().trim().min(1).max(LIBRARY_CHARACTER_FIELD_KEY_MAX),
    value: z.string().trim().min(1).max(LIBRARY_CHARACTER_FIELD_VALUE_MAX)
  })
  .strict();

export const mobileCharacterCreateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(LIBRARY_CHARACTER_NAME_MAX),
    description: z.string().trim().max(LIBRARY_CHARACTER_DESCRIPTION_MAX).default(""),
    appearance: appearanceSchema.default(""),
    fields: z.array(libraryCharacterFieldSchema).max(LIBRARY_CHARACTER_FIELDS_MAX).default([]),
    mentionedCharacterIds: z.array(libraryTargetIdSchema).max(LIBRARY_CHARACTER_MENTION_ENTRIES_MAX).default([])
  })
  .strict();

export const mobileCharacterUpdateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(LIBRARY_CHARACTER_NAME_MAX).optional(),
    description: z.string().trim().max(LIBRARY_CHARACTER_DESCRIPTION_MAX).optional(),
    appearance: appearanceSchema.optional(),
    fields: z.array(libraryCharacterFieldSchema).max(LIBRARY_CHARACTER_FIELDS_MAX).optional(),
    mentionedCharacterIds: z.array(libraryTargetIdSchema).max(LIBRARY_CHARACTER_MENTION_ENTRIES_MAX).optional(),
    /**
     * Turns down the description read off the photo. It is a change on its own
     * — a user who dismisses a suggestion and edits nothing else must not get
     * "send at least one field".
     */
    dismissSuggestion: z.boolean().optional()
  })
  .strict()
  .refine(
    (body) =>
      body.name !== undefined ||
      body.description !== undefined ||
      body.appearance !== undefined ||
      body.fields !== undefined ||
      body.mentionedCharacterIds !== undefined ||
      body.dismissSuggestion !== undefined,
    { message: "Send at least one field to update." }
  );

export const mobileCharacterPortraitBodySchema = z
  .object({
    requestId: requestIdSchema.optional()
  })
  .strict();

export const characterPhotoQuerySchema = z.object({
  filename: z.string().trim().min(1).max(300),
  mimeType: z.string().trim().max(160).optional()
});

/**
 * The path of a retained picture. Both ids are opaque to the client — the
 * filename is never one of them, and the lookup adds the owner as a third
 * predicate, so neither id can reach another user's file.
 */
export const characterImageParamsSchema = z.object({
  id: z.string().trim().min(1).max(64),
  imageId: z.string().trim().min(1).max(64)
});

/**
 * The subtype an OTHER mention carries — "sword", "guild", whatever the reader
 * typed the thing was.
 *
 * The rule is already written down twice below this: the column is
 * `VarChar(80)` and `LibraryMention_target_arc` demands a `btrim`-stable string
 * of 1..80 characters (`packages/db/prisma/migrations/000058_library_mentions`).
 * Neither can answer a reader. A CHECK arrives as SQLSTATE `23514` and the
 * column as `22001`; the first reaches `sendCharacterWriteError`'s
 * `namesMentionCheckConstraint` rung and comes back as a 400 that names nothing
 * the reader can act on, having already claimed rows and rolled the whole
 * character save back, and the second is not on that ladder at all. The bound
 * belongs where `name` and `description` are bounded — at the door — and these
 * two are the floor under it.
 */
export const libraryMentionOtherTypeSchema = z.string().trim().min(1).max(LIBRARY_MENTION_OTHER_TYPE_MAX);

/**
 * `LibraryMention_target_arc`, said in TypeScript — one arm per kind of the
 * table, keyed by the kind so the compiler owns the list.
 *
 * The kind is not a label beside the target, it is what decides the shape of
 * the other two columns. CHARACTER is the only kind with a library table to
 * point at, so it is the only one that fills `targetCharacterId` — and it fills
 * it with its own `targetId`, which is what makes that FK's cascade the arc's
 * enforcement for that kind. LOCATION and OTHER have no table yet, so their
 * identity lives in `targetId` alone and their character column must be null or
 * the cascade would delete rows about a place; OTHER additionally names what
 * the thing is.
 *
 * A discriminated union rather than three nullable fields and a refinement,
 * because that is the one spelling in which the LOCATION library landing cannot
 * leave an OTHER-shaped hole: a fourth kind has to be given an arm, and an arm
 * has to say what each column holds.
 *
 * **`satisfies Record<LibraryMentionTargetKind, …>` is what makes that last
 * sentence true rather than hoped for.** The type is generated from the `enum`
 * in `schema.prisma`, so the kind added there alongside its table stops this
 * file compiling — `Property 'X' is missing` — until it has an arm stating
 * which columns it fills. That is the anchor `JOB_STEP_TEMPLATES` is for job
 * types and `unnameableMentionKind` (`packages/db/src/libraryMentions.ts`) is
 * for the naming side, and it is the answer to the one real cost of
 * scaffolding no route reaches: an unreached schema has no call site to
 * disagree with it, so without this it would be edited blind beside the library
 * it is waiting for.
 *
 * **Exported for the anchor's two blind spots, both of which
 * `characterSchemas.test.ts` covers from here.** `packages/db/src/generated/`
 * is gitignored, so a kind added to `schema.prisma` before `pnpm db:generate`
 * runs is a kind the type does not have yet and the `satisfies` sleeps through
 * — the suite reads the `enum` block out of the schema file itself. And
 * `z.discriminatedUnion` takes a non-empty tuple rather than a record, so an
 * arm written here and left out of the union below is invisible to the
 * `satisfies` too — the suite compares `libraryMentionTargetSchema.options`
 * against these values by identity.
 */
export const libraryMentionTargetArms = {
  CHARACTER: z
    .object({
      targetKind: z.literal("CHARACTER"),
      targetId: libraryTargetIdSchema,
      targetCharacterId: libraryTargetIdSchema,
      otherType: z.null().default(null)
    })
    .strict()
    .refine((target) => target.targetCharacterId === target.targetId, {
      message: "A character mention's targetCharacterId is its targetId.",
      path: ["targetCharacterId"]
    }),
  LOCATION: z
    .object({
      targetKind: z.literal("LOCATION"),
      targetId: libraryTargetIdSchema,
      targetCharacterId: z.null().default(null),
      otherType: z.null().default(null)
    })
    .strict(),
  OTHER: z
    .object({
      targetKind: z.literal("OTHER"),
      targetId: libraryTargetIdSchema,
      targetCharacterId: z.null().default(null),
      otherType: libraryMentionOtherTypeSchema
    })
    .strict()
} satisfies Record<LibraryMentionTargetKind, z.ZodType>;

/**
 * The arc as one parser.
 *
 * **CHARACTER is the live kind; LOCATION and OTHER are groundwork for
 * libraries on the roadmap, and none of the three is dead code.** What is live
 * is the CHARACTER arm's *shape*: `replaceLibraryMentions`
 * (`libraryMentionLinks.ts`) builds every stored row to it and types its
 * `createMany` batch `LibraryMentionTargetOf<"CHARACTER">`, so the arc and the
 * only writer of it now move together or neither compiles. What is not live is
 * the *parsing*: `REPLACED_MENTION_KINDS` is `["CHARACTER"]`, no request body
 * carries a `targetKind` or an `otherType`, and no route calls this — which is
 * why the CHECK has never fired, and why reviews have filed this as unreachable
 * twice. It is written now because the alternative is writing it after the
 * first `23514` reaches a reader: the rule is a property of the table, and the
 * table already holds the two kinds it is about.
 *
 * **Going live is not this file's change, it is five landing together.** A
 * route that accepts a kind has to (1) put a `targetKind` in the write bodies'
 * Zod schemas and (2) in the JSON-schema twins beside them — the repo pairs one
 * with every documented body, and there is none here because there is no body
 * — (3) name the new kind in `REPLACED_MENTION_KINDS` so the write clears the
 * rows it inserts, (4) stop `replaceLibraryMentions` deriving
 * `targetCharacterId` from `targetId`, which is true of CHARACTER alone, and
 * (5) add the join that gives the new kind a name in `libraryMentionInclude`
 * (`packages/db/src/libraryMentions.ts`), or `generationDescription` goes on
 * stripping every marker in a description that holds one. Only step 3 has a
 * tripwire of its own — `libraryMentionLinks.test.ts` fails the moment a second
 * kind joins that list. Step 5 deliberately has none: `libraryMentionTargetName`
 * answers LOCATION and OTHER with `null` on purpose, so a join that never lands
 * is a marker nothing can name rather than a build failure. Until all five land
 * `characterSchemas.test.ts` is the only thing holding this shape still, which
 * is the last debt that change settles.
 */
export const libraryMentionTargetSchema = z.discriminatedUnion("targetKind", [
  libraryMentionTargetArms.CHARACTER,
  libraryMentionTargetArms.LOCATION,
  libraryMentionTargetArms.OTHER
]);

/** One mention target, as the arc allows it to be spelled. */
export type LibraryMentionTarget = z.infer<typeof libraryMentionTargetSchema>;

/**
 * The arc's answer for one kind — which columns a row of that kind may fill.
 *
 * **This is the call site the union otherwise has none of.**
 * `replaceLibraryMentions` types the rows it hands `createMany` with
 * `LibraryMentionTargetOf<typeof CHARACTER_MENTION_KIND>`, so the statement
 * that a character mention carries a `targetCharacterId` and a null `otherType`
 * is made once and checked in both directions: a change to which columns the
 * arm allows fails at the writer, and a writer that starts emitting a different
 * shape has to be argued here first. What the compiler cannot check is the
 * refinement — that the two ids are the *same* id — so
 * `libraryMentionLinks.test.ts` runs this parser over the batch the writer
 * emits, which is the only place a real row meets the arc today. It is the *shape*
 * that is shared and not the parse — nothing runs this schema over a row on the
 * way to the database, where the migration's CHECK is the enforcement.
 */
export type LibraryMentionTargetOf<Kind extends LibraryMentionTargetKind> = Extract<
  LibraryMentionTarget,
  { targetKind: Kind }
>;

/**
 * The documented spelling of a mention target, shared by both write bodies.
 *
 * These two routes declare a `body` and set `attachValidation: true`, so ajv's
 * rejection is attached to the request rather than thrown and the Zod schema
 * beside it is what answers: this fragment is the coercion ajv still applies to
 * everything it lets through, and the contract `/docs` publishes, rather than
 * the gate. The parity it asks for is unchanged and only its reason moved. A
 * bound spelled here and not in the Zod schema now refuses nothing at all,
 * because the parse that answers never learned about it; one spelled there and
 * not here is a refusal no client was told to expect. Either way the number has
 * to move on both sides at once.
 */
const libraryTargetIdOpenApi = {
  type: "string",
  minLength: 1,
  maxLength: LIBRARY_TARGET_ID_MAX
} as const;

const characterFieldOpenApi = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", minLength: 1, maxLength: LIBRARY_CHARACTER_FIELD_KEY_MAX },
    value: { type: "string", minLength: 1, maxLength: LIBRARY_CHARACTER_FIELD_VALUE_MAX }
  },
  required: ["key", "value"]
} as const;

export const mobileCharacterCreateOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: LIBRARY_CHARACTER_NAME_MAX },
    description: { type: "string", maxLength: LIBRARY_CHARACTER_DESCRIPTION_MAX },
    appearance: { type: "string", maxLength: LIBRARY_CHARACTER_APPEARANCE_MAX },
    fields: { type: "array", items: characterFieldOpenApi, maxItems: LIBRARY_CHARACTER_FIELDS_MAX },
    mentionedCharacterIds: {
      type: "array",
      items: libraryTargetIdOpenApi,
      maxItems: LIBRARY_CHARACTER_MENTION_ENTRIES_MAX
    }
  },
  required: ["name"]
} as const;

export const mobileCharacterUpdateOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: LIBRARY_CHARACTER_NAME_MAX },
    description: { type: "string", maxLength: LIBRARY_CHARACTER_DESCRIPTION_MAX },
    appearance: { type: "string", maxLength: LIBRARY_CHARACTER_APPEARANCE_MAX },
    fields: { type: "array", items: characterFieldOpenApi, maxItems: LIBRARY_CHARACTER_FIELDS_MAX },
    mentionedCharacterIds: {
      type: "array",
      items: libraryTargetIdOpenApi,
      maxItems: LIBRARY_CHARACTER_MENTION_ENTRIES_MAX
    },
    dismissSuggestion: { type: "boolean" }
  }
} as const;

export const mobileCharacterPortraitOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    requestId: { type: "string", minLength: REQUEST_ID_MIN_LENGTH, maxLength: REQUEST_ID_MAX_LENGTH }
  }
} as const;
