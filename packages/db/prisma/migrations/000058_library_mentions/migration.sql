-- Widen 000057's character-to-character mention edge into the typed
-- `LibraryMention` edge, in place, keeping every row that already exists.
--
-- 000057 shipped `LibraryCharacterMention`, keyed
-- ("sourceCharacterId", "targetCharacterId"). A mention may now point at a
-- LOCATION or an OTHER item, neither of which is a LibraryCharacter, so the
-- target identity moves to an untyped "targetId" column beside a
-- "targetKind" discriminator and the key follows it. Every pre-existing row
-- is a CHARACTER mention, which is why the new kind column can default and
-- "targetId" can be backfilled from the character id the row already carries.
--
-- CHARACTER is still the only kind with a target table, so its FK cascade is
-- the exclusive-arc for that kind; Location/Other FKs are added with those
-- tables. `otherType` is the user-typed subtype when OTHER, and it is
-- VARCHAR(80) rather than TEXT so the column carries the same ceiling the arc
-- CHECK below spells — a bound stated only inside a CHECK is one `schema.prisma`
-- cannot state at all, and the model is where the layers above look for it.
--
-- Postgres carries a renamed table's indexes and constraints under their old
-- names, so each one that survives is renamed explicitly to the name Prisma
-- derives from the model — that name is what `migrate diff` compares against.
-- One index does not survive; see the drop below.

CREATE TYPE "LibraryMentionTargetKind" AS ENUM ('CHARACTER', 'LOCATION', 'OTHER');

ALTER TABLE "LibraryCharacterMention" RENAME TO "LibraryMention";

-- The old key names a column that is about to become nullable, and the old
-- CHECK compares against it; both are replaced below in terms of "targetId".
ALTER TABLE "LibraryMention" DROP CONSTRAINT "LibraryCharacterMention_pkey";
ALTER TABLE "LibraryMention" DROP CONSTRAINT "LibraryCharacterMention_not_self";

ALTER TABLE "LibraryMention"
  ADD COLUMN "targetKind" "LibraryMentionTargetKind" NOT NULL DEFAULT 'CHARACTER',
  ADD COLUMN "targetId" TEXT,
  ADD COLUMN "otherType" VARCHAR(80);

-- Every row that exists is a character mention, so its target identity is the
-- character id it is already keyed on.
UPDATE "LibraryMention" SET "targetId" = "targetCharacterId" WHERE "targetId" IS NULL;

ALTER TABLE "LibraryMention" ALTER COLUMN "targetId" SET NOT NULL;

-- "targetCharacterId" is now the CHARACTER arm's foreign key rather than the
-- identity, so it is null for the other two kinds.
ALTER TABLE "LibraryMention" ALTER COLUMN "targetCharacterId" DROP NOT NULL;

ALTER TABLE "LibraryMention"
  ADD CONSTRAINT "LibraryMention_pkey"
  PRIMARY KEY ("sourceCharacterId", "targetKind", "targetId");

-- Self-mention is a CHARACTER-kind rule, and the kind test is what keeps it
-- one. "targetId" is only an id from "sourceCharacterId"'s own key space when
-- the target is a character; unscoped, this would compare a character id
-- against a Location/Other id and refuse a row whose two ids merely happen to
-- collide — a copy-on-save, a seeded fixture, one cuid reused as both. Under
-- CHARACTER the arc below pins "targetCharacterId" = "targetId", so this
-- asserts exactly what 000057's check did.
ALTER TABLE "LibraryMention"
  ADD CONSTRAINT "LibraryMention_not_self"
  CHECK ("targetKind" <> 'CHARACTER' OR "sourceCharacterId" <> "targetId");

ALTER TABLE "LibraryMention"
  ADD CONSTRAINT "LibraryMention_target_arc" CHECK (
    (
      "targetKind" = 'CHARACTER'
      AND "targetCharacterId" = "targetId"
      AND "otherType" IS NULL
    ) OR (
      "targetKind" = 'LOCATION'
      AND "targetCharacterId" IS NULL
      AND "otherType" IS NULL
    ) OR (
      "targetKind" = 'OTHER'
      AND "targetCharacterId" IS NULL
      AND "otherType" IS NOT NULL
      AND "otherType" = btrim("otherType")
      -- The upper half of this range is also the column's own type, so a long
      -- subtype is refused as `22001` before the CHECK is ever evaluated. It is
      -- restated here anyway because this constraint is the whole rule written
      -- down in one place, and because a later widening of the column must not
      -- silently widen what an OTHER row may hold. The half that is only ever
      -- enforced here is the trim and the `>= 1`.
      AND char_length("otherType") BETWEEN 1 AND 80
    )
  );

-- 000057's ("sourceCharacterId", "sortOrder") index goes with the read order
-- that named it, rather than being carried across under a new name. It was
-- written for `ORDER BY "sortOrder"` under an equality on "sourceCharacterId";
-- the read is now ORDER BY "targetKind", "sortOrder", "targetId"
-- (`libraryMentionOrder`, packages/db/src/libraryMentions.ts), whose leading
-- key this index does not carry at all — so it cannot produce the ordering,
-- and what is left of it is a lookup the new primary key already does.
-- Measured over 500k synthetic rows: with the index dropped the nested read
-- keeps its plan shape and its 13 buffers, bitmap-scanning
-- "LibraryMention_pkey" instead, and the kind-filtered delete below improves —
-- the pkey takes "targetKind" into its Index Cond where this index left it a
-- heap filter.
--
-- Nothing replaces it, because at this row count no index can beat the sort. A
-- source holds at most LIBRARY_MENTION_LIMIT (10) rows per kind, and with
-- ("sourceCharacterId", "targetKind", "sortOrder", "targetId") present Postgres
-- still plans bitmap-scan-then-quicksort at cost 43.41, taking 44.56 when
-- forced onto the ordered index scan that would remove the sort.
DROP INDEX "LibraryCharacterMention_sourceCharacterId_sortOrder_idx";

ALTER INDEX "LibraryCharacterMention_targetCharacterId_idx"
  RENAME TO "LibraryMention_targetCharacterId_idx";

-- There is deliberately no index on ("targetKind", "targetId") either: nothing
-- reads this table by target kind. Every read enters by "sourceCharacterId" —
-- the primary key's leading column, which also serves the kind-filtered delete
-- in `replaceLibraryMentions` — or by "targetCharacterId" through the index
-- renamed above. That delete and the insert beside it run on every character
-- create and every description-carrying PATCH, so a B-tree no query reaches is
-- write cost and nothing else — which is the same argument the drop above
-- answers to. Create one with the Location/Other read that needs it.

ALTER TABLE "LibraryMention"
  RENAME CONSTRAINT "LibraryCharacterMention_sourceCharacterId_fkey"
  TO "LibraryMention_sourceCharacterId_fkey";

ALTER TABLE "LibraryMention"
  RENAME CONSTRAINT "LibraryCharacterMention_targetCharacterId_fkey"
  TO "LibraryMention_targetCharacterId_fkey";
